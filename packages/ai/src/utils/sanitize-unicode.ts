/**
 * Removes unpaired Unicode surrogate characters from a string.
 * 从字符串中移除未配对的 Unicode 代理字符。
 *
 * Unpaired surrogates (high surrogates 0xD800-0xDBFF without matching low surrogates 0xDC00-0xDFFF,
 * or vice versa) cause JSON serialization errors in many API providers.
 * 未配对的代理字符（0xD800-0xDBFF 的高位代理没有匹配 0xDC00-0xDFFF 的低位代理，
 * 或反之）会导致许多 API 提供商发生 JSON 序列化错误。
 *
 * Valid emoji and other characters outside the Basic Multilingual Plane use properly paired
 * surrogates and will NOT be affected by this function.
 * 有效的表情符号及基本多文种平面以外的其他字符使用正确配对的代理字符，
 * 不会受到此函数影响。
 *
 * @param text - The text to sanitize
 *   要清理的文本
 * @returns The sanitized text with unpaired surrogates removed
 *   已移除未配对代理字符的清理后文本
 *
 * @example
 * // Valid emoji (properly paired surrogates) are preserved
 * sanitizeSurrogates("Hello 🙈 World") // => "Hello 🙈 World"
 *
 * // Unpaired high surrogate is removed
 * const unpaired = String.fromCharCode(0xD83D); // high surrogate without low
 * sanitizeSurrogates(`Text ${unpaired} here`) // => "Text  here"
 */
export function sanitizeSurrogates(text: string): string {
	// Replace unpaired high surrogates (0xD800-0xDBFF not followed by low surrogate)
	// 替换未配对的高位代理（0xD800-0xDBFF 后未跟随低位代理）
	// Replace unpaired low surrogates (0xDC00-0xDFFF not preceded by high surrogate)
	// 替换未配对的低位代理（0xDC00-0xDFFF 前没有高位代理）
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
