/**
 * ANSI escape code to HTML converter.
 *
 * Converts terminal ANSI color/style codes to HTML with inline styles.
 * Supports:
 * - Standard foreground colors (30-37) and bright variants (90-97)
 * - Standard background colors (40-47) and bright variants (100-107)
 * - 256-color palette (38;5;N and 48;5;N)
 * - RGB true color (38;2;R;G;B and 48;2;R;G;B)
 * - Text styles: bold (1), dim (2), italic (3), underline (4)
 * - Reset (0)
 *
 * 转换器维护与终端类似的累积 SGR 状态，并在状态变化处关闭/重开 HTML span；
 * 所有普通文本在写入 HTML 前统一转义。
 */

// Standard ANSI color palette (0-15)
const ANSI_COLORS = [
	"#000000", // 0: black
	"#800000", // 1: red
	"#008000", // 2: green
	"#808000", // 3: yellow
	"#000080", // 4: blue
	"#800080", // 5: magenta
	"#008080", // 6: cyan
	"#c0c0c0", // 7: white
	"#808080", // 8: bright black
	"#ff0000", // 9: bright red
	"#00ff00", // 10: bright green
	"#ffff00", // 11: bright yellow
	"#0000ff", // 12: bright blue
	"#ff00ff", // 13: bright magenta
	"#00ffff", // 14: bright cyan
	"#ffffff", // 15: bright white
];

/**
 * Convert 256-color index to hex.
 * 索引 0-15 复用标准色，16-231 映射 6×6×6 色立方，232-255 映射灰阶带。
 */
