export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	// Preserve undefined as omission; an explicit empty key remains distinct and is returned unchanged.
	// undefined 保持为省略状态；显式空 key 仍是不同输入，并会原样返回。
	if (key === undefined) return undefined;
	// Array.from counts Unicode code points instead of UTF-16 code units, avoiding splits inside surrogate pairs.
	// Array.from 按 Unicode code point 而非 UTF-16 code unit 计数，避免从 surrogate pair 中间截断。
	// Code-point counting does not preserve grapheme clusters, so a combined visual character may cross the boundary.
	// code point 计数不保证 grapheme cluster 完整，组合后的视觉字符仍可能跨越截断边界。
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	// Truncation is deterministic and prefix-preserving; keys sharing the first 64 code points map to the same result.
	// 截断结果稳定并保留前缀；前 64 个 code point 相同的 key 会映射为相同结果。
	// No trimming, case folding, hashing, or Unicode normalization is applied beyond the length clamp.
	// 除长度限制外，不执行 trim、case folding、hash 或 Unicode normalization。
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
