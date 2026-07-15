import type { AutocompleteProvider } from "./autocomplete.ts";
import type { Component } from "./tui.ts";

/**
 * Interface for custom editor components.
 *
 * This allows extensions to provide their own editor implementation
 * (e.g., vim mode, emacs mode, custom keybindings) while maintaining
 * compatibility with the core application.
 */
/**
 * 自定义编辑器组件契约，使扩展可替换编辑模式和按键行为，同时继续接入核心渲染、输入与提交流程。
 * 实现仍需满足 Component 的渲染和失效接口；需要硬件光标定位时可额外实现 Focusable 约定。
 */
export interface EditorComponent extends Component {
	// =========================================================================
	// Core text access (required)
	// 核心文本访问能力（必需）
	// =========================================================================

	/** Get the current text content */
	/** 返回当前编辑器文本。 */
	getText(): string;

	/** Set the text content */
	/** 整体替换编辑器文本，并由实现维护相应光标和渲染状态。 */
	setText(text: string): void;

	/** Handle raw terminal input (key presses, paste sequences, etc.) */
	/** 处理终端原始输入，包括按键和粘贴序列等。 */
	handleInput(data: string): void;

	// =========================================================================
	// Callbacks (required)
	// 核心应用使用的回调插槽（接口字段必需，实现可在事件发生时调用）
	// =========================================================================

	/** Called when user submits (e.g., Enter key) */
	/** 用户触发提交时调用，并传出最终文本。 */
	onSubmit?: (text: string) => void;

	/** Called when text changes */
	/** 文本发生变化时调用，使上层同步编辑状态和重绘。 */
	onChange?: (text: string) => void;

	// =========================================================================
	// History support (optional)
	// 历史记录支持（可选）
	// =========================================================================

	/** Add text to history for up/down navigation */
	/** 将文本加入上下键导航使用的历史记录。 */
	addToHistory?(text: string): void;

	// =========================================================================
	// Advanced text manipulation (optional)
	// 高级文本操作（可选）
	// =========================================================================

	/** Insert text at current cursor position */
	/** 在当前光标处插入文本，并由实现保持撤销和回调语义。 */
	insertTextAtCursor?(text: string): void;

	/**
	 * Get text with any markers expanded (e.g., paste markers).
	 * Falls back to getText() if not implemented.
	 */
	/** 返回展开粘贴标记等内部占位符后的文本；未实现时上层回退到 getText()。 */
	getExpandedText?(): string;

	// =========================================================================
	// Autocomplete support (optional)
	// 自动补全支持（可选）
	// =========================================================================

	/** Set the autocomplete provider */
	/** 注入自动补全提供方，由编辑器负责触发、展示和应用候选。 */
	setAutocompleteProvider?(provider: AutocompleteProvider): void;

	// =========================================================================
	// Appearance (optional)
	// 外观配置（可选）
	// =========================================================================

	/** Border color function */
	/** 边框着色函数，可由主题在运行时替换。 */
	borderColor?: (str: string) => string;

	/** Set horizontal padding */
	/** 设置编辑区域的水平内边距。 */
	setPaddingX?(padding: number): void;

	/** Set max visible items in autocomplete dropdown */
	/** 设置自动补全下拉列表的最大可见项数。 */
	setAutocompleteMaxVisible?(maxVisible: number): void;
}
