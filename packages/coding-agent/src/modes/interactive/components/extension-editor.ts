/**
 * Multi-line editor component for extensions.
 * 用于编辑扩展内容的多行编辑器组件。
 * Supports Ctrl+G for external editor.
 * 支持通过 Ctrl+G 切换到外部编辑器。
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	Container,
	Editor,
	type EditorOptions,
	type Focusable,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { getEditorTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

export class ExtensionEditorComponent extends Container implements Focusable {
	private editor: Editor;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private keybindings: KeybindingsManager;
	private externalEditorCommand: string | undefined;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		// 容器获得或失去焦点时同步内部 Editor，确保光标和按键处理状态一致。
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		tui: TUI,
		keybindings: KeybindingsManager,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: EditorOptions,
		externalEditorCommand?: string,
	) {
		super();

		this.tui = tui;
		this.keybindings = keybindings;
		this.externalEditorCommand = externalEditorCommand;
		// 组件只负责采集文本；具体资源来源、作用域及保存/删除策略由提交回调的所有者处理。
		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add title
		this.addChild(new Text(theme.fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));

		// Create editor
		// 创建使用交互模式主题和调用方选项的内部编辑器。
		this.editor = new Editor(tui, getEditorTheme(), options);
		if (prefill) {
			this.editor.setText(prefill);
		}
		// Wire up Enter to submit (Shift+Enter for newlines, like the main editor)
		// 与主编辑器保持一致：Enter 提交完整内容，Shift+Enter 插入换行。
		this.editor.onSubmit = (text: string) => {
			this.onSubmitCallback(text);
		};
		this.addChild(this.editor);

		this.addChild(new Spacer(1));

		// Add hint
		// 提示文本由当前可配置键绑定生成；仅在存在外部编辑器命令时展示对应操作。
		const hasExternalEditor = !!this.getExternalEditorCommand();
		const hint =
			keyHint("tui.select.confirm", "submit") +
			"  " +
			keyHint("tui.input.newLine", "newline") +
			"  " +
			keyHint("tui.select.cancel", "cancel") +
			(hasExternalEditor ? `  ${keyHint("app.editor.external", "external editor")}` : "");
		this.addChild(new Text(hint, 1, 0));

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Escape or Ctrl+C to cancel
		// 取消键优先于正文编辑处理，避免 Escape/Ctrl+C 被内部 Editor 吞掉。
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}

		// External editor (app keybinding)
		// 外部编辑器使用应用级可配置键绑定，而非在组件中硬编码按键。
		if (this.keybindings.matches(keyData, "app.editor.external")) {
			this.openExternalEditor();
			return;
		}

		// Forward to editor
		// 未被组件级操作消费的输入全部转交内部 Editor。
		this.editor.handleInput(keyData);
	}

	private getExternalEditorCommand(): string | undefined {
		// 命令优先级为显式设置、VISUAL、EDITOR，最后回退到平台默认编辑器。
		const editorCmd = this.externalEditorCommand || process.env.VISUAL || process.env.EDITOR;
		if (editorCmd) {
			return editorCmd;
		}
		return process.platform === "win32" ? "notepad" : "nano";
	}

	private async openExternalEditor(): Promise<void> {
		const editorCmd = this.getExternalEditorCommand();
		if (!editorCmd) {
			return;
		}

		const currentText = this.editor.getText();
		// 临时 Markdown 文件是 TUI 编辑状态与外部进程之间的交换边界。
		const tmpFile = path.join(os.tmpdir(), `pi-extension-editor-${Date.now()}.md`);

		try {
			fs.writeFileSync(tmpFile, currentText, "utf-8");
			// 外部编辑器接管终端前暂停 TUI，释放 stdin 和备用屏幕控制权。
			this.tui.stop();

			const [editor, ...editorArgs] = editorCmd.split(" ");
			process.stdout.write(`Launching external editor: ${editorCmd}\nPi will resume when the editor exits.\n`);

			// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
			// Node/libuv's console input read active after tui.stop() pauses stdin, racing
			// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
			// 不要改用 spawnSync：Windows 上同步子进程会在 tui.stop() 暂停 stdin 后仍保留
			// Node/libuv 的控制台读取，与 vim/nvim 争抢输入缓冲区，直到 Ctrl+C 取消挂起读取。
			const status = await new Promise<number | null>((resolve) => {
				const child = spawn(editor, [...editorArgs, tmpFile], {
					stdio: "inherit",
					shell: process.platform === "win32",
				});
				child.on("error", () => resolve(null));
				child.on("close", (code) => resolve(code));
			});

			if (status === 0) {
				// 只有编辑器正常退出才把文件内容写回组件；失败或无法启动时保留原文本。
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
		} finally {
			// 无论启动、编辑或读取是否成功，都清理临时文件并恢复 TUI 生命周期。
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
				// 临时文件清理失败不应阻止终端界面恢复。
			}
			this.tui.start();
			// Force full re-render since external editor uses alternate screen
			// 外部编辑器可能使用备用屏幕，返回后必须全量重绘以刷新边框、文本、焦点和光标状态。
			this.tui.requestRender(true);
		}
	}
}
