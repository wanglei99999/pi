export interface RgbColor {
	// Parsed colors are normalized to 8-bit channels regardless of the terminal response precision.
	// 无论终端响应使用何种精度，解析后的颜色都归一化为 8 位通道。
	r: number;
	g: number;
	b: number;
}

export type TerminalColorScheme = "dark" | "light";

function hexToRgb(hex: string): RgbColor {
	// Callers validate the supported fixed-width form before this helper slices the three channels.
	// 调用方会先校验支持的固定宽度格式，再由此函数切分三个通道。
	const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
	const r = parseInt(normalized.slice(0, 2), 16);
	const g = parseInt(normalized.slice(2, 4), 16);
	const b = parseInt(normalized.slice(4, 6), 16);
	return { r, g, b };
}

function parseOscHexChannel(channel: string): number | undefined {
	// OSC rgb channels may use variable-width hex; scale the full range to 0..255 instead of truncating digits.
	// OSC rgb 通道可使用不同位数的十六进制；应按完整范围缩放到 0..255，而不是截断数字。
	if (!/^[0-9a-f]+$/i.test(channel)) {
		return undefined;
	}
	const max = 16 ** channel.length - 1;
	if (max <= 0) {
		return undefined;
	}
	return Math.round((parseInt(channel, 16) / max) * 255);
}

const OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN = /^\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)$/i;
const COLOR_SCHEME_REPORT_PATTERN = /^\x1b\[\?997;(1|2)n$/;
// These parsers consume explicit terminal replies only; environment-based color preference and fallback belong to callers.
// 这些解析器只处理终端显式回复；基于环境的颜色偏好与降级优先级由调用方负责。

export function isOsc11BackgroundColorResponse(data: string): boolean {
	// Recognition checks framing only; parseOsc11BackgroundColor performs payload validation and conversion.
	// 此处只识别消息帧；payload 校验和颜色转换由 parseOsc11BackgroundColor 完成。
	return OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN.test(data);
}

export function parseOsc11BackgroundColor(data: string): RgbColor | undefined {
	// OSC 11 replies may terminate with BEL or ST and may encode colors as fixed hex or slash-separated rgb values.
	// OSC 11 回复可由 BEL 或 ST 结束，并可使用固定十六进制或斜杠分隔的 rgb 值。
	const match = data.match(OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN);
	if (!match) {
		return undefined;
	}

	const value = match[1].trim();
	if (value.startsWith("#")) {
		// Accept both 8-bit #RRGGBB and 16-bit-per-channel #RRRRGGGGBBBB responses.
		// 同时接受 8 位 #RRGGBB 和每通道 16 位的 #RRRRGGGGBBBB 响应。
		const hex = value.slice(1);
		if (/^[0-9a-f]{6}$/i.test(hex)) {
			return hexToRgb(value);
		}
		if (/^[0-9a-f]{12}$/i.test(hex)) {
			const r = parseOscHexChannel(hex.slice(0, 4));
			const g = parseOscHexChannel(hex.slice(4, 8));
			const b = parseOscHexChannel(hex.slice(8, 12));
			return r !== undefined && g !== undefined && b !== undefined ? { r, g, b } : undefined;
		}
		return undefined;
	}

	const rgbValue = value.replace(/^rgba?:/i, "");
	// rgb:/rgba: forms share the first three slash-separated color channels; an alpha channel is not needed here.
	// rgb:/rgba: 形式共用前三个斜杠分隔颜色通道；此处不需要 alpha 通道。
	const [red, green, blue] = rgbValue.split("/");
	if (red === undefined || green === undefined || blue === undefined) {
		return undefined;
	}
	const r = parseOscHexChannel(red);
	const g = parseOscHexChannel(green);
	const b = parseOscHexChannel(blue);
	return r !== undefined && g !== undefined && b !== undefined ? { r, g, b } : undefined;
}

export function parseTerminalColorSchemeReport(data: string): TerminalColorScheme | undefined {
	// The report is deliberately strict: unsupported or malformed replies return undefined so callers can fall back safely.
	// 报告解析刻意保持严格；不支持或格式错误的回复返回 undefined，调用方可安全降级。
	const match = data.match(COLOR_SCHEME_REPORT_PATTERN);
	if (!match) {
		return undefined;
	}
	return match[1] === "2" ? "light" : "dark";
}
