/**
 * StdinBuffer buffers input and emits complete sequences.
 *
 * This is necessary because stdin data events can arrive in partial chunks,
 * especially for escape sequences like mouse events. Without buffering,
 * partial sequences can be misinterpreted as regular keypresses.
 *
 * For example, the mouse SGR sequence `\x1b[<35;20;5m` might arrive as:
 * - Event 1: `\x1b`
 * - Event 2: `[<35`
 * - Event 3: `;20;5m`
 *
 * The buffer accumulates these until a complete sequence is detected.
 * Call the `process()` method to feed input data.
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */
/**
 * stdin 事件可能在任意字节边界拆分终端序列；该缓冲器累积片段，确认序列完整后才派发，避免把半截 CSI 或鼠标事件误当普通按键。
 */

import { EventEmitter } from "events";

const ESC = "\x1b";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * Check if a string is a complete escape sequence or needs more data
 */
/** 判断字符串是完整转义序列、仍需更多数据，还是普通非转义输入。 */
function isCompleteSequence(data: string): "complete" | "incomplete" | "not-escape" {
	if (!data.startsWith(ESC)) {
		return "not-escape";
	}

	if (data.length === 1) {
		return "incomplete";
	}

	const afterEsc = data.slice(1);

	// CSI sequences: ESC [
	// CSI 以 ESC [ 开始，结束条件由最终字节决定。
	if (afterEsc.startsWith("[")) {
		// Check for old-style mouse sequence: ESC[M + 3 bytes
		// 旧式 X10 鼠标序列固定为 ESC[M 后跟三个字节。
		if (afterEsc.startsWith("[M")) {
			// Old-style mouse needs ESC[M + 3 bytes = 6 total
			// 因此总长度达到六个字节才算完整。
			return data.length >= 6 ? "complete" : "incomplete";
		}
		return isCompleteCsiSequence(data);
	}

	// OSC sequences: ESC ]
	// OSC 使用 ESC ] 开始，并由 BEL 或 ST 终止。
	if (afterEsc.startsWith("]")) {
		return isCompleteOscSequence(data);
	}

	// DCS sequences: ESC P ... ESC \ (includes XTVersion responses)
	// DCS 以 ESC P 开始，例如 XTVersion 响应，并等待 ST 终止。
	if (afterEsc.startsWith("P")) {
		return isCompleteDcsSequence(data);
	}

	// APC sequences: ESC _ ... ESC \ (includes Kitty graphics responses)
	// APC 以 ESC _ 开始，Kitty 图形协议响应属于此类。
	if (afterEsc.startsWith("_")) {
		return isCompleteApcSequence(data);
	}

	// SS3 sequences: ESC O
	// SS3 常用于功能键和方向键的传统编码。
	if (afterEsc.startsWith("O")) {
		// ESC O followed by a single character
		// ESC O 后再收到一个字符即构成完整 SS3 序列。
		return afterEsc.length >= 2 ? "complete" : "incomplete";
	}

	// Meta key sequences: ESC followed by a single character
	// Meta/Alt 传统编码通常是 ESC 后跟一个字符。
	if (afterEsc.length === 1) {
		return "complete";
	}

	// Unknown escape sequence - treat as complete
	// 未知但已有后续内容的 ESC 序列按完整处理，避免缓冲永久阻塞。
	return "complete";
}

/**
 * Check if CSI sequence is complete
 * CSI sequences: ESC [ ... followed by a final byte (0x40-0x7E)
 */
/** 按最终字节范围判断 CSI 是否完整，并对 SGR 鼠标格式做更严格校验。 */
function isCompleteCsiSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}[`)) {
		return "complete";
	}

	// Need at least ESC [ and one more character
	// 至少需要 ESC、`[` 和一个有效负载字符。
	if (data.length < 3) {
		return "incomplete";
	}

	const payload = data.slice(2);

	// CSI sequences end with a byte in the range 0x40-0x7E (@-~)
	// This includes all letters and several special characters
	// CSI 最终字节位于 0x40 到 0x7E，参数和中间字节不能提前结束序列。
	const lastChar = payload[payload.length - 1];
	const lastCharCode = lastChar.charCodeAt(0);

	if (lastCharCode >= 0x40 && lastCharCode <= 0x7e) {
		// Special handling for SGR mouse sequences
		// Format: ESC[<B;X;Ym or ESC[<B;X;YM
		// SGR 鼠标序列还必须满足按钮、列、行三个数字字段及 M/m 结尾。
		if (payload.startsWith("<")) {
			// Must have format: <digits;digits;digits[Mm]
			// 严格匹配 `<数字;数字;数字M/m` 的完整结构。
			const mouseMatch = /^<\d+;\d+;\d+[Mm]$/.test(payload);
			if (mouseMatch) {
				return "complete";
			}
			// If it ends with M or m but doesn't match the pattern, still incomplete
			// 即使已有 M/m，字段结构不完整时仍继续等待，避免派发残缺鼠标事件。
			if (lastChar === "M" || lastChar === "m") {
				// Check if we have the right structure
				// 再次按分隔字段验证，兼容等价的完整数字结构。
				const parts = payload.slice(1, -1).split(";");
				if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
					return "complete";
				}
			}

			return "incomplete";
		}

		return "complete";
	}

	return "incomplete";
}

/**
 * Check if OSC sequence is complete
 * OSC sequences: ESC ] ... ST (where ST is ESC \ or BEL)
 */
/** 判断 OSC 是否已收到 ST 或 BEL 终止符。 */
function isCompleteOscSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}]`)) {
		return "complete";
	}

	// OSC sequences end with ST (ESC \) or BEL (\x07)
	// OSC 同时兼容 ESC \ 与 BEL 两种终止方式。
	if (data.endsWith(`${ESC}\\`) || data.endsWith("\x07")) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if DCS (Device Control String) sequence is complete
 * DCS sequences: ESC P ... ST (where ST is ESC \)
 * Used for XTVersion responses like ESC P >| ... ESC \
 */
