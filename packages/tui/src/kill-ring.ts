/**
 * Ring buffer for Emacs-style kill/yank operations.
 * 用于 Emacs 风格 kill/yank 操作的环形缓冲区。
 *
 * Tracks killed (deleted) text entries. Consecutive kills can accumulate
 * into a single entry. Supports yank (paste most recent) and yank-pop
 * (cycle through older entries).
 * 跟踪被 kill（删除）的文本条目。连续的 kill 可累积到同一条目中。
 * 支持 yank（粘贴最近条目）和 yank-pop（循环选择更早的条目）。
 */
export class KillRing {
	private ring: string[] = [];

	/**
	 * Add text to the kill ring.
	 * 将文本添加到 kill 环。
	 *
	 * @param text - The killed text to add
	 *   要添加的已删除文本
	 * @param opts - Push options
	 *   入环选项
	 * @param opts.prepend - If accumulating, prepend (backward deletion) or append (forward deletion)
	 *   累积时，向前插入（向后删除）或向后追加（向前删除）
	 * @param opts.accumulate - Merge with the most recent entry instead of creating a new one
	 *   与最近条目合并，而不是创建新条目
	 */
	push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
		if (!text) return;

		if (opts.accumulate && this.ring.length > 0) {
			const last = this.ring.pop()!;
			this.ring.push(opts.prepend ? text + last : last + text);
		} else {
			this.ring.push(text);
		}
	}

	/**
	 * Get most recent entry without modifying the ring.
	 * 获取最近条目，但不修改环。
	 */
	peek(): string | undefined {
		return this.ring.length > 0 ? this.ring[this.ring.length - 1] : undefined;
	}

	/**
	 * Move last entry to front (for yank-pop cycling).
	 * 将末尾条目移到开头，供 yank-pop 循环使用。
	 */
	rotate(): void {
		if (this.ring.length > 1) {
			const last = this.ring.pop()!;
			this.ring.unshift(last);
		}
	}

	get length(): number {
		return this.ring.length;
	}
}
