import { Editor, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
/**
 * 在基础 Editor 上增加 coding-agent 应用级快捷键分派。
 * 文本状态、提交/变更回调、Focusable 光标和自动补全契约仍由父类实现。
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	// 特殊动作处理器可由当前交互模式或扩展动态替换。
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	/** 扩展注册快捷键的入口；返回 true 表示输入已被消费。 */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	/**
	 * Register a handler for an app action.
	 */
	/** 为可配置应用动作注册处理器。 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		// 扩展快捷键优先级最高，命中后不再进入内置编辑器处理。
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for clipboard paste keybinding
		// 图片粘贴是应用动作，由外层把剪贴板内容转换为编辑器插入标记。
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first
		// 应用级键位在父类文本编辑键位之前匹配。

		// Escape/interrupt - only if autocomplete is NOT active
		// 自动补全打开时 Escape 必须留给父类取消列表，否则才触发应用中断。
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				// 优先使用当前动态处理器，未设置时回退到动作映射。
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			// 补全激活或无中断处理器时交回父类处理 Escape。
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		// 只有编辑器为空时退出键才关闭应用，避免覆盖非空文本中的向前删除语义。
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
			// 非空时继续向下并最终由父类按 delete-char-forward 处理。
		}

		// Check all other app actions
		// 其余应用动作遍历注册映射，interrupt 和 exit 已由专用分支处理。
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		// 未消费输入回退到父类，保留普通输入、提交、焦点、补全和变更回调行为。
		super.handleInput(data);
	}
}
