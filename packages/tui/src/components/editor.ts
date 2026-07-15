import type { AutocompleteProvider, AutocompleteSuggestions } from "../autocomplete.ts";
import { getKeybindings } from "../keybindings.ts";
import { decodePrintableKey, matchesKey } from "../keys.ts";
import { KillRing } from "../kill-ring.ts";
import { type Component, CURSOR_MARKER, type Focusable, type TUI } from "../tui.ts";
import { UndoStack } from "../undo-stack.ts";
import {
	cjkBreakRegex,
	getGraphemeSegmenter,
	getWordSegmenter,
	isWhitespaceChar,
	truncateToWidth,
	visibleWidth,
} from "../utils.ts";
import { findWordBackward, findWordForward } from "../word-navigation.ts";
import { SelectList, type SelectListLayoutOptions, type SelectListTheme } from "./select-list.ts";

const graphemeSegmenter = getGraphemeSegmenter();
const wordSegmenter = getWordSegmenter();

/** Regex matching paste markers like `[paste #1 +123 lines]` or `[paste #2 1234 chars]`. */
/** 匹配形如 `[paste #1 +123 lines]` 或 `[paste #2 1234 chars]` 的粘贴占位标记。 */
const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;

/** Non-global version for single-segment testing. */
/** 非全局版本，用于判断单个分段是否完整匹配粘贴标记。 */
const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;

/** Check if a segment is a paste marker (i.e. was merged by segmentWithMarkers). */
/** 判断分段是否为已由 segmentWithMarkers 合并成原子单元的粘贴标记。 */
function isPasteMarker(segment: string): boolean {
	return segment.length >= 10 && PASTE_MARKER_SINGLE.test(segment);
}

/**
 * A segmenter that wraps Intl.Segmenter and merges graphemes that fall
 * within paste markers into single atomic segments.  This makes cursor
 * movement, deletion, word-wrap, etc. treat paste markers as single units.
 *
 * Only markers whose numeric ID exists in `validIds` are merged.
 */
/**
 * 在 Intl.Segmenter 的结果上合并粘贴标记覆盖的字素，使光标移动、删除和换行都把标记视为不可拆分的原子单元。
 * 仅合并数字 ID 存在于 `validIds` 中的标记，避免普通文本中形似标记的内容被误处理。
 */
function segmentWithMarkers(
	text: string,
	baseSegmenter: Intl.Segmenter,
	validIds: Set<number>,
): Iterable<Intl.SegmentData> {
	// Fast path: no paste markers in the text or no valid IDs.
	// 快速路径：文本不含候选标记或当前没有有效粘贴 ID 时，直接使用基础分段器。
	if (validIds.size === 0 || !text.includes("[paste #")) {
		return baseSegmenter.segment(text);
	}

	// Find all marker spans with valid IDs.
	// 收集有效标记在原文本中的区间，后续据此合并其内部字素。
	const markers: Array<{ start: number; end: number }> = [];
	for (const m of text.matchAll(PASTE_MARKER_REGEX)) {
		const id = Number.parseInt(m[1]!, 10);
		if (!validIds.has(id)) continue;
		markers.push({ start: m.index, end: m.index + m[0].length });
	}
	if (markers.length === 0) {
		return baseSegmenter.segment(text);
	}

	// Build merged segment list.
	// 构造合并后的分段列表，同时保留非标记文本的原始分段结果。
	const baseSegments = baseSegmenter.segment(text);
	const result: Intl.SegmentData[] = [];
	let markerIdx = 0;

	for (const seg of baseSegments) {
		// Skip past markers that are entirely before this segment.
		// 跳过已经完全位于当前分段之前的标记区间。
		while (markerIdx < markers.length && markers[markerIdx]!.end <= seg.index) {
			markerIdx++;
		}

		const marker = markerIdx < markers.length ? markers[markerIdx]! : null;

		if (marker && seg.index >= marker.start && seg.index < marker.end) {
			// This segment falls inside a marker.
			// If this is the first segment of the marker, emit a merged segment.
			// 当前分段落在标记内部；只在标记起点输出一次完整标记，避免产生重复分段。
			if (seg.index === marker.start) {
				const markerText = text.slice(marker.start, marker.end);
				result.push({
					segment: markerText,
					index: marker.start,
					input: text,
				});
			}
			// Otherwise skip (already merged into the first segment).
			// 其余内部字素已并入首个分段，因此直接跳过。
		} else {
			result.push(seg);
		}
	}

	return result;
}

/**
 * Represents a chunk of text for word-wrap layout.
 * Tracks both the text content and its position in the original line.
 */
/** 表示自动换行后的文本块，同时记录其在原逻辑行中的索引范围。 */
export interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
}

/**
 * Split a line into word-wrapped chunks.
 * Wraps at word boundaries when possible, falling back to character-level
 * wrapping for words longer than the available width.
 *
 * @param line - The text line to wrap
 * @param maxWidth - Maximum visible width per chunk
 * @param preSegmented - Optional pre-segmented graphemes (e.g. with paste-marker awareness).
 *                       When omitted the default Intl.Segmenter is used.
 * @returns Array of chunks with text and position information
 */
/**
 * 将逻辑行按可见宽度拆成视觉行：优先在词边界换行，超长单词则退化为字素级换行。
 * 可传入预分段结果，以保证粘贴标记等原子单元不会被常规分段规则拆开。
 */
export function wordWrapLine(line: string, maxWidth: number, preSegmented?: Intl.SegmentData[]): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0 }];
	}

	const lineWidth = visibleWidth(line);
	if (lineWidth <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	}

	const chunks: TextChunk[] = [];
	const segments = preSegmented ?? [...graphemeSegmenter.segment(line)];

	let currentWidth = 0;
	let chunkStart = 0;

	// Wrap opportunity: the position after the last whitespace before a non-whitespace
	// grapheme, i.e. where a line break is allowed.
	// 记录最近一次合法换行点：连续空白结束、下一个非空白字素开始的位置。
	let wrapOppIndex = -1;
	let wrapOppWidth = 0;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		const grapheme = seg.segment;
		const gWidth = visibleWidth(grapheme);
		const charIndex = seg.index;
		const isWs = !isPasteMarker(grapheme) && isWhitespaceChar(grapheme);

		// Overflow check before advancing.
		// 在计入当前字素前判断是否溢出，以便选择回退到词边界或强制断行。
		if (currentWidth + gWidth > maxWidth) {
			if (wrapOppIndex >= 0 && currentWidth - wrapOppWidth + gWidth <= maxWidth) {
				// Backtrack to last wrap opportunity (the remaining content
				// plus the current grapheme still fits within maxWidth).
				// 回退到最近的换行点；回退后的剩余内容加当前字素仍能放入下一行。
				chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex });
				chunkStart = wrapOppIndex;
				currentWidth -= wrapOppWidth;
			} else if (chunkStart < charIndex) {
				// No viable wrap opportunity: force-break at current position.
				// This also handles the case where backtracking to a word
				// boundary wouldn't help because the remaining content plus
				// the current grapheme (e.g. a wide character) still exceeds
				// maxWidth.
				// 没有可用词边界时在当前位置强制断行，这也覆盖宽字符导致回退后仍超宽的情况。
				chunks.push({ text: line.slice(chunkStart, charIndex), startIndex: chunkStart, endIndex: charIndex });
				chunkStart = charIndex;
				currentWidth = 0;
			}
			wrapOppIndex = -1;
		}

		if (gWidth > maxWidth) {
			// Single atomic segment wider than maxWidth (e.g. paste marker
			// in a narrow terminal). Re-wrap it at grapheme granularity.
			// 原子分段本身比终端宽时，仅为视觉布局按字素再次拆分，例如窄终端中的粘贴标记。

			// The segment remains logically atomic for cursor
			// movement / editing — the split is purely visual for word-wrap layout.
			// 该拆分不改变编辑语义；光标移动和删除仍把整个分段视为原子单元。
			const subChunks = wordWrapLine(grapheme, maxWidth);
			for (let j = 0; j < subChunks.length - 1; j++) {
				const sc = subChunks[j]!;
				chunks.push({ text: sc.text, startIndex: charIndex + sc.startIndex, endIndex: charIndex + sc.endIndex });
			}
			const last = subChunks[subChunks.length - 1]!;
			chunkStart = charIndex + last.startIndex;
			currentWidth = visibleWidth(last.text);
			wrapOppIndex = -1;
			continue;
		}

		// Advance.
		// 当前字素已纳入本视觉行，更新累计可见宽度。
		currentWidth += gWidth;

		// Record wrap opportunity: whitespace followed by non-whitespace
		// (multiple spaces join; the break point is after the last space),
		// or at a boundary where either side is CJK (CJK allows breaking
		// between any adjacent characters).
		// 空白边界和 CJK 相邻字符都可作为换行点；连续空白统一在最后一个空白后断开。
		const next = segments[i + 1];
		if (isWs && next && (isPasteMarker(next.segment) || !isWhitespaceChar(next.segment))) {
			wrapOppIndex = next.index;
			wrapOppWidth = currentWidth;
		} else if (!isWs && next && !isWhitespaceChar(next.segment)) {
			const isCjk = !isPasteMarker(grapheme) && cjkBreakRegex.test(grapheme);
			const nextIsCjk = !isPasteMarker(next.segment) && cjkBreakRegex.test(next.segment);
			if (isCjk || nextIsCjk) {
				wrapOppIndex = next.index;
				wrapOppWidth = currentWidth;
			}
		}
	}

	// Push final chunk.
	// 将最后一个尚未输出的文本块加入结果。
	chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });

	return chunks;
}

// Kitty CSI-u sequences for printable keys, including optional shifted/base codepoints.
// Kitty CSI-u 可打印按键序列可能同时携带 Shift 后码点和基础码点。
interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

interface LayoutLine {
	text: string;
	hasCursor: boolean;
	cursorPos?: number;
}

export interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
}

export interface EditorOptions {
	paddingX?: number;
	autocompleteMaxVisible?: number;
}

const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS = 20;
const DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS = ["@", "#"];

function escapeCharacterClass(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&");
}

function buildTriggerPattern(triggerCharacters: string[]): RegExp {
	return new RegExp(`(?:^|[\\s])[${triggerCharacters.map(escapeCharacterClass).join("")}][^\\s]*$`);
}

function buildDebouncePattern(triggerCharacters: string[]): RegExp {
	const escapedWithoutAt = triggerCharacters.filter((character) => character !== "@").map(escapeCharacterClass);
	return new RegExp(`(?:^|[ \\t])(?:@(?:"[^"]*|[^\\s]*)|[${escapedWithoutAt.join("")}][^\\s]*)$`);
}

export class Editor implements Component, Focusable {
	private state: EditorState = {
		lines: [""],
		cursorLine: 0,
		cursorCol: 0,
	};

	/** Focusable interface - set by TUI when focus changes */
	/** Focusable 接口字段，由 TUI 在焦点变化时维护。 */
	focused: boolean = false;

	protected tui: TUI;
	private theme: EditorTheme;
	private paddingX: number = 0;