function color256ToHex(index: number): string {
	// Standard colors (0-15)
	if (index < 16) {
		return ANSI_COLORS[index];
	}

	// Color cube (16-231): 6x6x6 = 216 colors
	// xterm 色立方的非零分量从 95 开始、步长 40；零分量保持 0。
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toComponent = (n: number) => (n === 0 ? 0 : 55 + n * 40);
		const toHex = (n: number) => toComponent(n).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// Grayscale (232-255): 24 shades
	// 灰阶从 8 开始每级增加 10，三个 RGB 分量保持一致。
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * Escape HTML special characters.
 * 必须在拼接 span 之外只转义用户文本，避免 ANSI 转换生成的标签被再次编码或原文本注入 HTML。
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

interface TextStyle {
	fg: string | null;
	bg: string | null;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
}

function createEmptyStyle(): TextStyle {
	return {
		fg: null,
		bg: null,
		bold: false,
		dim: false,
		italic: false,
		underline: false,
	};
}

function styleToInlineCSS(style: TextStyle): string {
	const parts: string[] = [];
	if (style.fg) parts.push(`color:${style.fg}`);
	if (style.bg) parts.push(`background-color:${style.bg}`);
	if (style.bold) parts.push("font-weight:bold");
	if (style.dim) parts.push("opacity:0.6");
	if (style.italic) parts.push("font-style:italic");
	if (style.underline) parts.push("text-decoration:underline");
	return parts.join(";");
}

function hasStyle(style: TextStyle): boolean {
	return style.fg !== null || style.bg !== null || style.bold || style.dim || style.italic || style.underline;
}

/**
 * Parse ANSI SGR (Select Graphic Rendition) codes and update style.
 * 同一序列中的参数按顺序作用于可变状态；扩展颜色会消费后续参数，未知或不完整代码保持当前样式。
 */
function applySgrCode(params: number[], style: TextStyle): void {
	let i = 0;
	while (i < params.length) {
		const code = params[i];

		if (code === 0) {
			// Reset all
			// 完整 reset 清除前景、背景和所有文本属性，对应结束当前终端样式上下文。
			style.fg = null;
			style.bg = null;
			style.bold = false;
			style.dim = false;
			style.italic = false;
			style.underline = false;
		} else if (code === 1) {
			style.bold = true;
		} else if (code === 2) {
			style.dim = true;
		} else if (code === 3) {
			style.italic = true;
		} else if (code === 4) {
			style.underline = true;
		} else if (code === 22) {
			// Reset bold/dim
			// SGR 22 同时关闭 bold 与 dim，而不是恢复其他颜色或装饰。
			style.bold = false;
			style.dim = false;
		} else if (code === 23) {
			style.italic = false;
		} else if (code === 24) {
			style.underline = false;
		} else if (code >= 30 && code <= 37) {
			// Standard foreground colors
			style.fg = ANSI_COLORS[code - 30];
		} else if (code === 38) {
			// Extended foreground color
			// mode 5 后跟调色板索引；mode 2 后跟三个 RGB 分量，解析后需跳过被消费的参数。
			if (params[i + 1] === 5 && params.length > i + 2) {
				// 256-color: 38;5;N
				style.fg = color256ToHex(params[i + 2]);
				i += 2;
			} else if (params[i + 1] === 2 && params.length > i + 4) {
				// RGB: 38;2;R;G;B
				const r = params[i + 2];
				const g = params[i + 3];
				const b = params[i + 4];
				style.fg = `rgb(${r},${g},${b})`;
				i += 4;
			}
		} else if (code === 39) {
			// Default foreground
			style.fg = null;
		} else if (code >= 40 && code <= 47) {
			// Standard background colors
			style.bg = ANSI_COLORS[code - 40];
		} else if (code === 48) {
			// Extended background color
			// 背景扩展色与前景共享相同参数格式，只写入独立 bg 状态。
			if (params[i + 1] === 5 && params.length > i + 2) {
				// 256-color: 48;5;N
				style.bg = color256ToHex(params[i + 2]);
				i += 2;
			} else if (params[i + 1] === 2 && params.length > i + 4) {
				// RGB: 48;2;R;G;B
				const r = params[i + 2];
				const g = params[i + 3];
				const b = params[i + 4];
				style.bg = `rgb(${r},${g},${b})`;
				i += 4;
			}
		} else if (code === 49) {
			// Default background
			style.bg = null;
		} else if (code >= 90 && code <= 97) {
			// Bright foreground colors
			style.fg = ANSI_COLORS[code - 90 + 8];
		} else if (code >= 100 && code <= 107) {
			// Bright background colors
			style.bg = ANSI_COLORS[code - 100 + 8];
		}
		// Ignore unrecognized codes
		// 未支持的 SGR 属性不会终止转换，也不会隐式重置已识别状态。

		i++;
	}
}

// Match ANSI escape sequences: ESC[ followed by params and ending with 'm'
// 仅处理 SGR 的 m 终止序列；光标移动、OSC 等其他终端控制码不属于该 HTML 样式转换器。
const ANSI_REGEX = /\x1b\[([\d;]*)m/g;

/**
 * Convert ANSI-escaped text to HTML with inline styles.
 * 每遇到一个 SGR 序列先输出并转义之前的文本，再切换 span，使样式边界与终端状态变化严格对齐。
 */
export function ansiToHtml(text: string): string {
	const style = createEmptyStyle();
	let result = "";
	let lastIndex = 0;
	let inSpan = false;

	// Reset regex state
	// ANSI_REGEX 带全局标志并在调用间复用，必须重置 lastIndex 才能从新字符串开头扫描。
	ANSI_REGEX.lastIndex = 0;

	let match = ANSI_REGEX.exec(text);
	while (match !== null) {
		// Add text before this escape sequence
		// 控制序列本身不会进入结果，只有两次匹配之间的可见文本被转义后输出。
		const beforeText = text.slice(lastIndex, match.index);
		if (beforeText) {
			result += escapeHtml(beforeText);
		}

		// Parse SGR parameters
		// 空参数等价于 reset；单个空字段也按 0 处理，匹配终端 SGR 的默认语义。
		const paramStr = match[1];
		const params = paramStr ? paramStr.split(";").map((p) => parseInt(p, 10) || 0) : [0];

		// Close existing span if we have one
		// CSS span 不支持原位修改属性，状态变化前先闭合当前范围，再按新状态创建 span。
		if (inSpan) {
			result += "</span>";
			inSpan = false;
		}

		// Apply the codes
		applySgrCode(params, style);

		// Open new span if we have any styling
		// reset 后无活动样式时直接输出裸文本，避免产生无意义的空 style span。
		if (hasStyle(style)) {
			result += `<span style="${styleToInlineCSS(style)}">`;
			inSpan = true;
		}

		lastIndex = match.index + match[0].length;
		match = ANSI_REGEX.exec(text);
	}

	// Add remaining text
	// 最后一个 SGR 之后的尾部文本仍继承当前 style span，并同样经过 HTML 转义。
	const remainingText = text.slice(lastIndex);
	if (remainingText) {
		result += escapeHtml(remainingText);
	}

	// Close any open span
	if (inSpan) {
		result += "</span>";
	}

	return result;
}

/**
 * Convert array of ANSI-escaped lines to HTML.
 * Each line is wrapped in a div element.
 * 空行使用不换行空格保留可见行高，避免浏览器折叠空 div 导致终端布局变形。
 */
export function ansiLinesToHtml(lines: string[]): string {
	return lines.map((line) => `<div class="ansi-line">${ansiToHtml(line) || "&nbsp;"}</div>`).join("");
}
