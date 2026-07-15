import { getKeybindings } from "../keybindings.ts";
import { decodeKittyPrintable } from "../keys.ts";
import { KillRing } from "../kill-ring.ts";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui.ts";
import { UndoStack } from "../undo-stack.ts";
import { getGraphemeSegmenter, isWhitespaceChar, sliceByColumn, visibleWidth } from "../utils.ts";
import { findWordBackward, findWordForward } from "../word-navigation.ts";

const segmenter = getGraphemeSegmenter();

interface InputState {
	value: string;
	cursor: number;
}

/**
 * Input component - single-line text input with horizontal scrolling
 */
/** 支持水平滚动、字素级编辑和硬件光标定位的单行输入组件。 */
export class Input implements Component, Focusable {
	private value: string = "";
	private cursor: number = 0; // Cursor position in the value
	// 光标保存 UTF-16 字符串索引，移动和删除时通过字素分段避免拆分组合字符。
	public onSubmit?: (value: string) => void;
	public onEscape?: () => void;

	/** Focusable interface - set by TUI when focus changes */
	/** Focusable 接口字段，由 TUI 在焦点变化时设置。 */
	focused: boolean = false;

	// Bracketed paste mode buffering
	// bracketed paste 可能跨多次输入事件到达，因此持续缓冲至结束标记。
	private pasteBuffer: string = "";
	private isInPaste: boolean = false;

	// Kill ring for Emacs-style kill/yank operations
	// kill ring 支持 Emacs 风格的连续删除、yank 和 yank-pop。
	private killRing = new KillRing();
	private lastAction: "kill" | "yank" | "type-word" | null = null;

	// Undo support
	// 撤销栈保存文本与光标的完整快照。
	private undoStack = new UndoStack<InputState>();

	getValue(): string {
		return this.value;
	}

	setValue(value: string): void {
		this.value = value;
		this.cursor = Math.min(this.cursor, value.length);
	}

