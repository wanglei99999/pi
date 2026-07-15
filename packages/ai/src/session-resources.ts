export type SessionResourceCleanup = (sessionId?: string) => void;

const sessionResourceCleanups = new Set<SessionResourceCleanup>();

export function registerSessionResourceCleanup(cleanup: SessionResourceCleanup): () => void {
	// Set membership makes duplicate registration idempotent and returns an explicit unregistration handle.
	// Set 成员关系使重复注册保持幂等，并返回显式注销句柄。
	sessionResourceCleanups.add(cleanup);
	return () => {
		sessionResourceCleanups.delete(cleanup);
	};
}

export function cleanupSessionResources(sessionId?: string): void {
	// Attempt every cleanup even after failures so independent providers do not leak session-scoped state.
	// 即使某项失败也继续执行全部清理，避免其他 provider 泄漏会话级状态。
	const errors: unknown[] = [];
	for (const cleanup of sessionResourceCleanups) {
		try {
			cleanup(sessionId);
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0) {
		// Aggregate failures after the sweep to preserve all provider diagnostics without short-circuiting cleanup.
		// 完成遍历后聚合失败，既保留所有 provider 诊断，也不中断清理过程。
		throw new AggregateError(errors, "Failed to cleanup session resources");
	}
}
