import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

/**
 * Text component that truncates to fit viewport width
 * 将文本截断到视口宽度以内的文本组件
 */
export class TruncatedText implements Component {
	private text: string;
	private paddingX: number;
	private paddingY: number;

	constructor(text: string, paddingX: number = 0, paddingY: number = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	invalidate(): void {
		// No cached state to invalidate currently
		// 当前没有需要失效的缓存状态
	}

	render(width: number): string[] {
		const result: string[] = [];

		// Empty line padded to width
		// 填充到指定宽度的空行
		const emptyLine = " ".repeat(width);

		// Add vertical padding above
		// 添加上方垂直内边距
		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		// Calculate available width after horizontal padding
		// 计算扣除水平内边距后的可用宽度
		const availableWidth = Math.max(1, width - this.paddingX * 2);

		// Take only the first line (stop at newline)
		// 仅取第一行（遇到换行符即停止）
		let singleLineText = this.text;
		const newlineIndex = this.text.indexOf("\n");
		if (newlineIndex !== -1) {
			singleLineText = this.text.substring(0, newlineIndex);
		}

		// Truncate text if needed (accounting for ANSI codes)
		// 必要时截断文本，并将 ANSI 控制码纳入计算
		const displayText = truncateToWidth(singleLineText, availableWidth);

		// Add horizontal padding
		// 添加水平内边距
		const leftPadding = " ".repeat(this.paddingX);
		const rightPadding = " ".repeat(this.paddingX);
		const lineWithPadding = leftPadding + displayText + rightPadding;

		// Pad line to exactly width characters
		// 将该行精确填充到指定宽度
		const lineVisibleWidth = visibleWidth(lineWithPadding);
		const paddingNeeded = Math.max(0, width - lineVisibleWidth);
		const finalLine = lineWithPadding + " ".repeat(paddingNeeded);

		result.push(finalLine);

		// Add vertical padding below
		// 添加下方垂直内边距
		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		return result;
	}
}