	handleInput(data: string): void {
		// Handle bracketed paste mode
		// Start of paste: \x1b[200~
		// End of paste: \x1b[201~
		// bracketed paste 起止标记用于区分粘贴正文与普通按键序列。

		// Check if we're starting a bracketed paste
		// 检测起始标记后进入跨事件缓冲状态。
		if (data.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}

		// If we're in a paste, buffer the data
		// 粘贴期间不按快捷键解析正文，只查找结束标记。
		if (this.isInPaste) {
			// Check if this chunk contains the end marker
			// 当前分片可能同时包含粘贴尾部和后续普通输入。
			this.pasteBuffer += data;

			const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
			if (endIndex !== -1) {
				// Extract the pasted content
				// 提取结束标记之前的完整粘贴正文。
				const pasteContent = this.pasteBuffer.substring(0, endIndex);

				// Process the complete paste
				// 整段粘贴作为单个编辑操作处理。
				this.handlePaste(pasteContent);

				// Reset paste state
				// 处理完成后退出粘贴模式。
				this.isInPaste = false;

				// Handle any remaining input after the paste marker
				// 结束标记后的剩余字节递归交回常规输入处理。
				const remaining = this.pasteBuffer.substring(endIndex + 6); // 6 = length of \x1b[201~
				this.pasteBuffer = "";
				if (remaining) {
					this.handleInput(remaining);
				}
			}
			return;
		}

		const kb = getKeybindings();

		// Escape/Cancel
		// 取消键通过可配置键位触发上层 Escape 回调。
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.onEscape) this.onEscape();
			return;
		}

		// Undo
		// 撤销恢复最近一次编辑快照。
		if (kb.matches(data, "tui.editor.undo")) {
			this.undo();
			return;
		}

		// Submit
		// 提交键通过可配置键位匹配，同时兼容裸换行输入。
		if (kb.matches(data, "tui.input.submit") || data === "\n") {
			if (this.onSubmit) this.onSubmit(this.value);
			return;
		}

		// Deletion
		// 删除操作区分字素、单词和行首尾范围，并维护撤销与 kill ring。
		if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			this.handleBackspace();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteCharForward")) {
			this.handleForwardDelete();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteWordBackward")) {
			this.deleteWordBackwards();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteWordForward")) {
			this.deleteWordForward();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.deleteToLineStart();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			this.deleteToLineEnd();
			return;
		}

		// Kill ring actions
		// yank 插入最近删除内容，yank-pop 可轮换此前的 kill 项。
		if (kb.matches(data, "tui.editor.yank")) {
			this.yank();
			return;
		}
		if (kb.matches(data, "tui.editor.yankPop")) {
			this.yankPop();
			return;
		}

		// Cursor movement
		// 左右移动按完整字素推进，避免进入 emoji 或组合字符内部。
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.lastAction = null;
			if (this.cursor > 0) {
				const beforeCursor = this.value.slice(0, this.cursor);
				const graphemes = [...segmenter.segment(beforeCursor)];
				const lastGrapheme = graphemes[graphemes.length - 1];
				this.cursor -= lastGrapheme ? lastGrapheme.segment.length : 1;
			}
			return;
		}

		if (kb.matches(data, "tui.editor.cursorRight")) {
			this.lastAction = null;
			if (this.cursor < this.value.length) {
				const afterCursor = this.value.slice(this.cursor);
				const graphemes = [...segmenter.segment(afterCursor)];
				const firstGrapheme = graphemes[0];
				this.cursor += firstGrapheme ? firstGrapheme.segment.length : 1;
			}
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.lastAction = null;
			this.cursor = 0;
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.lastAction = null;
			this.cursor = this.value.length;
			return;
		}

		if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			this.moveWordBackwards();
			return;
		}

		if (kb.matches(data, "tui.editor.cursorWordRight")) {
			this.moveWordForwards();
			return;
		}

		// Kitty CSI-u printable character (e.g. \x1b[97u for 'a').
		// Terminals with Kitty protocol flag 1 (disambiguate) send CSI-u for all keys,
		// including plain printable characters. Decode before the control-char check
		// since CSI-u sequences contain \x1b which would be rejected.
		// Kitty flag 1 会把普通可打印键编码为 CSI-u，必须在控制字符过滤前解码。
		const kittyPrintable = decodeKittyPrintable(data);
		if (kittyPrintable !== undefined) {
			this.insertCharacter(kittyPrintable);
			return;
		}

		// Regular character input - accept printable characters including Unicode,
		// but reject control characters (C0: 0x00-0x1F, DEL: 0x7F, C1: 0x80-0x9F)
		// 常规输入接受 Unicode 可打印字符，但拒绝 C0、DEL 和 C1 控制字符。
		const hasControlChars = [...data].some((ch) => {
			const code = ch.charCodeAt(0);
			return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		});
		if (!hasControlChars) {
			this.insertCharacter(data);
		}
	}

	private insertCharacter(char: string): void {
		// Undo coalescing: consecutive word chars coalesce into one undo unit
		// 连续单词字符合并为一个撤销单元；空白或动作切换会开启新快照。
		if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
			this.pushUndo();
		}
		this.lastAction = "type-word";

		this.value = this.value.slice(0, this.cursor) + char + this.value.slice(this.cursor);
		this.cursor += char.length;
	}

	private handleBackspace(): void {
		this.lastAction = null;
		if (this.cursor > 0) {
			this.pushUndo();
			const beforeCursor = this.value.slice(0, this.cursor);
			const graphemes = [...segmenter.segment(beforeCursor)];
			const lastGrapheme = graphemes[graphemes.length - 1];
			const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
			this.value = this.value.slice(0, this.cursor - graphemeLength) + this.value.slice(this.cursor);
			this.cursor -= graphemeLength;
		}
	}

	private handleForwardDelete(): void {
		this.lastAction = null;
		if (this.cursor < this.value.length) {
			this.pushUndo();
			const afterCursor = this.value.slice(this.cursor);
			const graphemes = [...segmenter.segment(afterCursor)];
			const firstGrapheme = graphemes[0];
			const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;
			this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + graphemeLength);
		}
	}

	private deleteToLineStart(): void {
		if (this.cursor === 0) return;
		this.pushUndo();
		const deletedText = this.value.slice(0, this.cursor);
		this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
		this.lastAction = "kill";
		this.value = this.value.slice(this.cursor);
		this.cursor = 0;
	}

	private deleteToLineEnd(): void {
		if (this.cursor >= this.value.length) return;
		this.pushUndo();
		const deletedText = this.value.slice(this.cursor);
		this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
		this.lastAction = "kill";
		this.value = this.value.slice(0, this.cursor);
	}

	private deleteWordBackwards(): void {
		if (this.cursor === 0) return;

		// Save lastAction before cursor movement (moveWordBackwards resets it)
		// 按词移动会重置 lastAction，先保存是否应与上一段 kill 合并。
		const wasKill = this.lastAction === "kill";

		this.pushUndo();

		const oldCursor = this.cursor;
		this.moveWordBackwards();
		const deleteFrom = this.cursor;
		this.cursor = oldCursor;

		const deletedText = this.value.slice(deleteFrom, this.cursor);
		this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
		this.lastAction = "kill";

		this.value = this.value.slice(0, deleteFrom) + this.value.slice(this.cursor);
		this.cursor = deleteFrom;
	}

	private deleteWordForward(): void {
		if (this.cursor >= this.value.length) return;

		// Save lastAction before cursor movement (moveWordForwards resets it)
		// 向前按词移动前同样保存连续 kill 状态。
		const wasKill = this.lastAction === "kill";

		this.pushUndo();

		const oldCursor = this.cursor;
		this.moveWordForwards();
		const deleteTo = this.cursor;
		this.cursor = oldCursor;

		const deletedText = this.value.slice(this.cursor, deleteTo);
		this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
		this.lastAction = "kill";

		this.value = this.value.slice(0, this.cursor) + this.value.slice(deleteTo);
	}

	private yank(): void {
		const text = this.killRing.peek();
		if (!text) return;

		this.pushUndo();

		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.lastAction = "yank";
	}

	private yankPop(): void {
		if (this.lastAction !== "yank" || this.killRing.length <= 1) return;

		this.pushUndo();

		// Delete the previously yanked text (still at end of ring before rotation)
		// 旋转前先按当前 ring 末项删除刚插入的 yank 文本。
		const prevText = this.killRing.peek() || "";
		this.value = this.value.slice(0, this.cursor - prevText.length) + this.value.slice(this.cursor);
		this.cursor -= prevText.length;

		// Rotate and insert new entry
		// 旋转 kill ring 后在同一位置插入新的最近项。
		this.killRing.rotate();
		const text = this.killRing.peek() || "";
		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.lastAction = "yank";
	}

	private pushUndo(): void {
		this.undoStack.push({ value: this.value, cursor: this.cursor });
	}

	private undo(): void {
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		this.value = snapshot.value;
		this.cursor = snapshot.cursor;
		this.lastAction = null;
	}

	private moveWordBackwards(): void {
		if (this.cursor === 0) return;
		this.lastAction = null;
		this.cursor = findWordBackward(this.value, this.cursor);
	}

	private moveWordForwards(): void {
		if (this.cursor >= this.value.length) return;
		this.lastAction = null;
		this.cursor = findWordForward(this.value, this.cursor);
	}

	private handlePaste(pastedText: string): void {
		this.lastAction = null;
		this.pushUndo();

		// Clean the pasted text - remove newlines and carriage returns
		// 单行输入移除粘贴中的换行，制表符展开为空格。
		const cleanText = pastedText.replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, "").replace(/\t/g, "    ");

		// Insert at cursor position
		// 整段清理后的文本一次插入光标位置。
		this.value = this.value.slice(0, this.cursor) + cleanText + this.value.slice(this.cursor);
		this.cursor += cleanText.length;
	}

	invalidate(): void {
		// No cached state to invalidate currently
		// 当前没有派生渲染缓存需要失效。
	}

	render(width: number): string[] {
		// Calculate visible window
		// 提示符占用固定列数，剩余宽度作为文本水平视口。
		const prompt = "> ";
		const availableWidth = width - prompt.length;

		if (availableWidth <= 0) {
			return [prompt];
		}

		let visibleText = "";
		let cursorDisplay = this.cursor;
		const totalWidth = visibleWidth(this.value);

		if (totalWidth < availableWidth) {
			// Everything fits (leave room for cursor at end)
			// 全文可见时不滚动，并保留行尾模拟光标所需空间。
			visibleText = this.value;
		} else {
			// Need horizontal scrolling
			// Reserve one column for cursor if it's at the end
			// 超宽时围绕光标滚动；光标位于全文末尾时额外预留一列显示空格光标。
			const scrollWidth = this.cursor === this.value.length ? availableWidth - 1 : availableWidth;
			const cursorCol = visibleWidth(this.value.slice(0, this.cursor));

			if (scrollWidth > 0) {
				const halfWidth = Math.floor(scrollWidth / 2);
				let startCol = 0;

				if (cursorCol < halfWidth) {
					// Cursor near start
					// 光标靠近开头时视口从零列开始。
					startCol = 0;
				} else if (cursorCol > totalWidth - halfWidth) {
					// Cursor near end
					// 光标靠近末尾时将视口贴齐文本末端。
					startCol = Math.max(0, totalWidth - scrollWidth);
				} else {
					// Cursor in middle
					// 光标居中时尽量在两侧保留等量上下文。
					startCol = Math.max(0, cursorCol - halfWidth);
				}

				visibleText = sliceByColumn(this.value, startCol, scrollWidth, true);
				const beforeCursor = sliceByColumn(this.value, startCol, Math.max(0, cursorCol - startCol), true);
				cursorDisplay = beforeCursor.length;
			} else {
				visibleText = "";
				cursorDisplay = 0;
			}
		}

		// Build line with fake cursor
		// Insert cursor character at cursor position
		// 在当前视口中用反色字素绘制模拟光标。
		const graphemes = [...segmenter.segment(visibleText.slice(cursorDisplay))];
		const cursorGrapheme = graphemes[0];

		const beforeCursor = visibleText.slice(0, cursorDisplay);
		const atCursor = cursorGrapheme?.segment ?? " "; // Character at cursor, or space if at end
		// 光标覆盖完整字素；位于行尾时使用空格作为可见光标单元。
		const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);

		// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
		// 聚焦时在模拟光标前输出零宽硬件光标标记，供 IME 候选窗定位。
		const marker = this.focused ? CURSOR_MARKER : "";

		// Use inverse video to show cursor
		// 反色视频仅包裹光标字素，并立即恢复正常显示。
		const cursorChar = `\x1b[7m${atCursor}\x1b[27m`; // ESC[7m = reverse video, ESC[27m = normal
		// ESC[7m 开启反色，ESC[27m 关闭反色。
		const textWithCursor = beforeCursor + marker + cursorChar + afterCursor;

		// Calculate visual width
		// 按终端可见宽度补齐单行，ANSI 和零宽光标标记不计入列数。
		const visualLength = visibleWidth(textWithCursor);
		const padding = " ".repeat(Math.max(0, availableWidth - visualLength));
		const line = prompt + textWithCursor + padding;

		return [line];
	}
}