/** 判断 DCS 是否已收到 ESC \ 形式的 ST，常用于 XTVersion 等响应。 */
function isCompleteDcsSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}P`)) {
		return "complete";
	}

	// DCS sequences end with ST (ESC \)
	// DCS 仅在完整 ST 到达后派发。
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if APC (Application Program Command) sequence is complete
 * APC sequences: ESC _ ... ST (where ST is ESC \)
 * Used for Kitty graphics responses like ESC _ G ... ESC \
 */
/** 判断 APC 是否完整，Kitty 图形响应使用此类序列。 */
function isCompleteApcSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}_`)) {
		return "complete";
	}

	// APC sequences end with ST (ESC \)
	// APC 同样等待完整的 ESC \ 终止符。
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Split accumulated buffer into complete sequences
 */
/** 将累计缓冲拆分为完整终端序列，并保留末尾尚不完整的片段。 */
function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	if (!match) return undefined;

	const codepoint = parseInt(match[1]!, 10);
	return codepoint >= 32 ? codepoint : undefined;
}

function extractCompleteSequences(buffer: string): { sequences: string[]; remainder: string } {
	const sequences: string[] = [];
	let pos = 0;

	while (pos < buffer.length) {
		const remaining = buffer.slice(pos);

		// Try to extract a sequence starting at this position
		// 从当前位置尝试提取一个完整事件。
		if (remaining.startsWith(ESC)) {
			// Find the end of this escape sequence
			// 逐字符扩大候选范围，直到识别为完整序列或确认仍需等待。
			let seqEnd = 1;
			while (seqEnd <= remaining.length) {
				const candidate = remaining.slice(0, seqEnd);
				const status = isCompleteSequence(candidate);

				if (status === "complete") {
					// WezTerm with enable_kitty_keyboard sends the Escape key press as a
					// raw '\x1b' byte (simple text path in encode_kitty, ignoring
					// DISAMBIGUATE_ESCAPE_CODES) and the release as a full Kitty CSI-u
					// sequence. These arrive concatenated as '\x1b\x1b[27;...u'.
					// The buffer would normally treat '\x1b\x1b' as a complete meta-key
					// sequence (ESC + single char), leaving '[27;...u' to be typed as
					// plain text. If the character immediately following '\x1b\x1b'
					// would begin a new escape sequence, emit only the first ESC and
					// restart from the second.
					// WezTerm 可能把 Escape 按下和 Kitty 释放序列粘连；若第二个 ESC 后紧跟已知序列前缀，仅派发首个 ESC 并从第二个重新解析。
					if (candidate === "\x1b\x1b") {
						const nextChar = remaining[seqEnd];
						if (
							nextChar === "[" || // CSI
							nextChar === "]" || // OSC
							nextChar === "O" || // SS3
							nextChar === "P" || // DCS
							nextChar === "_" // APC
						) {
							sequences.push(ESC);
							pos += 1;
							break;
						}
					}
					sequences.push(candidate);
					pos += seqEnd;
					break;
				} else if (status === "incomplete") {
					seqEnd++;
				} else {
					// Should not happen when starting with ESC
					// 理论上 ESC 起始不会得到 not-escape；防御性地按当前候选派发以推进缓冲。
					sequences.push(candidate);
					pos += seqEnd;
					break;
				}
			}

			if (seqEnd > remaining.length) {
				return { sequences, remainder: remaining };
			}
		} else {
			// Not an escape sequence - take a single character
			// 非转义输入按单个 JavaScript 字符派发。
			sequences.push(remaining[0]!);
			pos++;
		}
	}

	return { sequences, remainder: "" };
}

