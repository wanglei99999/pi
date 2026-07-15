/**
 * Shared utility for truncating text to visual lines (accounting for line wrapping).
 * Used by both tool-execution.ts and bash-execution.ts for consistent behavior.
 */
/**
 * 共享的视觉行尾部截断工具，通过 Text 的真实渲染复用 ANSI、宽字符和字素安全换行规则。
 */

import { Text } from "@earendil-works/pi-tui";

export interface VisualTruncateResult {
	/** The visual lines to display */
	/** 最终需要显示的视觉行。 */
	visualLines: string[];
	/** Number of visual lines that were skipped (hidden) */
	/** 从开头跳过并隐藏的视觉行数量。 */
	skippedCount: number;
}

/**
 * Truncate text to a maximum number of visual lines (from the end).
 * This accounts for line wrapping based on terminal width.
 *
 * @param text - The text content (may contain newlines)
 * @param maxVisualLines - Maximum number of visual lines to show
 * @param width - Terminal/render width
 * @param paddingX - Horizontal padding for Text component (default 0).
 *                   Use 0 when result will be placed in a Box (Box adds its own padding).
 *                   Use 1 when result will be placed in a plain Container.
 * @returns The truncated visual lines and count of skipped lines
 */
/** 按终端宽度和水平内边距计算视觉行，并从末尾保留指定数量。 */
export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX: number = 0,
): VisualTruncateResult {
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}

	// Create a temporary Text component to render and get visual lines
	// 使用临时 Text 组件执行与正式界面相同的 ANSI 感知换行，避免自行按字符串长度截断。
	const tempText = new Text(text, paddingX, 0);
	const allVisualLines = tempText.render(width);

	if (allVisualLines.length <= maxVisualLines) {
		return { visualLines: allVisualLines, skippedCount: 0 };
	}

	// Take the last N visual lines
	// 输出类内容优先保留最新尾部视觉行，并记录被隐藏的前部行数。
	const truncatedLines = allVisualLines.slice(-maxVisualLines);
	const skippedCount = allVisualLines.length - maxVisualLines;

	return { visualLines: truncatedLines, skippedCount };
}
