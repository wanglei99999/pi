import { Box, Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Component that renders a skill invocation message with collapsed/expanded state.
 * 以折叠/展开两种状态渲染技能调用消息的组件。
 * Uses same background color as custom messages for visual consistency.
 * 使用与自定义消息相同的背景色，保持对话中的视觉层级一致。
 * Only renders the skill block itself - user message is rendered separately.
 * 这里只渲染已解析的技能块；附加的用户消息由外层消息组件单独展示，避免重复内容。
 */
export class SkillInvocationMessageComponent extends Box {
	private expanded = false;
	private skillBlock: ParsedSkillBlock;
	private markdownTheme: MarkdownTheme;

	constructor(skillBlock: ParsedSkillBlock, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.skillBlock = skillBlock;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		// 状态切换时重建子组件，使 Markdown 正文与单行摘要不会同时残留。
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		// 主题变化会使已有颜色失效，因此在 Box 缓存失效后同步重建显示内容。
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		// 每次更新先清空旧子组件，确保重复 invalidate 或切换状态保持幂等。
		this.clear();

		if (this.expanded) {
			// Expanded: label + skill name header + full content
			// 展开态显示标签、技能名标题和完整 Markdown 内容。
			const label = theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m`);
			this.addChild(new Text(label, 0, 0));
			const header = `**${this.skillBlock.name}**\n\n`;
			this.addChild(
				new Markdown(header + this.skillBlock.content, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			// Collapsed: single line - [skill] name (hint to expand)
			// 折叠态仅显示单行技能名和当前可配置的展开键提示。
			const line =
				theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
				theme.fg("customMessageText", this.skillBlock.name) +
				theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
			this.addChild(new Text(line, 0, 0));
		}
	}
}
