import { Box, Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 * 使用用户消息背景和 Markdown 规则渲染输入内容的组件。
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;

	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		// padding 改变 Box 结构，需要重建子树而非只请求现有组件重绘。
		this.outputPad = padding;
		this.rebuild();
	}

	private rebuild(): void {
		// 重建前清空旧 Box，确保多次设置 outputPad 不会叠加消息副本。
		this.clear();
		const contentBox = new Box(this.outputPad, 1, (content: string) => theme.bg("userMessageBg", content));
		// 保留有序列表标记和反斜杠转义，尽量按用户实际输入显示，而不是由 Markdown 规范化。
		contentBox.addChild(
			new Markdown(
				this.text,
				0,
				0,
				this.markdownTheme,
				{
					color: (content: string) => theme.fg("userMessageText", content),
				},
				{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
			),
		);
		this.addChild(contentBox);
	}

	override render(width: number): string[] {
		// 先由普通组件树完成宽度布局，再附加零宽 OSC 133 标记，避免控制序列参与换行计算。
		const lines = super.render(width);
		if (lines.length === 0) {
			// 空消息不产生不完整的语义区域标记。
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		// OSC 133 包围整条用户消息，供支持该协议的终端识别和导航语义区域。
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
