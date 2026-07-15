export interface CombinedAbortSignal {
	signal?: AbortSignal;
	cleanup: () => void;
}

export function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): CombinedAbortSignal {
	// Ignore absent inputs while preserving source order, which determines the first already-aborted reason observed.
	// 忽略缺失输入但保留来源顺序，该顺序决定首先采用哪个已取消 signal 的 reason。
	const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (activeSignals.length === 0) {
		// No inputs means no cancellation channel; avoid allocating a never-aborted controller.
		// 没有输入就不存在取消通道，因此无需创建永不取消的 controller。
		return { cleanup: () => {} };
	}
	if (activeSignals.length === 1) {
		// Reuse a single signal directly to preserve identity and reason without installing listeners.
		// 只有一个 signal 时直接复用，以保留 identity 与 reason，且无需安装 listener。
		return { signal: activeSignals[0], cleanup: () => {} };
	}

	const controller = new AbortController();
	const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
	const abort = (signal: AbortSignal) => {
		// The first cancellation wins and forwards its reason unchanged to the combined signal.
		// 第一次取消生效，并将其 reason 原样传播给组合 signal。
		if (!controller.signal.aborted) {
			controller.abort(signal.reason);
		}
	};

	for (const signal of activeSignals) {
		if (signal.aborted) {
			// Stop wiring later inputs once an already-aborted signal determines the result.
			// 一旦已取消的 signal 确定结果，就停止为后续输入安装 listener。
			abort(signal);
			break;
		}
		const listener = () => abort(signal);
		signal.addEventListener("abort", listener, { once: true });
		listeners.push({ signal, listener });
	}

	// Cleanup is still required for an immediately aborted result because earlier inputs may already have listeners.
	// 即使组合结果立即处于取消状态，仍需 cleanup，因为更早的输入可能已经安装 listener。
	return {
		signal: controller.signal,
		cleanup: () => {
			// Remove every installed listener when the owning operation finishes, including normal completion.
			// 所属操作结束时移除所有已安装 listener，包括正常完成路径。
			for (const { signal, listener } of listeners) {
				signal.removeEventListener("abort", listener);
			}
		},
	};
}
