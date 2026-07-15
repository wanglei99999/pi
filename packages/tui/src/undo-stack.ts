/**
 * Generic undo stack with clone-on-push semantics.
 * 采用入栈时克隆语义的通用撤销栈。
 *
 * Stores deep clones of state snapshots. Popped snapshots are returned
 * directly (no re-cloning) since they are already detached.
 * 存储状态快照的深拷贝。弹出的快照已经与原状态分离，因此会直接返回，
 * 不再重复克隆。
 */
export class UndoStack<S> {
	private stack: S[] = [];

	/**
	 * Push a deep clone of the given state onto the stack.
	 * 将给定状态的深拷贝压入栈中。
	 */
	push(state: S): void {
		this.stack.push(structuredClone(state));
	}

	/**
	 * Pop and return the most recent snapshot, or undefined if empty.
	 * 弹出并返回最近的快照；栈为空时返回 undefined。
	 */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/**
	 * Remove all snapshots.
	 * 移除所有快照。
	 */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
