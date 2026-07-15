import { getWordSegmenter, isWhitespaceChar, PUNCTUATION_REGEX } from "./utils.ts";

const wordSegmenter = getWordSegmenter();

/**
 * Options for word navigation functions.
 * 单词导航函数的选项。
 * When omitted, uses the default Intl.Segmenter word segmentation.
 * 省略时使用默认的 Intl.Segmenter 分词方式。
 */
export interface WordNavigationOptions {
	/**
	 * Custom segmenter returning word segments for the given text.
	 * 返回给定文本单词片段的自定义分词器。
	 */
	segment?: (text: string) => Iterable<Intl.SegmentData>;
	/**
	 * Predicate identifying atomic segments that should be treated as single units (e.g. paste markers).
	 * 用于识别应视为不可分割单元（如粘贴标记）的片段。
	 */
	isAtomicSegment?: (segment: string) => boolean;
}

/**
 * Find the cursor position after moving one word backward from `cursor` in `text`.
 * 查找在 `text` 中从 `cursor` 向后移动一个单词后的光标位置。
 * Skips trailing whitespace, then stops at the next word/punctuation boundary.
 * 先跳过尾随空白，再停在下一个单词或标点边界。
 *
 * Pure function - does not mutate any state.
 * 纯函数，不会修改任何状态。
 */
export function findWordBackward(text: string, cursor: number, options?: WordNavigationOptions): number {
	if (cursor <= 0) return 0;

	const textBeforeCursor = text.slice(0, cursor);
	const segmentFn = options?.segment;
	const isAtomic = options?.isAtomicSegment;
	const segments = segmentFn ? [...segmentFn(textBeforeCursor)] : [...wordSegmenter.segment(textBeforeCursor)];
	let newCursor = cursor;

	// Skip trailing whitespace
	// 跳过尾随空白
	while (
		segments.length > 0 &&
		!isAtomic?.(segments[segments.length - 1]?.segment || "") &&
		isWhitespaceChar(segments[segments.length - 1]?.segment || "")
	) {
		newCursor -= segments.pop()?.segment.length || 0;
	}

	if (segments.length === 0) return newCursor;

	const last = segments[segments.length - 1]!;

	if (isAtomic?.(last.segment)) {
		// Skip one atomic segment.
		// 跳过一个不可分割片段。
		newCursor -= last.segment.length;
	} else if (last.isWordLike) {
		// Skip inside one word-like segment, preserving ASCII punctuation boundaries.
		// 在一个类单词片段内跳转，同时保留 ASCII 标点边界。
		const segment = last.segment;
		const matches = [...segment.matchAll(new RegExp(PUNCTUATION_REGEX, "g"))];
		if (matches.length <= 0) {
			newCursor -= segment.length;
		} else {
			const lastMatch = matches[matches.length - 1]!;
			newCursor -= segment.length - (lastMatch.index + lastMatch[0].length);
		}
	} else {
		// Skip non-word non-whitespace run (punctuation)
		// 跳过连续的非单词、非空白字符（标点）
		while (
			segments.length > 0 &&
			!isAtomic?.(segments[segments.length - 1]?.segment || "") &&
			!segments[segments.length - 1]?.isWordLike &&
			!isWhitespaceChar(segments[segments.length - 1]?.segment || "")
		) {
			newCursor -= segments.pop()?.segment.length || 0;
		}
	}

	return newCursor;
}

/**
 * Find the cursor position after moving one word forward from `cursor` in `text`.
 * 查找在 `text` 中从 `cursor` 向前移动一个单词后的光标位置。
 * Skips leading whitespace, then stops at the next word/punctuation boundary.
 * 先跳过前导空白，再停在下一个单词或标点边界。
 *
 * Pure function - does not mutate any state.
 * 纯函数，不会修改任何状态。
 */
export function findWordForward(text: string, cursor: number, options?: WordNavigationOptions): number {
	if (cursor >= text.length) return text.length;

	const textAfterCursor = text.slice(cursor);
	const segmentFn = options?.segment;
	const isAtomic = options?.isAtomicSegment;
	const segments = segmentFn ? segmentFn(textAfterCursor) : wordSegmenter.segment(textAfterCursor);
	const iterator = segments[Symbol.iterator]();
	let next = iterator.next();
	let newCursor = cursor;

	// Skip leading whitespace
	// 跳过前导空白
	while (!next.done && !isAtomic?.(next.value.segment) && isWhitespaceChar(next.value.segment)) {
		newCursor += next.value.segment.length;
		next = iterator.next();
	}

	if (next.done) return newCursor;

	if (isAtomic?.(next.value.segment)) {
		// Skip one atomic segment.
		// 跳过一个不可分割片段。
		newCursor += next.value.segment.length;
	} else if (next.value.isWordLike) {
		// Skip inside one word-like segment, preserving ASCII punctuation boundaries.
		// 在一个类单词片段内跳转，同时保留 ASCII 标点边界。
		newCursor += PUNCTUATION_REGEX.exec(next.value.segment)?.index ?? next.value.segment.length;
	} else {
		// Skip non-word non-whitespace run (punctuation)
		// 跳过连续的非单词、非空白字符（标点）
		while (
			!next.done &&
			!isAtomic?.(next.value.segment) &&
			!next.value.isWordLike &&
			!isWhitespaceChar(next.value.segment)
		) {
			newCursor += next.value.segment.length;
			next = iterator.next();
		}
	}

	return newCursor;
}