export type StdinBufferOptions = {
	/**
	 * Maximum time to wait for sequence completion (default: 10ms)
	 * After this time, the buffer is flushed even if incomplete
	 */
	/** 等待序列补全的最长时间；超时后即使不完整也会刷新，避免孤立 ESC 等输入被无限延迟。 */
	timeout?: number;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

/**
 * Buffers stdin input and emits complete sequences via the 'data' event.
 * Handles partial escape sequences that arrive across multiple chunks.
 */
/** 缓冲 stdin 分片并通过 data 事件派发完整序列，同时单独处理 bracketed paste。 */
export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	private buffer: string = "";
	private timeout: ReturnType<typeof setTimeout> | null = null;
	private readonly timeoutMs: number;
	private pasteMode: boolean = false;
	private pasteBuffer: string = "";
	private pendingKittyPrintableCodepoint: number | undefined;

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.timeoutMs = options.timeout ?? 10;
	}

	public process(data: string | Buffer): void {
		// Clear any pending timeout
		// 新数据到达后取消旧刷新定时器，重新评估整个缓冲是否已完整。
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		// Handle high-byte conversion (for compatibility with parseKeypress)
		// If buffer has single byte > 127, convert to ESC + (byte - 128)
		// 为兼容传统 parseKeypress 约定，单个高位字节还原为 ESC 前缀的 Meta 键形式。
		let str: string;
		if (Buffer.isBuffer(data)) {
			if (data.length === 1 && data[0]! > 127) {
				const byte = data[0]! - 128;
				str = `\x1b${String.fromCharCode(byte)}`;
			} else {
				str = data.toString();
			}
		} else {
			str = data;
		}

		if (str.length === 0 && this.buffer.length === 0) {
			this.emitDataSequence("");
			return;
		}

		this.buffer += str;

		if (this.pasteMode) {
			// 粘贴模式下所有内容均按原文积累，不解析其中可能形似控制序列的文本。
			this.pasteBuffer += this.buffer;
			this.buffer = "";

			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				// 找到结束标记后一次性派发粘贴正文，并递归处理同一分片中的后续按键。
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.pasteMode = false;
				this.pasteBuffer = "";
				this.pendingKittyPrintableCodepoint = undefined;

				this.emit("paste", pastedContent);

				if (remaining.length > 0) {
					this.process(remaining);
				}
			}
			return;
		}

		const startIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
		if (startIndex !== -1) {
			// 起始标记之前可能已有完整按键序列，先解析并派发这些前缀内容。
			if (startIndex > 0) {
				const beforePaste = this.buffer.slice(0, startIndex);
				const result = extractCompleteSequences(beforePaste);
				for (const sequence of result.sequences) {
					this.emitDataSequence(sequence);
				}
			}

			this.pendingKittyPrintableCodepoint = undefined;
			// 进入粘贴模式时清除 Kitty 可打印键去重状态，避免跨协议边界误丢字符。
			this.buffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			this.pasteMode = true;
			this.pasteBuffer = this.buffer;
			this.buffer = "";

			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				// 起止标记可能在同一 stdin 分片中，直接完成粘贴并继续处理剩余内容。
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.pasteMode = false;
				this.pasteBuffer = "";
				this.pendingKittyPrintableCodepoint = undefined;

				this.emit("paste", pastedContent);

				if (remaining.length > 0) {
					this.process(remaining);
				}
			}
			return;
		}

		const result = extractCompleteSequences(this.buffer);
		// 普通模式下仅派发已确认完整的序列，末尾残片继续留在 buffer。
		this.buffer = result.remainder;

		for (const sequence of result.sequences) {
			this.emitDataSequence(sequence);
		}

		if (this.buffer.length > 0) {
			// 残片在短暂等待后强制刷新，使单独 Escape 或未知序列仍能及时响应。
			this.timeout = setTimeout(() => {
				const flushed = this.flush();

				for (const sequence of flushed) {
					this.emitDataSequence(sequence);
				}
			}, this.timeoutMs);
		}
	}

	private emitDataSequence(sequence: string): void {
		// 某些 Kitty 终端会同时发送 CSI-u 可打印键和对应原始字符；记录键码以抑制紧随其后的重复原始字符。
		const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
		if (rawCodepoint !== undefined && rawCodepoint === this.pendingKittyPrintableCodepoint) {
			this.pendingKittyPrintableCodepoint = undefined;
			return;
		}

		this.pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		this.emit("data", sequence);
	}

	flush(): string[] {
		// 显式刷新取消定时器，并把当前残片作为单个序列交给上层自行解释。
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		if (this.buffer.length === 0) {
			return [];
		}

		const sequences = [this.buffer];
		this.buffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
		return sequences;
	}

	clear(): void {
		// 清理全部普通、粘贴和 Kitty 去重状态，使实例可安全复用或销毁。
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		this.buffer = "";
		this.pasteMode = false;
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
	}

	getBuffer(): string {
		return this.buffer;
	}

	destroy(): void {
		this.clear();
	}
}
