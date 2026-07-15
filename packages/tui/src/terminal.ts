import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setKittyProtocolActive } from "./keys.ts";
import { isNativeModifierPressed } from "./native-modifiers.ts";
import { StdinBuffer } from "./stdin-buffer.ts";

const cjsRequire = createRequire(import.meta.url);

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0;\x07";
const APPLE_TERMINAL_SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";
const DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = 7;
const KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS = 150;
const KITTY_KEYBOARD_PROTOCOL_QUERY = `\x1b[>${DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS}u\x1b[?u\x1b[c`;

export type KeyboardProtocolNegotiationSequence =
	| { type: "kitty-flags"; flags: number }
	| { type: "device-attributes" };

export function parseKeyboardProtocolNegotiationSequence(
	sequence: string,
): KeyboardProtocolNegotiationSequence | undefined {
	const kittyFlags = sequence.match(/^\x1b\[\?(\d+)u$/);
	if (kittyFlags) {
		return { type: "kitty-flags", flags: Number.parseInt(kittyFlags[1]!, 10) };
	}
	if (/^\x1b\[\?[\d;]*c$/.test(sequence)) {
		return { type: "device-attributes" };
	}
	return undefined;
}

function isKeyboardProtocolNegotiationSequencePrefix(sequence: string): boolean {
	return sequence === "\x1b[" || /^\x1b\[\?[\d;]*$/.test(sequence);
}

export function isAppleTerminalSession(): boolean {
	return process.platform === "darwin" && process.env.TERM_PROGRAM === "Apple_Terminal";
}

export function normalizeAppleTerminalInput(data: string, isAppleTerminal: boolean, isShiftPressed: boolean): string {
	if (isAppleTerminal && data === "\r" && isShiftPressed) return APPLE_TERMINAL_SHIFT_ENTER_SEQUENCE;
	return data;
}

/**
 * Minimal terminal interface for TUI
 */
/** TUI 依赖的最小终端抽象，隔离输入、尺寸、光标和控制序列操作。 */
export interface Terminal {
	// Start the terminal with input and resize handlers
	// 启动终端输入和尺寸变化监听。
	start(onInput: (data: string) => void, onResize: () => void): void;

	// Stop the terminal and restore state
	// 停止监听并恢复启动前的终端状态。
	stop(): void;

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	/** 退出前短暂排空 stdin，避免慢速 SSH 上迟到的 Kitty 释放事件泄漏到父 shell。 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	// Write output to terminal
	// 向终端写入原始输出。
	write(data: string): void;

	// Get terminal dimensions
	// 获取当前终端列数和行数。
	get columns(): number;
	get rows(): number;

	// Whether Kitty keyboard protocol is active
	// 当前是否已协商启用 Kitty 键盘协议。
	get kittyProtocolActive(): boolean;

	// Cursor positioning (relative to current position)
	// 相对当前位置移动光标。
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	// Cursor visibility
	// 控制硬件光标可见性。
	hideCursor(): void; // Hide the cursor
	showCursor(): void; // Show the cursor

	// Clear operations
	// 清除当前行、光标后区域或整个屏幕。
	clearLine(): void; // Clear current line
	clearFromCursor(): void; // Clear from cursor to end of screen
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	// Title operations
	// 设置终端窗口标题。
	setTitle(title: string): void; // Set terminal window title

	// Progress indicator (OSC 9;4)
	// 使用 OSC 9;4 控制终端级进度指示。
	setProgress(active: boolean): void;
}

/**
 * Real terminal using process.stdin/stdout
 */
/** 基于 process.stdin/stdout 的真实终端实现。 */
export class ProcessTerminal implements Terminal {
	private wasRaw = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _kittyProtocolActive = false;
	private _modifyOtherKeysActive = false;
	private keyboardProtocolPushed = false;
	private keyboardProtocolNegotiationBuffer = "";
	private keyboardProtocolBufferFlushTimer?: ReturnType<typeof setTimeout>;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;
	private progressInterval?: ReturnType<typeof setInterval>;
	private writeLogPath = (() => {
		const env = process.env.PI_TUI_WRITE_LOG || "";
		if (!env) return "";
		try {
			if (fs.statSync(env).isDirectory()) {
				const now = new Date();
				const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
				return path.join(env, `tui-${ts}-${process.pid}.log`);
			}
		} catch {
			// Not an existing directory - use as-is (file path)
			// 不是现有目录时，将环境变量原值视为日志文件路径。
		}
		return env;
	})();

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	get modifyOtherKeysActive(): boolean {
		return this._modifyOtherKeysActive;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;

		// Save previous state and enable raw mode
		// 保存原始 raw mode 状态后启用 raw mode，使应用直接接收按键字节而非行缓冲输入。
		this.wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		// 启用 bracketed paste，终端会用起止序列包裹粘贴内容，便于与逐键输入区分。
		process.stdout.write("\x1b[?2004h");

		// Set up resize handler immediately
		// 尽早注册 resize 监听，避免初始化期间遗漏尺寸变化。
		process.stdout.on("resize", this.resizeHandler);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only.
		// Unix 进程挂起期间可能丢失 SIGWINCH，恢复后主动触发一次以刷新尺寸。
		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run AFTER setRawMode(true)
		// since that resets console mode flags.
		// Windows raw mode 会重置控制台标志，因此必须在其后重新启用 VT 输入以保留修饰键编码。
		this.enableWindowsVTInput();

		// Query Kitty keyboard protocol and fall back to modifyOtherKeys when DA confirms no Kitty response.
		// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		// 协商 Kitty 协议；若设备属性响应先确认终端不支持，则回退到 modifyOtherKeys。
		this.queryAndEnableKittyProtocol();
	}

	/**
	 * Set up StdinBuffer to split batched input into individual sequences.
	 * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
	 *
	 * Also watches for Kitty protocol response and enables it when detected.
	 * This is done here (after stdinBuffer parsing) rather than on raw stdin
	 * to handle the case where the response arrives split across multiple events.
	 */
	/**
	 * 使用 StdinBuffer 将一次读取中的批量数据拆成独立序列，并在分段完成后识别 Kitty 协商响应。
	 * 这样按键匹配不会接收到粘连事件，也能处理跨多次 stdin 事件到达的协议响应。
	 */
	private setupStdinBuffer(): void {
		this.stdinBuffer = new StdinBuffer({ timeout: 10 });

		// Forward individual sequences to the input handler
		// 每个完整序列先经过协议协商识别，普通输入再转发给组件。
		this.stdinBuffer.on("data", (sequence) => {
			const negotiationSequence = this.readKeyboardProtocolNegotiationSequence(sequence);
			if (negotiationSequence === "pending") {
				this.scheduleKeyboardProtocolNegotiationBufferFlush();
				// 分片可能只是协议响应前缀，短暂等待其余字节。
				return; // Wait briefly for the rest of a split Kitty response.
			}
			if (this.handleKeyboardProtocolNegotiationSequence(negotiationSequence)) {
				return;
			}

			this.forwardInputSequence(sequence);
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		// StdinBuffer 已剥离粘贴边界，这里重新包裹以复用编辑器现有的 bracketed paste 处理。
		this.stdinBuffer.on("paste", (content) => {
			if (this.inputHandler) {
				this.inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		// 原始 stdin 数据统一交给缓冲器进行序列切分。
		this.stdinDataHandler = (data: string) => {
			this.stdinBuffer!.process(data);
		};
	}

	/**
	 * Query terminal for Kitty keyboard protocol support and enable it if available.
	 *
	 * Kitty's progressive enhancement detection requires requesting the desired
	 * flags before querying them. The trailing DA query is a sentinel supported by
	 * terminals that do not know Kitty keyboard protocol; receiving DA before a
	 * Kitty response enables modifyOtherKeys fallback without a startup timeout.
	 *
	 * The requested flags are:
	 * - 1 = disambiguate escape codes
	 * - 2 = report event types (press/repeat/release)
	 * - 4 = report alternate keys (shifted key, base layout key)
	 */
	/**
	 * 请求 Kitty 渐进增强标志并查询当前状态；尾随 DA 查询充当不支持 Kitty 的即时哨兵，从而无需等待启动超时。
	 */
	private queryAndEnableKittyProtocol(): void {
		this.setupStdinBuffer();
		process.stdin.on("data", this.stdinDataHandler!);
		this.keyboardProtocolPushed = true;
		this.clearKeyboardProtocolNegotiationBuffer();
		process.stdout.write(KITTY_KEYBOARD_PROTOCOL_QUERY);
	}

	private handleKeyboardProtocolNegotiationSequence(
		negotiationSequence: KeyboardProtocolNegotiationSequence | undefined,
	): boolean {
		if (!negotiationSequence) return false;
		this.clearKeyboardProtocolNegotiationBuffer();
		if (negotiationSequence.type === "kitty-flags") {
			if (negotiationSequence.flags !== 0) {
				this.disableModifyOtherKeys();
				if (!this._kittyProtocolActive) {
					this._kittyProtocolActive = true;
					setKittyProtocolActive(true);
				}
			} else {
				this.enableModifyOtherKeys();
			}
			return true;
		}

		if (!this._kittyProtocolActive) {
			this.enableModifyOtherKeys();
		}
		return true;
	}

	private readKeyboardProtocolNegotiationSequence(
		sequence: string,
	): KeyboardProtocolNegotiationSequence | "pending" | undefined {
		if (this.keyboardProtocolNegotiationBuffer) {
			const bufferedSequence = this.keyboardProtocolNegotiationBuffer + sequence;
			const negotiationSequence = parseKeyboardProtocolNegotiationSequence(bufferedSequence);
			if (negotiationSequence) {
				this.clearKeyboardProtocolNegotiationBuffer();
				return negotiationSequence;
			}
			if (isKeyboardProtocolNegotiationSequencePrefix(bufferedSequence)) {
				this.setKeyboardProtocolNegotiationBuffer(bufferedSequence);
				return "pending";
			}
			this.flushKeyboardProtocolNegotiationBufferAsInput();
		}

		const negotiationSequence = parseKeyboardProtocolNegotiationSequence(sequence);
		if (negotiationSequence) return negotiationSequence;
		if (isKeyboardProtocolNegotiationSequencePrefix(sequence)) {
			this.setKeyboardProtocolNegotiationBuffer(sequence);
			return "pending";
		}
		return undefined;
	}

	private setKeyboardProtocolNegotiationBuffer(sequence: string): void {
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		this.keyboardProtocolNegotiationBuffer = sequence;
	}

	private clearKeyboardProtocolNegotiationBuffer(): void {
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		this.keyboardProtocolNegotiationBuffer = "";
	}

	private flushKeyboardProtocolNegotiationBufferAsInput(): void {
		if (!this.keyboardProtocolNegotiationBuffer) return;
		const sequence = this.keyboardProtocolNegotiationBuffer;
		this.clearKeyboardProtocolNegotiationBuffer();
		this.forwardInputSequence(sequence);
	}

	private scheduleKeyboardProtocolNegotiationBufferFlush(): void {
		if (!this.keyboardProtocolNegotiationBuffer || this.keyboardProtocolBufferFlushTimer) return;
		this.keyboardProtocolBufferFlushTimer = setTimeout(() => {
			this.keyboardProtocolBufferFlushTimer = undefined;
			this.flushKeyboardProtocolNegotiationBufferAsInput();
		}, KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS);
	}

	private clearKeyboardProtocolNegotiationBufferFlushTimer(): void {
		if (!this.keyboardProtocolBufferFlushTimer) return;
		clearTimeout(this.keyboardProtocolBufferFlushTimer);
		this.keyboardProtocolBufferFlushTimer = undefined;
	}

	private forwardInputSequence(sequence: string): void {
		if (!this.inputHandler) return;
		const isAppleTerminal = sequence === "\r" && isAppleTerminalSession();
		const input = normalizeAppleTerminalInput(
			sequence,
			isAppleTerminal,
			isAppleTerminal && isNativeModifierPressed("shift"),
		);
		this.inputHandler(input);
	}

	private enableModifyOtherKeys(): void {
		if (this._kittyProtocolActive || this._modifyOtherKeysActive) return;
		process.stdout.write("\x1b[>4;2m");
		this._modifyOtherKeysActive = true;
	}

	private disableModifyOtherKeys(): void {
		if (!this._modifyOtherKeysActive) return;
		process.stdout.write("\x1b[>4;0m");
		this._modifyOtherKeysActive = false;
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) to the stdin
	 * console handle so the terminal sends VT sequences for modified keys
	 * (e.g. \x1b[Z for Shift+Tab). Without this, libuv's ReadConsoleInputW
	 * discards modifier state and Shift+Tab arrives as plain \t.
	 */
	/** Windows 下启用 VT 输入，使修饰键以转义序列上报，避免 libuv 控制台读取丢失修饰状态。 */
	private enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		try {
			const arch = process.arch;
			if (arch !== "x64" && arch !== "arm64") return;

			// Dynamic require so non-Windows and bundled/browser paths never load the
			// native helper. In the npm package native/ is next to dist/; in compiled
			// binary archives native/ is copied next to the executable.
			// 动态加载原生辅助模块，并兼容 npm 包、源码布局和编译后二进制旁的多个打包位置。
			const moduleDir = path.dirname(fileURLToPath(import.meta.url));
			const nativePath = path.join("native", "win32", "prebuilds", `win32-${arch}`, "win32-console-mode.node");
			const candidates = [
				path.join(moduleDir, "..", nativePath),
				path.join(moduleDir, nativePath),
				path.join(path.dirname(process.execPath), nativePath),
			];
			for (const modulePath of candidates) {
				try {
					const helper = cjsRequire(modulePath) as { enableVirtualTerminalInput?: () => boolean };
					helper.enableVirtualTerminalInput?.();
					return;
				} catch {
					// Try the next possible packaging location.
					// 当前候选不存在或无法加载时继续尝试下一种打包位置。
				}
			}
		} catch {
			// Native helper not available — Shift+Tab won't be distinguishable from Tab.
			// 原生辅助模块不可用时降级运行，但 Shift+Tab 将无法与 Tab 区分。
		}
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
		this.clearKeyboardProtocolNegotiationBuffer();
		if (shouldDisableKittyProtocol) {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences.
			// 先关闭 Kitty 协议，防止排空期间迟到的释放事件继续生成新协议序列。
			process.stdout.write("\x1b[<u");
			this.keyboardProtocolPushed = false;
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		this.disableModifyOtherKeys();

		const previousHandler = this.inputHandler;
		this.inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.inputHandler = previousHandler;
		}
	}

	stop(): void {
		if (this.clearProgressInterval()) {
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}

		// Disable bracketed paste mode
		// 关闭 bracketed paste，避免后续 shell 粘贴仍被终端包裹。
		process.stdout.write("\x1b[?2004l");

		const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
		this.clearKeyboardProtocolNegotiationBuffer();

		// Disable Kitty keyboard protocol if not already done by drainInput()
		// 若 drainInput 尚未关闭 Kitty 协议，则在停止阶段恢复终端键盘协议栈。
		if (shouldDisableKittyProtocol) {
			process.stdout.write("\x1b[<u");
			this.keyboardProtocolPushed = false;
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		this.disableModifyOtherKeys();

		// Clean up StdinBuffer
		// 销毁输入缓冲器及其内部定时器和监听状态。
		if (this.stdinBuffer) {
			this.stdinBuffer.destroy();
			this.stdinBuffer = undefined;
		}

		// Remove event handlers
		// 移除 stdin 和 resize 监听，防止停止后继续回调已卸载的 TUI。
		if (this.stdinDataHandler) {
			process.stdin.removeListener("data", this.stdinDataHandler);
			this.stdinDataHandler = undefined;
		}
		this.inputHandler = undefined;
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		// 恢复 cooked mode 前暂停 stdin，避免缓冲中的 Ctrl+D 等输入在 SSH 上被父 shell 重新解释。
		process.stdin.pause();

		// Restore raw mode state
		// 精确恢复启动前的 raw mode 状态，而不是无条件关闭。
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
	}

	write(data: string): void {
		process.stdout.write(data);
		if (this.writeLogPath) {
			try {
				fs.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
			} catch {
				// Ignore logging errors
				// 调试日志失败不能影响终端正常输出。
			}
		}
	}

	get columns(): number {
		return process.stdout.columns || Number(process.env.COLUMNS) || 80;
	}

	get rows(): number {
		return process.stdout.rows || Number(process.env.LINES) || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			// 正值相对向下移动。
			process.stdout.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			// 负值相对向上移动。
			process.stdout.write(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
		// 零值不发送任何控制序列。
	}

	hideCursor(): void {
		process.stdout.write("\x1b[?25l");
	}

	showCursor(): void {
		process.stdout.write("\x1b[?25h");
	}

	clearLine(): void {
		process.stdout.write("\x1b[K");
	}

	clearFromCursor(): void {
		process.stdout.write("\x1b[J");
	}

	clearScreen(): void {
		process.stdout.write("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
		// 清屏后将光标移到终端左上角。
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		// OSC 0 通过 BEL 终止并设置终端窗口标题。
		process.stdout.write(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		if (active) {
			// OSC 9;4;3 - indeterminate progress
			// OSC 9;4;3 表示不确定进度，并定期续期以适配会自动清除状态的终端。
			process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.progressInterval) {
				this.progressInterval = setInterval(() => {
					process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
			}
		} else {
			this.clearProgressInterval();
			// OSC 9;4;0 - clear progress
			// OSC 9;4;0 清除终端级进度指示。
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	private clearProgressInterval(): boolean {
		if (!this.progressInterval) return false;
		clearInterval(this.progressInterval);
		this.progressInterval = undefined;
		return true;
	}
}