	// Store last render width for cursor navigation
	// 保存上次渲染采用的换行宽度，供上下移动时重建相同的视觉行。
	private lastWidth: number = 80;

	// Vertical scrolling support
	// 编辑器内容区域的纵向滚动偏移，以视觉行为单位。
	private scrollOffset: number = 0;

	// Border color (can be changed dynamically)
	// 边框着色函数允许外部在运行时动态替换。
	public borderColor: (str: string) => string;

	// Autocomplete support
	// 自动补全状态同时跟踪触发上下文、列表 UI 以及异步请求的取消与去重。
	private autocompleteProvider?: AutocompleteProvider;
	private autocompleteTriggerCharacters = [...DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS];
	private autocompleteTriggerPattern = buildTriggerPattern(this.autocompleteTriggerCharacters);
	private autocompleteDebouncePattern = buildDebouncePattern(this.autocompleteTriggerCharacters);
	private autocompleteList?: SelectList;
	private autocompleteState: "regular" | "force" | null = null;
	private autocompletePrefix: string = "";
	private autocompleteMaxVisible: number = 5;
	private autocompleteAbort?: AbortController;
	private autocompleteDebounceTimer?: ReturnType<typeof setTimeout>;
	private autocompleteRequestTask: Promise<void> = Promise.resolve();
	private autocompleteStartToken: number = 0;
	private autocompleteRequestId: number = 0;

	// Paste tracking for large pastes
	// 大段粘贴内容保存在映射中，正文只插入短标记，提交时再展开。
	private pastes: Map<number, string> = new Map();
	private pasteCounter: number = 0;

	// Bracketed paste mode buffering
	// bracketed paste 可能跨多次输入事件到达，因此需要持续缓冲到结束标记。
	private pasteBuffer: string = "";
	private isInPaste: boolean = false;

	// Prompt history for up/down navigation
	// 上下键浏览历史时保留进入历史前的草稿，以便向下返回时恢复现场。
	private history: string[] = [];
	private historyIndex: number = -1; // -1 = not browsing, 0 = most recent, 1 = older, etc.
	// `-1` 表示未浏览历史，`0` 为最近一条，数值越大表示越旧。
	private historyDraft: EditorState | null = null;

	// Kill ring for Emacs-style kill/yank operations
	// kill ring 支持 Emacs 风格的连续删除合并、yank 与 yank-pop。
	private killRing = new KillRing();
	private lastAction: "kill" | "yank" | "type-word" | null = null;

	// Character jump mode
	// 字符跳转模式会等待下一次可打印输入，将其作为搜索目标而非正文输入。
	private jumpMode: "forward" | "backward" | null = null;

	// Preferred visual column for vertical cursor movement (sticky column)
	// 上下移动遇到短视觉行时记住首选列，以便进入更长行后恢复原列。
	private preferredVisualCol: number | null = null;

	// When the cursor is snapped to the start of an atomic segment, e.g. a
	// paste marker, cursorCol no longer reflects where the cursor would have
	// landed. This field stores the pre-snap cursorCol so that the next
	// vertical move can resolve it to a visual column on whatever VL it belongs
	// to.
	// 原子分段吸附会改变实际 cursorCol；这里保留吸附前位置，供下一次纵向移动恢复正确视觉列。
	private snappedFromCursorCol: number | null = null;

	// Undo support
	// 撤销栈保存完整编辑器状态快照，原子操作只推入一次。
	private undoStack = new UndoStack<EditorState>();

	public onSubmit?: (text: string) => void;
	public onChange?: (text: string) => void;
	public disableSubmit: boolean = false;

	constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
		this.tui = tui;
		this.theme = theme;
		this.borderColor = theme.borderColor;
		const paddingX = options.paddingX ?? 0;
		this.paddingX = Number.isFinite(paddingX) ? Math.max(0, Math.floor(paddingX)) : 0;
		const maxVisible = options.autocompleteMaxVisible ?? 5;
		this.autocompleteMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
	}

	/** Set of currently valid paste IDs, for marker-aware segmentation. */
	/** 返回当前仍有效的粘贴 ID 集合，供标记感知分段使用。 */
	private validPasteIds(): Set<number> {
		return new Set(this.pastes.keys());
	}

	/** Segment text with paste-marker awareness, only merging markers with valid IDs. */
	/** 按词或字素分段，并仅将有效 ID 对应的粘贴标记合并为原子单元。 */
	private segment(text: string, mode: "word" | "grapheme"): Iterable<Intl.SegmentData> {
		return segmentWithMarkers(text, mode === "word" ? wordSegmenter : graphemeSegmenter, this.validPasteIds());
	}

	getPaddingX(): number {
		return this.paddingX;
	}

	setPaddingX(padding: number): void {
		const newPadding = Number.isFinite(padding) ? Math.max(0, Math.floor(padding)) : 0;
		if (this.paddingX !== newPadding) {
			this.paddingX = newPadding;
			this.tui.requestRender();
		}
	}

	getAutocompleteMaxVisible(): number {
		return this.autocompleteMaxVisible;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		const newMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
		if (this.autocompleteMaxVisible !== newMaxVisible) {
			this.autocompleteMaxVisible = newMaxVisible;
			this.tui.requestRender();
		}
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.cancelAutocomplete();
		this.autocompleteProvider = provider;
		this.setAutocompleteTriggerCharacters(provider.triggerCharacters ?? []);
	}

	/**
	 * Add a prompt to history for up/down arrow navigation.
	 * Called after successful submission.
	 */
	/** 成功提交后将提示词加入历史，供上下键浏览。 */
	addToHistory(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		// Don't add consecutive duplicates
		// 连续重复项不写入历史，避免上下浏览出现无意义的相邻副本。
		if (this.history.length > 0 && this.history[0] === trimmed) return;
		this.history.unshift(trimmed);
		// Limit history size
		// 限制历史长度，避免长期会话无限增长。
		if (this.history.length > 100) {
			this.history.pop();
		}
	}

	private isEditorEmpty(): boolean {
		return this.state.lines.length === 1 && this.state.lines[0] === "";
	}

	private isOnFirstVisualLine(): boolean {
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		return currentVisualLine === 0;
	}

	private isOnLastVisualLine(): boolean {
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		return currentVisualLine === visualLines.length - 1;
	}

	private navigateHistory(direction: 1 | -1): void {
		this.lastAction = null;
		if (this.history.length === 0) return;

		const newIndex = this.historyIndex - direction; // Up(-1) increases index, Down(1) decreases
		// 上移传入 -1，因此索引增大并进入更旧记录；下移则反向接近草稿。
		if (newIndex < -1 || newIndex >= this.history.length) return;

		// Capture state when first entering history browsing mode
		// 首次进入历史浏览时保存当前草稿，返回索引 -1 时可原样恢复。
		if (this.historyIndex === -1 && newIndex >= 0) {
			this.pushUndoSnapshot();
			this.historyDraft = structuredClone(this.state);
		}

		this.historyIndex = newIndex;

		if (this.historyIndex === -1) {
			const draft = this.historyDraft;
			this.historyDraft = null;
			if (draft) {
				this.state = draft;
				this.preferredVisualCol = null;
				this.snappedFromCursorCol = null;
				this.scrollOffset = 0;
				if (this.onChange) this.onChange(this.getText());
			} else {
				this.setTextInternal("");
			}
		} else {
			this.setTextInternal(this.history[this.historyIndex] || "", direction === -1 ? "start" : "end");
		}
	}

	private exitHistoryBrowsing(): void {
		this.historyIndex = -1;
		this.historyDraft = null;
	}

	/** Internal setText that doesn't reset history state - used by navigateHistory */
	/** 供历史导航使用的内部赋值方法，不会重置历史浏览状态。 */
	private setTextInternal(text: string, cursorPlacement: "start" | "end" = "end"): void {
		const lines = text.split("\n");
		this.state.lines = lines.length === 0 ? [""] : lines;
		this.state.cursorLine = cursorPlacement === "start" ? 0 : this.state.lines.length - 1;
		this.setCursorCol(cursorPlacement === "start" ? 0 : this.state.lines[this.state.cursorLine]?.length || 0);
		// Reset scroll - render() will adjust to show cursor
		// 先复位滚动位置，render() 会按新光标位置重新调整可见区域。
		this.scrollOffset = 0;

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	invalidate(): void {
		// No cached state to invalidate currently
		// 当前没有需要失效处理的派生缓存。
	}

	render(width: number): string[] {
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.paddingX, maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);

		// Layout width: with padding the cursor can overflow into it,
		// without padding we reserve 1 column for the cursor.
		// 有水平内边距时末尾光标可占用内边距；无内边距时预留一列，避免光标越界。
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));

		// Store for cursor navigation (must match wrapping width)
		// 光标导航必须使用与本次换行一致的宽度。
		this.lastWidth = layoutWidth;

		const horizontal = this.borderColor("─");

		// Layout the text
		// 先把逻辑行转换为按终端宽度换行后的布局行。
		const layoutLines = this.layoutText(layoutWidth);

		// Calculate max visible lines: 30% of terminal height, minimum 5 lines
		// 编辑区最多占终端高度的 30%，但至少显示 5 行。
		const terminalRows = this.tui.terminal.rows;
		const maxVisibleLines = Math.max(5, Math.floor(terminalRows * 0.3));

		// Find the cursor line index in layoutLines
		// 在布局行中定位光标所在视觉行。
		let cursorLineIndex = layoutLines.findIndex((line) => line.hasCursor);
		if (cursorLineIndex === -1) cursorLineIndex = 0;

		// Adjust scroll offset to keep cursor visible
		// 必要时移动滚动窗口，确保光标始终处于可见范围。
		if (cursorLineIndex < this.scrollOffset) {
			this.scrollOffset = cursorLineIndex;
		} else if (cursorLineIndex >= this.scrollOffset + maxVisibleLines) {
			this.scrollOffset = cursorLineIndex - maxVisibleLines + 1;
		}

		// Clamp scroll offset to valid range
		// 将偏移限制在当前内容允许的滚动范围内。
		const maxScrollOffset = Math.max(0, layoutLines.length - maxVisibleLines);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScrollOffset));

		// Get visible lines slice
		// 仅渲染滚动窗口覆盖的布局行。
		const visibleLines = layoutLines.slice(this.scrollOffset, this.scrollOffset + maxVisibleLines);

		const result: string[] = [];
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = leftPadding;

		// Render top border (with scroll indicator if scrolled down)
		// 顶部边框在存在上方内容时同时显示滚动提示。
		if (this.scrollOffset > 0) {
			const indicator = `─── ↑ ${this.scrollOffset} more `;
			const remaining = width - visibleWidth(indicator);
			if (remaining >= 0) {
				result.push(this.borderColor(indicator + "─".repeat(remaining)));
			} else {
				result.push(this.borderColor(truncateToWidth(indicator, width)));
			}
		} else {
			result.push(horizontal.repeat(width));
		}

		// Render each visible layout line
		// Emit hardware cursor marker when focused so TUI can position the
		// hardware cursor for IME candidate-window placement even while
		// autocomplete (e.g. slash-command menu) is visible.
		// 聚焦时始终输出硬件光标标记，使输入法候选窗在自动补全菜单显示期间仍定位到真实光标。
		const emitCursorMarker = this.focused;

		for (const layoutLine of visibleLines) {
			let displayText = layoutLine.text;
			let lineVisibleWidth = visibleWidth(layoutLine.text);
			let cursorInPadding = false;

			// Add cursor if this line has it
			// 仅在包含逻辑光标的布局行中绘制光标。
			if (layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
				const before = displayText.slice(0, layoutLine.cursorPos);
				const after = displayText.slice(layoutLine.cursorPos);

				// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
				// 零宽硬件光标标记放在模拟光标之前，专门用于输入法定位。
				const marker = emitCursorMarker ? CURSOR_MARKER : "";

				if (after.length > 0) {
					// Cursor is on a character (grapheme) - replace it with highlighted version
					// Get the first grapheme from 'after'
					// 光标覆盖字符时高亮完整首字素，避免拆开 emoji 或组合字符。
					const afterGraphemes = [...this.segment(after, "grapheme")];
					const firstGrapheme = afterGraphemes[0]?.segment || "";
					const restAfter = after.slice(firstGrapheme.length);
					const cursor = `\x1b[7m${firstGrapheme}\x1b[0m`;
					displayText = before + marker + cursor + restAfter;
					// lineVisibleWidth stays the same - we're replacing, not adding
					// 这里只替换显示样式，不增加可见宽度。
				} else {
					// Cursor is at the end - add highlighted space
					// 行尾没有可覆盖字符，因此追加一个高亮空格表示光标。
					const cursor = "\x1b[7m \x1b[0m";
					displayText = before + marker + cursor;
					lineVisibleWidth = lineVisibleWidth + 1;
					// If cursor overflows content width into the padding, flag it
					// 若行尾光标占用了右侧内边距，稍后相应缩短该内边距。
					if (lineVisibleWidth > contentWidth && paddingX > 0) {
						cursorInPadding = true;
					}
				}
			}

			// Calculate padding based on actual visible width
			// ANSI 样式不计入宽度，因此依据可见宽度补齐空白。
			const padding = " ".repeat(Math.max(0, contentWidth - lineVisibleWidth));
			const lineRightPadding = cursorInPadding ? rightPadding.slice(1) : rightPadding;

			// Render the line (no side borders, just horizontal lines above and below)
			// 编辑器没有左右竖边框，仅拼接水平内边距和内容。
			result.push(`${leftPadding}${displayText}${padding}${lineRightPadding}`);
		}

		// Render bottom border (with scroll indicator if more content below)
		// 底部仍有内容时在边框中显示剩余视觉行数量。
		const linesBelow = layoutLines.length - (this.scrollOffset + visibleLines.length);
		if (linesBelow > 0) {
			const indicator = `─── ↓ ${linesBelow} more `;
			const remaining = width - visibleWidth(indicator);
			result.push(this.borderColor(indicator + "─".repeat(Math.max(0, remaining))));
		} else {
			result.push(horizontal.repeat(width));
		}

		// Add autocomplete list if active
		// 自动补全列表附加在编辑框下方，并与正文使用相同水平内边距。
		if (this.autocompleteState && this.autocompleteList) {
			const autocompleteResult = this.autocompleteList.render(contentWidth);
			for (const line of autocompleteResult) {
				const lineWidth = visibleWidth(line);
				const linePadding = " ".repeat(Math.max(0, contentWidth - lineWidth));
				result.push(`${leftPadding}${line}${linePadding}${rightPadding}`);
			}
		}

		return result;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// Handle character jump mode (awaiting next character to jump to)
		// 字符跳转模式把下一次可打印输入作为搜索目标，而不是插入正文。
		if (this.jumpMode !== null) {
			// Cancel if the hotkey is pressed again
			// 再次按下任一跳转快捷键时取消等待状态。
			if (kb.matches(data, "tui.editor.jumpForward") || kb.matches(data, "tui.editor.jumpBackward")) {
				this.jumpMode = null;
				return;
			}

			const printable = decodePrintableKey(data) ?? (data.charCodeAt(0) >= 32 ? data : undefined);
			if (printable !== undefined) {
				// Printable character - perform the jump
				// 收到可打印字符后执行跳转，并立即退出该模式。
				const direction = this.jumpMode;
				this.jumpMode = null;
				this.jumpToChar(printable, direction);
				return;
			}

			// Control character - cancel and fall through to normal handling
			// 控制字符不作为搜索目标；取消模式后继续按常规按键处理。
			this.jumpMode = null;
		}

		// Handle bracketed paste mode
		// 识别 bracketed paste 起始序列，并开始跨事件缓冲粘贴内容。
		if (data.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}

		if (this.isInPaste) {
			this.pasteBuffer += data;
			const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
			if (endIndex !== -1) {
				const pasteContent = this.pasteBuffer.substring(0, endIndex);
				if (pasteContent.length > 0) {
					this.handlePaste(pasteContent);
				}
				this.isInPaste = false;
				const remaining = this.pasteBuffer.substring(endIndex + 6);
				this.pasteBuffer = "";
				if (remaining.length > 0) {
					this.handleInput(remaining);
				}
				return;
			}
			return;
		}

		// Ctrl+C - let parent handle (exit/clear)
		// Ctrl+C 交给上层决定退出或清空，编辑器自身不消费。
		if (kb.matches(data, "tui.input.copy")) {
			return;
		}

		// Undo
		// 撤销恢复最近一次快照。
		if (kb.matches(data, "tui.editor.undo")) {
			this.undo();
			return;
		}

		// Handle autocomplete mode
		// 补全列表打开时优先处理选择、取消和应用，避免按键落入正文编辑。
		if (this.autocompleteState && this.autocompleteList) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.cancelAutocomplete();
				return;
			}

			if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
				this.autocompleteList.handleInput(data);
				return;
			}

			if (kb.matches(data, "tui.input.tab")) {
				const selected = this.autocompleteList.getSelectedItem();
				if (selected && this.autocompleteProvider) {
					this.pushUndoSnapshot();
					this.lastAction = null;
					const result = this.autocompleteProvider.applyCompletion(
						this.state.lines,
						this.state.cursorLine,
						this.state.cursorCol,
						selected,
						this.autocompletePrefix,
					);
					this.state.lines = result.lines;
					this.state.cursorLine = result.cursorLine;
					this.setCursorCol(result.cursorCol);
					this.cancelAutocomplete();
					if (this.onChange) this.onChange(this.getText());
				}
				return;
			}

			if (kb.matches(data, "tui.select.confirm")) {
				const selected = this.autocompleteList.getSelectedItem();
				if (selected && this.autocompleteProvider) {
					this.pushUndoSnapshot();
					this.lastAction = null;
					const result = this.autocompleteProvider.applyCompletion(
						this.state.lines,
						this.state.cursorLine,
						this.state.cursorCol,
						selected,
						this.autocompletePrefix,
					);
					this.state.lines = result.lines;
					this.state.cursorLine = result.cursorLine;
					this.setCursorCol(result.cursorCol);

					if (this.autocompletePrefix.startsWith("/")) {
						this.cancelAutocomplete();
						// Fall through to submit
						// 斜杠命令确认后继续走提交逻辑，而普通补全只更新正文。
					} else {
						this.cancelAutocomplete();
						if (this.onChange) this.onChange(this.getText());
						return;
					}
				}
			}
		}

		// Tab - trigger completion
		// 列表未打开时，Tab 根据当前上下文触发命令或文件补全。
		if (kb.matches(data, "tui.input.tab") && !this.autocompleteState) {
			this.handleTabCompletion();
			return;
		}

		// Deletion actions
		// 删除类按键优先于普通字符解码，并分别维护撤销与 kill ring 语义。
		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			this.deleteToEndOfLine();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.deleteToStartOfLine();
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
		if (kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace")) {
			this.handleBackspace();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete")) {
			this.handleForwardDelete();
			return;
		}

		// Kill ring actions
		// yank 插入最近删除内容，yank-pop 可在紧接 yank 后轮换历史项。
		if (kb.matches(data, "tui.editor.yank")) {
			this.yank();
			return;
		}
		if (kb.matches(data, "tui.editor.yankPop")) {
			this.yankPop();
			return;
		}

		// Cursor movement actions
		// 行首尾与按词移动都会清除纵向移动保留的首选视觉列。
		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.moveToLineStart();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.moveToLineEnd();
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

		// New line
		// 兼容不同终端产生的换行序列，并区分插入新行与反斜杠提交约定。
		if (
			kb.matches(data, "tui.input.newLine") ||
			(data.charCodeAt(0) === 10 && data.length > 1) ||
			data === "\x1b\r" ||
			data === "\x1b[13;2~" ||
			(data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
			(data === "\n" && data.length === 1)
		) {
			if (this.shouldSubmitOnBackslashEnter(data, kb)) {
				this.handleBackspace();
				this.submitValue();
				return;
			}
			this.addNewLine();
			return;
		}

		// Submit (Enter)
		// 普通 Enter 提交；禁用提交时保持当前编辑状态不变。
		if (kb.matches(data, "tui.input.submit")) {
			if (this.disableSubmit) return;

			// Workaround for terminals without Shift+Enter support:
			// If char before cursor is \, delete it and insert newline instead of submitting.
			// 对不支持 Shift+Enter 的终端，以光标前反斜杠作为插入换行的替代手势。
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			if (this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\") {
				this.handleBackspace();
				this.addNewLine();
				return;
			}

			this.submitValue();
			return;
		}

		// Arrow key navigation (with history support)
		// 上下键在视觉行内移动；到达首尾视觉行后才切换历史或跳到逻辑行边界。
		if (kb.matches(data, "tui.editor.cursorUp")) {
			if (
				this.isOnFirstVisualLine() &&
				(this.isEditorEmpty() || this.historyIndex > -1 || this.state.cursorCol === 0)
			) {
				this.navigateHistory(-1);
			} else if (this.isOnFirstVisualLine()) {
				// Already at top - jump to start of line
				// 已在顶部且不满足历史导航条件时，移动到逻辑行首。
				this.moveToLineStart();
			} else {
				this.moveCursor(-1, 0);
			}
			return;
		}
		if (kb.matches(data, "tui.editor.cursorDown")) {
			if (this.historyIndex > -1 && this.isOnLastVisualLine()) {
				this.navigateHistory(1);
			} else if (this.isOnLastVisualLine()) {
				// Already at bottom - jump to end of line
				// 已在底部且未浏览历史时，移动到逻辑行尾。
				this.moveToLineEnd();
			} else {
				this.moveCursor(1, 0);
			}
			return;
		}
		if (kb.matches(data, "tui.editor.cursorRight")) {
			this.moveCursor(0, 1);
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.moveCursor(0, -1);
			return;
		}

		// Page up/down - scroll by page and move cursor
		// 翻页通过移动光标驱动滚动，保证滚动位置和编辑焦点一致。
		if (kb.matches(data, "tui.editor.pageUp")) {
			this.pageScroll(-1);
			return;
		}
		if (kb.matches(data, "tui.editor.pageDown")) {
			this.pageScroll(1);
			return;
		}

		// Character jump mode triggers
		// 进入字符跳转等待状态，方向由触发的快捷键决定。
		if (kb.matches(data, "tui.editor.jumpForward")) {
			this.jumpMode = "forward";
			return;
		}
		if (kb.matches(data, "tui.editor.jumpBackward")) {
			this.jumpMode = "backward";
			return;
		}

		// Shift+Space - insert regular space
		// 某些终端会为 Shift+Space 编码特殊序列，这里显式还原为普通空格。
		if (matchesKey(data, "shift+space")) {
			this.insertCharacter(" ");
			return;
		}

		const printable = decodePrintableKey(data);
		if (printable !== undefined) {
			this.insertCharacter(printable);
			return;
		}

		// Regular characters
		// 未被专用解码器识别但码点可打印的输入按原样插入。
		if (data.charCodeAt(0) >= 32) {
			this.insertCharacter(data);
		}
	}

	private layoutText(contentWidth: number): LayoutLine[] {
		const layoutLines: LayoutLine[] = [];

		if (this.state.lines.length === 0 || (this.state.lines.length === 1 && this.state.lines[0] === "")) {
			// Empty editor
			// 空编辑器仍生成一条布局行，以便显示光标。
			layoutLines.push({
				text: "",
				hasCursor: true,
				cursorPos: 0,
			});
			return layoutLines;
		}

		// Process each logical line
		// 将每个逻辑行转换为一个或多个视觉布局行。
		for (let i = 0; i < this.state.lines.length; i++) {
			const line = this.state.lines[i] || "";
			const isCurrentLine = i === this.state.cursorLine;
			const lineVisibleWidth = visibleWidth(line);

			if (lineVisibleWidth <= contentWidth) {
				// Line fits in one layout line
				// 未超宽的逻辑行可直接作为单个布局行。
				if (isCurrentLine) {
					layoutLines.push({
						text: line,
						hasCursor: true,
						cursorPos: this.state.cursorCol,
					});
				} else {
					layoutLines.push({
						text: line,
						hasCursor: false,
					});
				}
			} else {
				// Line needs wrapping - use word-aware wrapping
				// 超宽逻辑行使用词边界感知的换行，并保留原始索引范围。
				const chunks = wordWrapLine(line, contentWidth, [...this.segment(line, "grapheme")]);

				for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
					const chunk = chunks[chunkIndex];
					if (!chunk) continue;

					const cursorPos = this.state.cursorCol;
					const isLastChunk = chunkIndex === chunks.length - 1;

					// Determine if cursor is in this chunk
					// For word-wrapped chunks, we need to handle the case where
					// cursor might be in trimmed whitespace at end of chunk
					// 根据原逻辑列判断光标归属；非末块使用半开区间，避免边界光标同时落入两块。
					let hasCursorInChunk = false;
					let adjustedCursorPos = 0;

					if (isCurrentLine) {
						if (isLastChunk) {
							// Last chunk: cursor belongs here if >= startIndex
							// 最后一个块也接纳逻辑行末尾的光标位置。
							hasCursorInChunk = cursorPos >= chunk.startIndex;
							adjustedCursorPos = cursorPos - chunk.startIndex;
						} else {
							// Non-last chunk: cursor belongs here if in range [startIndex, endIndex)
							// But we need to handle the visual position in the trimmed text
							// 非末块仅接纳 `[startIndex, endIndex)`，并将逻辑列换算为块内位置。
							hasCursorInChunk = cursorPos >= chunk.startIndex && cursorPos < chunk.endIndex;
							if (hasCursorInChunk) {
								adjustedCursorPos = cursorPos - chunk.startIndex;
								// Clamp to text length (in case cursor was in trimmed whitespace)
								// 若换行处理裁掉了尾部空白，将光标限制到实际显示文本末尾。
								if (adjustedCursorPos > chunk.text.length) {
									adjustedCursorPos = chunk.text.length;
								}
							}
						}
					}

					if (hasCursorInChunk) {
						layoutLines.push({
							text: chunk.text,
							hasCursor: true,
							cursorPos: adjustedCursorPos,
						});
					} else {
						layoutLines.push({
							text: chunk.text,
							hasCursor: false,
						});
					}
				}
			}
		}

		return layoutLines;
	}

	getText(): string {
		return this.state.lines.join("\n");
	}

	private expandPasteMarkers(text: string): string {
		let result = text;
		for (const [pasteId, pasteContent] of this.pastes) {
			const markerRegex = new RegExp(`\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g");
			result = result.replace(markerRegex, () => pasteContent);
		}
		return result;
	}

	/**
	 * Get text with paste markers expanded to their actual content.
	 * Use this when you need the full content (e.g., for external editor).
	 */
	/** 获取展开所有粘贴标记后的完整文本，适用于外部编辑器等需要原始内容的场景。 */
	getExpandedText(): string {
		return this.expandPasteMarkers(this.state.lines.join("\n"));
	}

	getLines(): string[] {
		return [...this.state.lines];
	}

	getCursor(): { line: number; col: number } {
		return { line: this.state.cursorLine, col: this.state.cursorCol };
	}

	setText(text: string): void {
		this.cancelAutocomplete();
		this.lastAction = null;
		this.exitHistoryBrowsing();
		this.pastes.clear();
		this.pasteCounter = 0;
		const normalized = this.normalizeText(text);
		// Push undo snapshot if content differs (makes programmatic changes undoable)
		// 仅当内容实际变化时记录快照，使程序化赋值也可撤销且不产生空操作。
		if (this.getText() !== normalized) {
			this.pushUndoSnapshot();
		}
		this.setTextInternal(normalized);
	}

	/**
	 * Insert text at the current cursor position.
	 * Used for programmatic insertion (e.g., clipboard image markers).
	 * This is atomic for undo - single undo restores entire pre-insert state.
	 */
	/** 在当前光标处以单个撤销单元插入程序化文本，例如剪贴板图片标记。 */
	insertTextAtCursor(text: string): void {
		if (!text) return;
		this.cancelAutocomplete();
		this.pushUndoSnapshot();
		this.lastAction = null;
		this.exitHistoryBrowsing();
		this.insertTextAtCursorInternal(text);
	}

	/**
	 * Normalize text for editor storage:
	 * - Normalize line endings (\r\n and \r -> \n)
	 * - Expand tabs to 4 spaces
	 */
	/** 统一编辑器内部文本格式：换行归一为 `\n`，制表符展开为四个空格。 */
	private normalizeText(text: string): string {
		return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
	}

	/**
	 * Internal text insertion at cursor. Handles single and multi-line text.
	 * Does not push undo snapshots or trigger autocomplete - caller is responsible.
	 * Normalizes line endings and calls onChange once at the end.
	 */
	/** 内部插入实现不创建撤销快照或触发补全，由调用方控制原子操作边界。 */
	private insertTextAtCursorInternal(text: string): void {
		if (!text) return;

		// Normalize line endings and tabs
		// 插入前统一换行和制表符，确保内部列索引规则稳定。
		const normalized = this.normalizeText(text);
		const insertedLines = normalized.split("\n");

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		const afterCursor = currentLine.slice(this.state.cursorCol);

		if (insertedLines.length === 1) {
			// Single line - insert at cursor position
			// 单行文本直接拼接到当前逻辑行的光标位置。
			this.state.lines[this.state.cursorLine] = beforeCursor + normalized + afterCursor;
			this.setCursorCol(this.state.cursorCol + normalized.length);
		} else {
			// Multi-line insertion
			// 多行插入会拆开当前逻辑行，并分别合并首尾插入行。
			this.state.lines = [
				// All lines before current line
				// 保留当前行之前的所有逻辑行。
				...this.state.lines.slice(0, this.state.cursorLine),

				// The first inserted line merged with text before cursor
				// 插入文本首行与光标前内容合并。
				beforeCursor + insertedLines[0],

				// All middle inserted lines
				// 中间插入行保持独立。
				...insertedLines.slice(1, -1),

				// The last inserted line with text after cursor
				// 插入文本末行与光标后内容合并。
				insertedLines[insertedLines.length - 1] + afterCursor,

				// All lines after current line
				// 最后接回原当前行之后的逻辑行。
				...this.state.lines.slice(this.state.cursorLine + 1),
			];

			this.state.cursorLine += insertedLines.length - 1;
			this.setCursorCol((insertedLines[insertedLines.length - 1] || "").length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	// All the editor methods from before...
	// 以下为编辑操作实现。
	private insertCharacter(char: string, skipUndoCoalescing?: boolean): void {
		this.exitHistoryBrowsing();

		// Undo coalescing (fish-style):
		// - Consecutive word chars coalesce into one undo unit
		// - Space captures state before itself (so undo removes space+following word together)
		// - Each space is separately undoable
		// Skip coalescing when called from atomic operations (e.g., handlePaste)
		// 采用 fish 风格合并连续单词输入；空白开启新的撤销边界，使一次撤销通常移除“空格加后续单词”。
		// 粘贴等外层已定义原子边界的操作可跳过此处合并。
		if (!skipUndoCoalescing) {
			if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
				this.pushUndoSnapshot();
			}
			this.lastAction = "type-word";
		}

		const line = this.state.lines[this.state.cursorLine] || "";

		const before = line.slice(0, this.state.cursorCol);
		const after = line.slice(this.state.cursorCol);

		this.state.lines[this.state.cursorLine] = before + char + after;
		this.setCursorCol(this.state.cursorCol + char.length);

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// Check if we should trigger or update autocomplete
		// 输入后按上下文启动补全，或刷新已打开列表的建议。
		if (!this.autocompleteState) {
			// Auto-trigger for "/" at the start of a line (slash commands)
			// 消息起始处输入 `/` 时自动触发斜杠命令补全。
			if (char === "/" && this.isAtStartOfMessage()) {
				this.tryTriggerAutocomplete();
			}
			// Auto-trigger for symbol-based completion like @, #, or provider triggers at token boundaries
			// `@`、`#` 及提供方字符只在词元边界触发，避免普通文本内部误弹补全。
			else if (this.autocompleteTriggerCharacters.includes(char)) {
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				const charBeforeSymbol = textBeforeCursor[textBeforeCursor.length - 2];
				if (textBeforeCursor.length === 1 || charBeforeSymbol === " " || charBeforeSymbol === "\t") {
					this.tryTriggerAutocomplete();
				}
			}
			// Also auto-trigger when typing letters in a slash command or symbol completion context
			// 已处于命令或符号补全上下文时，继续输入组成词元的字符会刷新建议。
			else if (/[a-zA-Z0-9.\-_]/.test(char)) {
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				// Check if we're in a slash command (with or without space for arguments)
				// 斜杠命令名称及其参数上下文都可由提供方返回建议。
				if (this.isInSlashCommandContext(textBeforeCursor)) {
					this.tryTriggerAutocomplete();
				}
				// Check if we're in a symbol-based completion context like @, #, or provider triggers
				// 否则检查光标前文本是否仍满足符号补全模式。
				else if (this.autocompleteTriggerPattern.test(textBeforeCursor)) {
					this.tryTriggerAutocomplete();
				}
			}
		} else {
			this.updateAutocomplete();
		}
	}

	private handlePaste(pastedText: string): void {
		this.cancelAutocomplete();
		this.exitHistoryBrowsing();
		this.lastAction = null;

		this.pushUndoSnapshot();

		// Some terminals (e.g. tmux popups with extended-keys-format=csi-u) re-encode
		// control bytes inside bracketed paste as CSI-u Ctrl+<letter> sequences
		// (ESC [ <codepoint> ; 5 u). Decode those back to their literal byte so the
		// per-char filter below preserves newlines instead of stripping ESC and
		// leaking the printable tail (e.g. "[106;5u") into the editor.
		// 某些终端会把 bracketed paste 内的控制字节重编码为 CSI-u Ctrl 序列；先还原字节，避免过滤 ESC 后残留可打印尾串。
		const decodedText = pastedText.replace(/\x1b\[(\d+);5u/g, (match, code) => {
			const cp = Number(code);
			if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
			if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
			return match;
		});

		// Clean the pasted text: normalize line endings, expand tabs
		// 统一粘贴文本的换行和制表符格式。
		const cleanText = this.normalizeText(decodedText);

		// Filter out non-printable characters except newlines
		// 除换行外过滤不可打印控制字符，防止终端控制序列进入正文。
		let filteredText = cleanText
			.split("")
			.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
			.join("");

		// If pasting a file path (starts with /, ~, or .) and the character before
		// the cursor is a word character, prepend a space for better readability
		// 粘贴路径且光标前为单词字符时自动补一个空格，避免路径与前文粘连。
		if (/^[/~.]/.test(filteredText)) {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const charBeforeCursor = this.state.cursorCol > 0 ? currentLine[this.state.cursorCol - 1] : "";
			if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
				filteredText = ` ${filteredText}`;
			}
		}

		// Split into lines to check for large paste
		// 按行拆分以同时评估行数和字符数阈值。
		const pastedLines = filteredText.split("\n");

		// Check if this is a large paste (> 10 lines or > 1000 characters)
		// 大段粘贴改用短标记展示，降低编辑器渲染和导航成本。
		const totalChars = filteredText.length;
		if (pastedLines.length > 10 || totalChars > 1000) {
			// Store the paste and insert a marker
			// 保存原文并分配稳定 ID，正文仅插入对应标记。
			this.pasteCounter++;
			const pasteId = this.pasteCounter;
			this.pastes.set(pasteId, filteredText);

			// Insert marker like "[paste #1 +123 lines]" or "[paste #1 1234 chars]"
			// 标记只展示行数或字符数摘要，提交时再展开为原内容。
			const marker =
				pastedLines.length > 10
					? `[paste #${pasteId} +${pastedLines.length} lines]`
					: `[paste #${pasteId} ${totalChars} chars]`;
			this.insertTextAtCursorInternal(marker);
			return;
		}

		if (pastedLines.length === 1) {
			// Single line - insert atomically (do not trigger autocomplete during paste)
			// 单行粘贴作为一个原子操作插入，期间不触发自动补全。
			this.insertTextAtCursorInternal(filteredText);
			return;
		}

		// Multi-line paste - use direct state manipulation
		// 多行粘贴直接更新状态，避免逐字符处理造成多次回调或撤销记录。
		this.insertTextAtCursorInternal(filteredText);
	}

	private addNewLine(): void {
		this.cancelAutocomplete();
		this.exitHistoryBrowsing();
		this.lastAction = null;

		this.pushUndoSnapshot();

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		const before = currentLine.slice(0, this.state.cursorCol);
		const after = currentLine.slice(this.state.cursorCol);

		// Split current line
		// 在光标处拆分当前逻辑行。
		this.state.lines[this.state.cursorLine] = before;
		this.state.lines.splice(this.state.cursorLine + 1, 0, after);

		// Move cursor to start of new line
		// 光标落到新建逻辑行的开头。
		this.state.cursorLine++;
		this.setCursorCol(0);

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private shouldSubmitOnBackslashEnter(data: string, kb: ReturnType<typeof getKeybindings>): boolean {
		if (this.disableSubmit) return false;
		if (!matchesKey(data, "enter")) return false;
		const submitKeys = kb.getKeys("tui.input.submit");
		const hasShiftEnter = submitKeys.includes("shift+enter") || submitKeys.includes("shift+return");
		if (!hasShiftEnter) return false;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		return this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\";
	}

	private submitValue(): void {
		this.cancelAutocomplete();
		const result = this.expandPasteMarkers(this.state.lines.join("\n")).trim();

		this.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
		this.pastes.clear();
		this.pasteCounter = 0;
		this.exitHistoryBrowsing();
		this.scrollOffset = 0;
		this.undoStack.clear();
		this.lastAction = null;

		if (this.onChange) this.onChange("");
		if (this.onSubmit) this.onSubmit(result);
	}

	private handleBackspace(): void {
		this.exitHistoryBrowsing();
		this.lastAction = null;

		if (this.state.cursorCol > 0) {
			this.pushUndoSnapshot();

			// Delete grapheme before cursor (handles emojis, combining characters, etc.)
			// 按完整字素删除光标前内容，避免拆坏 emoji 或组合字符。
			let line = this.state.lines[this.state.cursorLine] || "";
			const beforeCursor = line.slice(0, this.state.cursorCol);

			// Find the last grapheme in the text before cursor
			// 通过标记感知分段找到光标前最后一个原子单元。
			const graphemes = [...this.segment(beforeCursor, "grapheme")];
			const lastGrapheme = graphemes[graphemes.length - 1];
			const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
			const isPastedSegmented = PASTE_MARKER_SINGLE.exec(lastGrapheme.segment);

			if (isPastedSegmented) {
				// This contains the id part e.g 4 from [paste #4 +123 lines]
				// 从完整标记中取出数字 ID，并同步删除保存的粘贴原文。
				const targetId = Number(isPastedSegmented[1]);
				this.pastes.delete(targetId);
				this.pasteCounter--;

				// We got to update id of markers which are greater than the removed one
				// 删除中间 ID 后压缩后续编号，使界面标记保持连续。
				this.state.lines = this.state.lines.map((line) =>
					line.replace(PASTE_MARKER_REGEX, (fullMatch, idGroup, suffixGroup) => {
						const x = Number(idGroup);
						if (x <= targetId) return fullMatch;

						// [paste #3] become [paste #2] if we remove [paste #1]
						// 例如删除 `[paste #1]` 后，原 `[paste #3]` 会重编号为 `[paste #2]`。
						const newText = `[paste #${x - 1}${suffixGroup}]`;
						this.pastes.set(x - 1, this.pastes.get(x) ?? newText);
						this.pastes.delete(x);
						return newText;
					}),
				);
			}

			line = this.state.lines[this.state.cursorLine] || "";

			const before = line.slice(0, this.state.cursorCol - graphemeLength);
			const after = line.slice(this.state.cursorCol);

			this.state.lines[this.state.cursorLine] = before + after;
			this.setCursorCol(this.state.cursorCol - graphemeLength);
		} else if (this.state.cursorLine > 0) {
			this.pushUndoSnapshot();

			// Merge with previous line
			// 行首退格删除换行符，将当前逻辑行合并到上一行。
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";

			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);

			this.state.cursorLine--;
			this.setCursorCol(previousLine.length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// Update or re-trigger autocomplete after backspace
		// 退格可能改变补全前缀：列表打开时刷新，否则在仍可补全的上下文中重新触发。
		if (this.autocompleteState) {
			this.updateAutocomplete();
		} else {
			// If autocomplete was cancelled (no matches), re-trigger if we're in a completable context
			// 即使此前因无匹配关闭列表，退格也可能重新产生匹配项。
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
			// Slash command context
			// 斜杠命令上下文重新请求建议。
			if (this.isInSlashCommandContext(textBeforeCursor)) {
				this.tryTriggerAutocomplete();
			}
			// Symbol-based completion context like @, #, or provider triggers
			// 符号触发上下文同样重新请求建议。
			else if (this.autocompleteTriggerPattern.test(textBeforeCursor)) {
				this.tryTriggerAutocomplete();
			}
		}
	}

	/**
	 * Set cursor column and clear preferredVisualCol.
	 * Use this for all non-vertical cursor movements to reset sticky column behavior.
	 */
	/** 设置逻辑列并清除纵向移动的首选列和原子分段吸附状态。 */
	private setCursorCol(col: number): void {
		this.state.cursorCol = col;
		this.preferredVisualCol = null;
		this.snappedFromCursorCol = null;
	}

	/**
	 * Move cursor to a target visual line, applying sticky column logic.
	 * Shared by moveCursor() and pageScroll().
	 */
	/** 将光标移动到指定视觉行，统一应用粘性列与原子分段边界规则。 */
	private moveToVisualLine(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
		currentVisualLine: number,
		targetVisualLine: number,
	): void {
		const currentVL = visualLines[currentVisualLine];
		const targetVL = visualLines[targetVisualLine];
		if (!(currentVL && targetVL)) return;

		// When the cursor was snapped to a segment start, resolve the pre-snap
		// position against the VL it belongs to. This gives the correct visual
		// column even after a resize reshuffles VLs.
		// 若上次因原子分段吸附过，使用吸附前逻辑列重新定位所属视觉行，从而适应终端宽度变化后的重新换行。
		let currentVisualCol: number;
		if (this.snappedFromCursorCol !== null) {
			const vlIndex = this.findVisualLineAt(visualLines, currentVL.logicalLine, this.snappedFromCursorCol);
			currentVisualCol = this.snappedFromCursorCol - visualLines[vlIndex].startCol;
		} else {
			currentVisualCol = this.state.cursorCol - currentVL.startCol;
		}

		// For non-last segments, clamp to length-1 to stay within the segment
		// 非末视觉块不能把光标放在块尾边界，否则该位置应归属于下一块。
		const isLastSourceSegment =
			currentVisualLine === visualLines.length - 1 ||
			visualLines[currentVisualLine + 1]?.logicalLine !== currentVL.logicalLine;
		const sourceMaxVisualCol = isLastSourceSegment ? currentVL.length : Math.max(0, currentVL.length - 1);

		const isLastTargetSegment =
			targetVisualLine === visualLines.length - 1 ||
			visualLines[targetVisualLine + 1]?.logicalLine !== targetVL.logicalLine;
		const targetMaxVisualCol = isLastTargetSegment ? targetVL.length : Math.max(0, targetVL.length - 1);

		const moveToVisualCol = this.computeVerticalMoveColumn(currentVisualCol, sourceMaxVisualCol, targetMaxVisualCol);

		// Set cursor position
		// 先按目标视觉列换算逻辑行列，再限制到逻辑行长度内。
		this.state.cursorLine = targetVL.logicalLine;
		const targetCol = targetVL.startCol + moveToVisualCol;
		const logicalLine = this.state.lines[targetVL.logicalLine] || "";
		this.state.cursorCol = Math.min(targetCol, logicalLine.length);

		// Snap cursor to atomic segment boundary (e.g. paste markers)
		// so the cursor never lands in the middle of a multi-grapheme unit.
		// Single-grapheme segments don't need snapping.
		// 若目标落在多字符原子单元内部，将光标吸附到其起点，避免编辑粘贴标记内部文本。
		const segments = [...this.segment(logicalLine, "grapheme")];
		for (const seg of segments) {
			if (seg.index > this.state.cursorCol) break;
			if (seg.segment.length <= 1) continue;
			if (this.state.cursorCol < seg.index + seg.segment.length) {
				const isContinuation = seg.index < targetVL.startCol;
				const isMovingDown = targetVisualLine > currentVisualLine;

				if (isContinuation && isMovingDown) {
					// The segment started on a previous visual line, and we
					// already visited it on the way down. Skip all remaining
					// continuation VLs and land on the first VL past it.
					// 向下移动遇到已在上一视觉行访问过的原子单元续行时，跳过全部续行并落到该单元之后。
					const segEnd = seg.index + seg.segment.length;
					let next = targetVisualLine + 1;
					while (
						next < visualLines.length &&
						visualLines[next].logicalLine === targetVL.logicalLine &&
						visualLines[next].startCol < segEnd
					) {
						next++;
					}
					if (next < visualLines.length) {
						this.moveToVisualLine(visualLines, currentVisualLine, next);
						return;
					}
				}

				// Snap to the start of the segment so it gets highlighted.
				// Store the pre-snap position so the next vertical move can
				// resolve it to the correct visual column.
				// 吸附到分段起点以完整高亮，同时保存吸附前列供下一次纵向移动使用。
				this.snappedFromCursorCol = this.state.cursorCol;
				this.state.cursorCol = seg.index;
				return;
			}
		}

		// No snap occurred – we moved out of the atomic segment.
		// 未发生吸附说明光标已离开原子分段，可清除暂存位置。
		this.snappedFromCursorCol = null;
	}

	/**
	 * Compute the target visual column for vertical cursor movement.
	 * Implements the sticky column decision table:
	 *
	 * | P | S | T | U | Scenario                                             | Set Preferred | Move To     |
	 * |---|---|---|---| ---------------------------------------------------- |---------------|-------------|
	 * | 0 | * | 0 | - | Start nav, target fits                               | null          | current     |
	 * | 0 | * | 1 | - | Start nav, target shorter                            | current       | target end  |
	 * | 1 | 0 | 0 | 0 | Clamped, target fits preferred                       | null          | preferred   |
	 * | 1 | 0 | 0 | 1 | Clamped, target longer but still can't fit preferred | keep          | target end  |
	 * | 1 | 0 | 1 | - | Clamped, target even shorter                         | keep          | target end  |
	 * | 1 | 1 | 0 | - | Rewrapped, target fits current                       | null          | current     |
	 * | 1 | 1 | 1 | - | Rewrapped, target shorter than current               | current       | target end  |
	 *
	 * Where:
	 * - P = preferred col is set
	 * - S = cursor in middle of source line (not clamped to end)
	 * - T = target line shorter than current visual col
	 * - U = target line shorter than preferred col
	 */
	/**
	 * 按上表计算纵向移动的目标视觉列：短行会暂存原列，后续长行若可容纳则恢复；重新换行后则以当前可见位置重新建立偏好。
	 */
	private computeVerticalMoveColumn(
		currentVisualCol: number,
		sourceMaxVisualCol: number,
		targetMaxVisualCol: number,
	): number {
		const hasPreferred = this.preferredVisualCol !== null; // P
		// P：此前是否因短行截断而保存了首选列。
		const cursorInMiddle = currentVisualCol < sourceMaxVisualCol; // S
		// S：光标是否仍位于源视觉行中间，而非被截到行尾。
		const targetTooShort = targetMaxVisualCol < currentVisualCol; // T
		// T：目标视觉行是否连当前列都无法容纳。

		if (!hasPreferred || cursorInMiddle) {
			if (targetTooShort) {
				// Cases 2 and 7
				// 情形 2、7：目标过短，保存当前列并落到目标行尾。
				this.preferredVisualCol = currentVisualCol;
				return targetMaxVisualCol;
			}

			// Cases 1 and 6
			// 情形 1、6：目标可容纳当前列，无需继续保留旧偏好。
			this.preferredVisualCol = null;
			return currentVisualCol;
		}

		const targetCantFitPreferred = targetMaxVisualCol < this.preferredVisualCol!; // U
		// U：目标视觉行是否无法容纳已保存的首选列。
		if (targetTooShort || targetCantFitPreferred) {
			// Cases 4 and 5
			// 情形 4、5：仍无法恢复首选列，继续保留偏好并停在行尾。
			return targetMaxVisualCol;
		}

		// Case 3
		// 情形 3：目标已能容纳首选列，恢复后清除偏好。
		const result = this.preferredVisualCol!;
		this.preferredVisualCol = null;
		return result;
	}

	private moveToLineStart(): void {
		this.lastAction = null;
		this.setCursorCol(0);
	}

	private moveToLineEnd(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		this.setCursorCol(currentLine.length);
	}

	private deleteToStartOfLine(): void {
		this.exitHistoryBrowsing();

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol > 0) {
			this.pushUndoSnapshot();

			// Calculate text to be deleted and save to kill ring (backward deletion = prepend)
			// 向后删除的文本前插到 kill ring 当前项，以保持连续删除后的自然顺序。
			const deletedText = currentLine.slice(0, this.state.cursorCol);
			this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			// Delete from start of line up to cursor
			// 删除逻辑行首到光标之间的内容。
			this.state.lines[this.state.cursorLine] = currentLine.slice(this.state.cursorCol);
			this.setCursorCol(0);
		} else if (this.state.cursorLine > 0) {
			this.pushUndoSnapshot();

			// At start of line - merge with previous line, treating newline as deleted text
			// 位于行首时把换行符作为被删除文本，并与上一逻辑行合并。
			this.killRing.push("\n", { prepend: true, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);
			this.state.cursorLine--;
			this.setCursorCol(previousLine.length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteToEndOfLine(): void {
		this.exitHistoryBrowsing();

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			this.pushUndoSnapshot();

			// Calculate text to be deleted and save to kill ring (forward deletion = append)
			// 向前删除的文本追加到 kill ring 当前项，以保持原文顺序。
			const deletedText = currentLine.slice(this.state.cursorCol);
			this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			// Delete from cursor to end of line
			// 删除光标到逻辑行末的内容。
			this.state.lines[this.state.cursorLine] = currentLine.slice(0, this.state.cursorCol);
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			this.pushUndoSnapshot();

			// At end of line - merge with next line, treating newline as deleted text
			// 位于行尾时把换行符作为被删除文本，并合并下一逻辑行。
			this.killRing.push("\n", { prepend: false, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteWordBackwards(): void {
		this.exitHistoryBrowsing();

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at start of line, behave like backspace at column 0 (merge with previous line)
		// 行首按词向后删除等同于删除换行并合并上一逻辑行。
		if (this.state.cursorCol === 0) {
			if (this.state.cursorLine > 0) {
				this.pushUndoSnapshot();

				// Treat newline as deleted text (backward deletion = prepend)
				// 将换行符前插到连续 kill 内容中。
				this.killRing.push("\n", { prepend: true, accumulate: this.lastAction === "kill" });
				this.lastAction = "kill";

				const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
				this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
				this.state.lines.splice(this.state.cursorLine, 1);
				this.state.cursorLine--;
				this.setCursorCol(previousLine.length);
			}
		} else {
			this.pushUndoSnapshot();

			// Save lastAction before cursor movement (moveWordBackwards resets it)
			// 按词移动会重置 lastAction，因此先保存是否应与上一次 kill 合并。
			const wasKill = this.lastAction === "kill";

			const oldCursorCol = this.state.cursorCol;
			this.moveWordBackwards();
			const deleteFrom = this.state.cursorCol;
			this.setCursorCol(oldCursorCol);

			const deletedText = currentLine.slice(deleteFrom, this.state.cursorCol);
			this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
			this.lastAction = "kill";

			this.state.lines[this.state.cursorLine] =
				currentLine.slice(0, deleteFrom) + currentLine.slice(this.state.cursorCol);
			this.setCursorCol(deleteFrom);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteWordForward(): void {
		this.exitHistoryBrowsing();

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at end of line, merge with next line (delete the newline)
		// 行尾按词向前删除会删除换行并合并下一逻辑行。
		if (this.state.cursorCol >= currentLine.length) {
			if (this.state.cursorLine < this.state.lines.length - 1) {
				this.pushUndoSnapshot();

				// Treat newline as deleted text (forward deletion = append)
				// 将换行符追加到连续 kill 内容中。
				this.killRing.push("\n", { prepend: false, accumulate: this.lastAction === "kill" });
				this.lastAction = "kill";

				const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
				this.state.lines[this.state.cursorLine] = currentLine + nextLine;
				this.state.lines.splice(this.state.cursorLine + 1, 1);
			}
		} else {
			this.pushUndoSnapshot();

			// Save lastAction before cursor movement (moveWordForwards resets it)
			// 按词移动前保存连续 kill 状态，避免移动辅助方法将其清除。
			const wasKill = this.lastAction === "kill";

			const oldCursorCol = this.state.cursorCol;
			this.moveWordForwards();
			const deleteTo = this.state.cursorCol;
			this.setCursorCol(oldCursorCol);

			const deletedText = currentLine.slice(this.state.cursorCol, deleteTo);
			this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
			this.lastAction = "kill";

			this.state.lines[this.state.cursorLine] =
				currentLine.slice(0, this.state.cursorCol) + currentLine.slice(deleteTo);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private handleForwardDelete(): void {
		this.exitHistoryBrowsing();
		this.lastAction = null;

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			this.pushUndoSnapshot();

			// Delete grapheme at cursor position (handles emojis, combining characters, etc.)
			// 删除光标处完整字素，避免拆分 emoji 或组合字符。
			const afterCursor = currentLine.slice(this.state.cursorCol);

			// Find the first grapheme at cursor
			// 使用标记感知分段取得光标后的第一个原子单元。
			const graphemes = [...this.segment(afterCursor, "grapheme")];
			const firstGrapheme = graphemes[0];
			const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;

			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol + graphemeLength);
			this.state.lines[this.state.cursorLine] = before + after;
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			this.pushUndoSnapshot();

			// At end of line - merge with next line
			// 行尾向前删除会移除换行并合并下一逻辑行。
			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// Update or re-trigger autocomplete after forward delete
		// 向前删除后同步刷新或重新触发当前补全上下文。
		if (this.autocompleteState) {
			this.updateAutocomplete();
		} else {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
			// Slash command context
			// 斜杠命令上下文重新请求建议。
			if (this.isInSlashCommandContext(textBeforeCursor)) {
				this.tryTriggerAutocomplete();
			}
			// Symbol-based completion context like @, #, or provider triggers
			// 符号触发上下文重新请求建议。
			else if (this.autocompleteTriggerPattern.test(textBeforeCursor)) {
				this.tryTriggerAutocomplete();
			}
		}
	}

	/**
	 * Build a mapping from visual lines to logical positions.
	 * Returns an array where each element represents a visual line with:
	 * - logicalLine: index into this.state.lines
	 * - startCol: starting column in the logical line
	 * - length: length of this visual line segment
	 */
	/** 构建视觉行到逻辑行列的映射，供换行后的上下移动、翻页和光标归属判断复用。 */
	private buildVisualLineMap(width: number): Array<{ logicalLine: number; startCol: number; length: number }> {
		const visualLines: Array<{ logicalLine: number; startCol: number; length: number }> = [];

		for (let i = 0; i < this.state.lines.length; i++) {
			const line = this.state.lines[i] || "";
			const lineVisWidth = visibleWidth(line);
			if (line.length === 0) {
				// Empty line still takes one visual line
				// 空逻辑行也占据一条视觉行，以便光标能够落入。
				visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
			} else if (lineVisWidth <= width) {
				visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
			} else {
				// Line needs wrapping - use word-aware wrapping
				// 超宽逻辑行按与渲染相同的词边界规则拆分。
				const chunks = wordWrapLine(line, width, [...this.segment(line, "grapheme")]);
				for (const chunk of chunks) {
					visualLines.push({
						logicalLine: i,
						startCol: chunk.startIndex,
						length: chunk.endIndex - chunk.startIndex,
					});
				}
			}
		}

		return visualLines;
	}

	/**
	 * Find the visual line index that contains the given logical position.
	 */
	/** 查找包含指定逻辑行列的视觉行索引。 */
	private findVisualLineAt(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
		line: number,
		col: number,
	): number {
		for (let i = 0; i < visualLines.length; i++) {
			const vl = visualLines[i];
			if (!vl || vl.logicalLine !== line) continue;
			const offset = col - vl.startCol;
			// Cursor is in this segment if it's within range. For the last
			// segment of a logical line, cursor can be at length (end position)
			// 普通块采用半开区间；逻辑行的最后一块额外接纳行尾位置。
			const isLastSegmentOfLine = i === visualLines.length - 1 || visualLines[i + 1]?.logicalLine !== vl.logicalLine;
			if (offset >= 0 && (offset < vl.length || (isLastSegmentOfLine && offset === vl.length))) {
				return i;
			}
		}
		return visualLines.length - 1;
	}

	/**
	 * Find the visual line index for the current cursor position.
	 */
	/** 查找当前光标所在的视觉行。 */
	private findCurrentVisualLine(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
	): number {
		return this.findVisualLineAt(visualLines, this.state.cursorLine, this.state.cursorCol);
	}

	private moveCursor(deltaLine: number, deltaCol: number): void {
		this.lastAction = null;
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);

		if (deltaLine !== 0) {
			const targetVisualLine = currentVisualLine + deltaLine;

			if (targetVisualLine >= 0 && targetVisualLine < visualLines.length) {
				this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
			}
		}

		if (deltaCol !== 0) {
			const currentLine = this.state.lines[this.state.cursorLine] || "";

			if (deltaCol > 0) {
				// Moving right - move by one grapheme (handles emojis, combining characters, etc.)
				// 向右按完整字素移动，避免进入 emoji 或组合字符内部。
				if (this.state.cursorCol < currentLine.length) {
					const afterCursor = currentLine.slice(this.state.cursorCol);
					const graphemes = [...this.segment(afterCursor, "grapheme")];
					const firstGrapheme = graphemes[0];
					this.setCursorCol(this.state.cursorCol + (firstGrapheme ? firstGrapheme.segment.length : 1));
				} else if (this.state.cursorLine < this.state.lines.length - 1) {
					// Wrap to start of next logical line
					// 在逻辑行尾继续向右时跳到下一逻辑行开头。
					this.state.cursorLine++;
					this.setCursorCol(0);
				} else {
					// At end of last line - can't move, but set preferredVisualCol for up/down navigation
					// 已到全文末尾时保持位置，但记录视觉列供随后上下移动使用。
					const currentVL = visualLines[currentVisualLine];
					if (currentVL) {
						this.preferredVisualCol = this.state.cursorCol - currentVL.startCol;
					}
				}
			} else {
				// Moving left - move by one grapheme (handles emojis, combining characters, etc.)
				// 向左同样以完整字素为步长。
				if (this.state.cursorCol > 0) {
					const beforeCursor = currentLine.slice(0, this.state.cursorCol);
					const graphemes = [...this.segment(beforeCursor, "grapheme")];
					const lastGrapheme = graphemes[graphemes.length - 1];
					this.setCursorCol(this.state.cursorCol - (lastGrapheme ? lastGrapheme.segment.length : 1));
				} else if (this.state.cursorLine > 0) {
					// Wrap to end of previous logical line
					// 在逻辑行首继续向左时跳到上一逻辑行末尾。
					this.state.cursorLine--;
					const prevLine = this.state.lines[this.state.cursorLine] || "";
					this.setCursorCol(prevLine.length);
				}
			}
		}

		// Keep an open autocomplete picker in sync with the new cursor
		// position: cursor movement changes the text before the cursor, so a
		// picker computed for the old position is stale. Re-query so it
		// refreshes — or closes when the new position yields no suggestions —
		// mirroring insertCharacter()/handleBackspace(). Without this, arrowing
		// left from `/cmd ` back into the command name leaves the argument
		// picker showing against a `/cmd` prefix (and a Tab there would
		// concatenate the stale suggestion onto the partial command name).
		// 光标移动会改变补全前缀，因此打开的列表必须重新请求；否则旧参数建议可能被错误应用到命令名中。
		if (this.autocompleteState) {
			this.updateAutocomplete();
		}
	}

	/**
	 * Scroll by a page (direction: -1 for up, 1 for down).
	 * Moves cursor by the page size while keeping it in bounds.
	 */
	/** 按可见编辑区高度翻页，并将光标限制在首尾视觉行之间。 */
	private pageScroll(direction: -1 | 1): void {
		this.lastAction = null;
		const terminalRows = this.tui.terminal.rows;
		const pageSize = Math.max(5, Math.floor(terminalRows * 0.3));

		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		const targetVisualLine = Math.max(0, Math.min(visualLines.length - 1, currentVisualLine + direction * pageSize));

		this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
	}

	private moveWordBackwards(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at start of line, move to end of previous line
		// 逻辑行首向后按词移动会跳到上一逻辑行末尾。
		if (this.state.cursorCol === 0) {
			if (this.state.cursorLine > 0) {
				this.state.cursorLine--;
				const prevLine = this.state.lines[this.state.cursorLine] || "";
				this.setCursorCol(prevLine.length);
			}
			return;
		}

		this.setCursorCol(
			findWordBackward(currentLine, this.state.cursorCol, {
				segment: (text) => this.segment(text, "word"),
				isAtomicSegment: isPasteMarker,
			}),
		);
	}

	/**
	 * Yank (paste) the most recent kill ring entry at cursor position.
	 */
	/** 在光标处插入 kill ring 中最近一次删除的内容。 */
	private yank(): void {
		if (this.killRing.length === 0) return;

		this.pushUndoSnapshot();

		const text = this.killRing.peek()!;
		this.insertYankedText(text);

		this.lastAction = "yank";
	}

	/**
	 * Cycle through kill ring (only works immediately after yank or yank-pop).
	 * Replaces the last yanked text with the previous entry in the ring.
	 */
	/** 仅在 yank 后轮换 kill ring，并用上一项替换刚插入的内容。 */
	private yankPop(): void {
		// Only works if we just yanked and have more than one entry
		// 只有紧接 yank 且 ring 中存在多个候选时才可轮换。
		if (this.lastAction !== "yank" || this.killRing.length <= 1) return;

		this.pushUndoSnapshot();

		// Delete the previously yanked text (still at end of ring before rotation)
		// 轮换前先依据当前 ring 末项删除刚才插入的文本。
		this.deleteYankedText();

		// Rotate the ring: move end to front
		// 旋转 ring，使前一个历史项成为新的最近项。
		this.killRing.rotate();

		// Insert the new most recent entry (now at end after rotation)
		// 插入旋转后的最近项。
		const text = this.killRing.peek()!;
		this.insertYankedText(text);

		this.lastAction = "yank";
	}

	/**
	 * Insert text at cursor position (used by yank operations).
	 */
	/** yank 专用插入实现，正确处理单行与跨行文本的光标位置。 */
	private insertYankedText(text: string): void {
		this.exitHistoryBrowsing();
		const lines = text.split("\n");

		if (lines.length === 1) {
			// Single line - insert at cursor
			// 单行内容直接拼接到当前光标处。
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol);
			this.state.lines[this.state.cursorLine] = before + text + after;
			this.setCursorCol(this.state.cursorCol + text.length);
		} else {
			// Multi-line insert
			// 多行内容拆分当前逻辑行，并插入中间各行。
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol);

			// First line merges with text before cursor
			// 首行与光标前文本合并。
			this.state.lines[this.state.cursorLine] = before + (lines[0] || "");

			// Insert middle lines
			// 中间行按原顺序插入。
			for (let i = 1; i < lines.length - 1; i++) {
				this.state.lines.splice(this.state.cursorLine + i, 0, lines[i] || "");
			}

			// Last line merges with text after cursor
			// 末行与光标后文本合并。
			const lastLineIndex = this.state.cursorLine + lines.length - 1;
			this.state.lines.splice(lastLineIndex, 0, (lines[lines.length - 1] || "") + after);

			// Update cursor position
			// 光标落在插入文本末尾、原后缀之前。
			this.state.cursorLine = lastLineIndex;
			this.setCursorCol((lines[lines.length - 1] || "").length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * Delete the previously yanked text (used by yank-pop).
	 * The yanked text is derived from killRing[end] since it hasn't been rotated yet.
	 */
	/** 删除最近一次 yank 插入的文本；轮换前该文本仍对应 kill ring 的末项。 */
	private deleteYankedText(): void {
		const yankedText = this.killRing.peek();
		if (!yankedText) return;

		const yankLines = yankedText.split("\n");

		if (yankLines.length === 1) {
			// Single line - delete backward from cursor
			// 单行 yank 从当前光标向后删除相同长度。
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const deleteLen = yankedText.length;
			const before = currentLine.slice(0, this.state.cursorCol - deleteLen);
			const after = currentLine.slice(this.state.cursorCol);
			this.state.lines[this.state.cursorLine] = before + after;
			this.setCursorCol(this.state.cursorCol - deleteLen);
		} else {
			// Multi-line delete - cursor is at end of last yanked line
			// 多行 yank 后光标位于插入末行末尾，据此反推起始行列。
			const startLine = this.state.cursorLine - (yankLines.length - 1);
			const startCol = (this.state.lines[startLine] || "").length - (yankLines[0] || "").length;

			// Get text after cursor on current line
			// 保留当前光标后的原始后缀。
			const afterCursor = (this.state.lines[this.state.cursorLine] || "").slice(this.state.cursorCol);

			// Get text before yank start position
			// 保留 yank 起点之前的原始前缀。
			const beforeYank = (this.state.lines[startLine] || "").slice(0, startCol);

			// Remove all lines from startLine to cursorLine and replace with merged line
			// 删除 yank 覆盖的所有逻辑行，并把前后原文重新合并为一行。
			this.state.lines.splice(startLine, yankLines.length, beforeYank + afterCursor);

			// Update cursor
			// 光标恢复到 yank 开始位置。
			this.state.cursorLine = startLine;
			this.setCursorCol(startCol);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private pushUndoSnapshot(): void {
		this.undoStack.push(this.state);
	}

	private undo(): void {
		this.exitHistoryBrowsing();
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		Object.assign(this.state, snapshot);
		this.lastAction = null;
		this.preferredVisualCol = null;
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * Jump to the first occurrence of a character in the specified direction.
	 * Multi-line search. Case-sensitive. Skips the current cursor position.
	 */
	/** 按指定方向跨逻辑行查找首个字符匹配，区分大小写并跳过当前光标位置。 */
	private jumpToChar(char: string, direction: "forward" | "backward"): void {
		this.lastAction = null;
		const isForward = direction === "forward";
		const lines = this.state.lines;

		const end = isForward ? lines.length : -1;
		const step = isForward ? 1 : -1;

		for (let lineIdx = this.state.cursorLine; lineIdx !== end; lineIdx += step) {
			const line = lines[lineIdx] || "";
			const isCurrentLine = lineIdx === this.state.cursorLine;

			// Current line: start after/before cursor; other lines: search full line
			// 当前行从光标后一位或前一位开始，其他逻辑行则搜索整行。
			const searchFrom = isCurrentLine
				? isForward
					? this.state.cursorCol + 1
					: this.state.cursorCol - 1
				: undefined;

			const idx = isForward ? line.indexOf(char, searchFrom) : line.lastIndexOf(char, searchFrom);

			if (idx !== -1) {
				this.state.cursorLine = lineIdx;
				this.setCursorCol(idx);
				return;
			}
		}
		// No match found - cursor stays in place
		// 未找到匹配时保持光标位置不变。
	}

	private moveWordForwards(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at end of line, move to start of next line
		// 逻辑行尾向前按词移动会跳到下一逻辑行开头。
		if (this.state.cursorCol >= currentLine.length) {
			if (this.state.cursorLine < this.state.lines.length - 1) {
				this.state.cursorLine++;
				this.setCursorCol(0);
			}
			return;
		}

		this.setCursorCol(
			findWordForward(currentLine, this.state.cursorCol, {
				segment: (text) => this.segment(text, "word"),
				isAtomicSegment: isPasteMarker,
			}),
		);
	}

	// Slash menu only allowed on the first line of the editor
	// 斜杠菜单只允许在编辑器第一逻辑行中出现。
	private isSlashMenuAllowed(): boolean {
		return this.state.cursorLine === 0;
	}

	// Helper method to check if cursor is at start of message (for slash command detection)
	// 判断光标是否位于消息起始区域，用于识别斜杠命令触发条件。
	private isAtStartOfMessage(): boolean {
		if (!this.isSlashMenuAllowed()) return false;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
	}

	private isInSlashCommandContext(textBeforeCursor: string): boolean {
		return this.isSlashMenuAllowed() && textBeforeCursor.trimStart().startsWith("/");
	}

	// Autocomplete methods
	// 以下方法负责自动补全的触发、异步请求串行化、过期结果丢弃和 UI 状态维护。
	/**
	 * Find the best autocomplete item index for the given prefix.
	 * Returns -1 if no match is found.
	 *
	 * Match priority:
	 * 1. Exact match (prefix === item.value) -> always selected
	 * 2. Prefix match -> first item whose value starts with prefix
	 * 3. No match -> -1 (keep default highlight)
	 *
	 * Matching is case-sensitive and checks item.value only.
	 */
	/** 按精确匹配、前缀匹配的优先级选择最佳建议，仅比较区分大小写的 item.value。 */
	private getBestAutocompleteMatchIndex(items: Array<{ value: string; label: string }>, prefix: string): number {
		if (!prefix) return -1;

		let firstPrefixIndex = -1;

		for (let i = 0; i < items.length; i++) {
			const value = items[i]!.value;
			if (value === prefix) {
				return i; // Exact match always wins
				// 精确匹配始终优先于此前发现的前缀匹配。
			}
			if (firstPrefixIndex === -1 && value.startsWith(prefix)) {
				firstPrefixIndex = i;
			}
		}

		return firstPrefixIndex;
	}

	private createAutocompleteList(
		prefix: string,
		items: Array<{ value: string; label: string; description?: string }>,
	): SelectList {
		const layout = prefix.startsWith("/") ? SLASH_COMMAND_SELECT_LIST_LAYOUT : undefined;
		return new SelectList(items, this.autocompleteMaxVisible, this.theme.selectList, layout);
	}

	private tryTriggerAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: false, explicitTab });
	}

	private handleTabCompletion(): void {
		if (!this.autocompleteProvider) return;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);

		if (this.isInSlashCommandContext(beforeCursor) && !beforeCursor.trimStart().includes(" ")) {
			this.handleSlashCommandCompletion();
		} else {
			this.forceFileAutocomplete(true);
		}
	}

	private handleSlashCommandCompletion(): void {
		this.requestAutocomplete({ force: false, explicitTab: true });
	}

	private forceFileAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: true, explicitTab });
	}

	private requestAutocomplete(options: { force: boolean; explicitTab: boolean }): void {
		if (!this.autocompleteProvider) return;

		if (options.force) {
			const shouldTrigger =
				!this.autocompleteProvider.shouldTriggerFileCompletion ||
				this.autocompleteProvider.shouldTriggerFileCompletion(
					this.state.lines,
					this.state.cursorLine,
					this.state.cursorCol,
				);
			if (!shouldTrigger) {
				return;
			}
		}

		this.cancelAutocompleteRequest();
		const startToken = ++this.autocompleteStartToken;

		const debounceMs = this.getAutocompleteDebounceMs(options);
		if (debounceMs > 0) {
			this.autocompleteDebounceTimer = setTimeout(() => {
				this.autocompleteDebounceTimer = undefined;
				void this.startAutocompleteRequest(startToken, options);
			}, debounceMs);
			return;
		}

		void this.startAutocompleteRequest(startToken, options);
	}

	private async startAutocompleteRequest(
		startToken: number,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void> {
		const previousTask = this.autocompleteRequestTask;
		this.autocompleteRequestTask = (async () => {
			await previousTask;
			if (startToken !== this.autocompleteStartToken || !this.autocompleteProvider) {
				return;
			}

			const controller = new AbortController();
			this.autocompleteAbort = controller;
			const requestId = ++this.autocompleteRequestId;
			const snapshotText = this.getText();
			const snapshotLine = this.state.cursorLine;
			const snapshotCol = this.state.cursorCol;

			await this.runAutocompleteRequest(requestId, controller, snapshotText, snapshotLine, snapshotCol, options);
		})();
		await this.autocompleteRequestTask;
	}

	private setAutocompleteTriggerCharacters(triggerCharacters: string[]): void {
		const next = [...DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS];
		for (const character of triggerCharacters) {
			if (character.length !== 1 || character === "/" || isWhitespaceChar(character) || next.includes(character)) {
				continue;
			}
			next.push(character);
		}
		this.autocompleteTriggerCharacters = next;
		this.autocompleteTriggerPattern = buildTriggerPattern(next);
		this.autocompleteDebouncePattern = buildDebouncePattern(next);
	}

	private getAutocompleteDebounceMs(options: { force: boolean; explicitTab: boolean }): number {
		if (options.explicitTab || options.force) {
			return 0;
		}

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
		return this.autocompleteDebouncePattern.test(textBeforeCursor) ? ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS : 0;
	}

	private async runAutocompleteRequest(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void> {
		if (!this.autocompleteProvider) return;

		const suggestions = await this.autocompleteProvider.getSuggestions(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
			{ signal: controller.signal, force: options.force },
		);

		if (!this.isAutocompleteRequestCurrent(requestId, controller, snapshotText, snapshotLine, snapshotCol)) {
			return;
		}

		this.autocompleteAbort = undefined;

		if (!suggestions || !Array.isArray(suggestions.items) || suggestions.items.length === 0) {
			this.cancelAutocomplete();
			this.tui.requestRender();
			return;
		}

		if (options.force && options.explicitTab && suggestions.items.length === 1) {
			const item = suggestions.items[0]!;
			this.pushUndoSnapshot();
			this.lastAction = null;
			const result = this.autocompleteProvider.applyCompletion(
				this.state.lines,
				this.state.cursorLine,
				this.state.cursorCol,
				item,
				suggestions.prefix,
			);
			this.state.lines = result.lines;
			this.state.cursorLine = result.cursorLine;
			this.setCursorCol(result.cursorCol);
			if (this.onChange) this.onChange(this.getText());
			this.tui.requestRender();
			return;
		}

		this.applyAutocompleteSuggestions(suggestions, options.force ? "force" : "regular");
		this.tui.requestRender();
	}

	private isAutocompleteRequestCurrent(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
	): boolean {
		return (
			!controller.signal.aborted &&
			requestId === this.autocompleteRequestId &&
			this.getText() === snapshotText &&
			this.state.cursorLine === snapshotLine &&
			this.state.cursorCol === snapshotCol
		);
	}

	private applyAutocompleteSuggestions(suggestions: AutocompleteSuggestions, state: "regular" | "force"): void {
		this.autocompletePrefix = suggestions.prefix;
		this.autocompleteList = this.createAutocompleteList(suggestions.prefix, suggestions.items);

		const bestMatchIndex = this.getBestAutocompleteMatchIndex(suggestions.items, suggestions.prefix);
		if (bestMatchIndex >= 0) {
			this.autocompleteList.setSelectedIndex(bestMatchIndex);
		}

		this.autocompleteState = state;
	}

	private cancelAutocompleteRequest(): void {
		this.autocompleteStartToken += 1;
		if (this.autocompleteDebounceTimer) {
			clearTimeout(this.autocompleteDebounceTimer);
			this.autocompleteDebounceTimer = undefined;
		}
		this.autocompleteAbort?.abort();
		this.autocompleteAbort = undefined;
	}

	private clearAutocompleteUi(): void {
		this.autocompleteState = null;
		this.autocompleteList = undefined;
		this.autocompletePrefix = "";
	}

	private cancelAutocomplete(): void {
		this.cancelAutocompleteRequest();
		this.clearAutocompleteUi();
	}

	public isShowingAutocomplete(): boolean {
		return this.autocompleteState !== null;
	}

	private updateAutocomplete(): void {
		if (!this.autocompleteState || !this.autocompleteProvider) return;
		this.requestAutocomplete({ force: this.autocompleteState === "force", explicitTab: false });
	}
}
