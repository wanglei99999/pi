import { type FSWatcher, type WatchListener, watch } from "node:fs";

export const FS_WATCH_RETRY_DELAY_MS = 5000;
// fs.watch 的可用性和失败模式因平台而异；该延迟供上层在 onError 后安排重建，不在本模块自动重试。

export function closeWatcher(watcher: FSWatcher | null | undefined): void {
	// 接受空值并吞掉重复关闭等异常，使所有 watcher 清理路径都可安全调用。
	if (!watcher) {
		return;
	}

	try {
		watcher.close();
	} catch {
		// Ignore watcher close errors
		// 忽略 watcher 关闭错误；资源可能已由平台或先前错误事件释放。
	}
}

export function watchWithErrorHandler(
	path: string,
	listener: WatchListener<string>,
	onError: () => void,
): FSWatcher | null {
	// 同步创建失败与 watcher 后续异步 error 统一交给 onError，调用方只需维护一套降级/重试状态。
	try {
		const watcher = watch(path, listener);
		watcher.on("error", onError);
		return watcher;
	} catch {
		// 创建阶段失败时立即通知并返回 null，明确表示当前没有可关闭的 watcher。
		onError();
		return null;
	}
}
