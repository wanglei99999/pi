import { EventEmitter } from "node:events";

export interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface EventBusController extends EventBus {
	clear(): void;
}

export function createEventBus(): EventBusController {
	// Keep each bus instance isolated behind its own EventEmitter and expose lifecycle control only through the controller.
	// 每个事件总线实例使用独立 EventEmitter，并仅通过控制器暴露生命周期管理能力。
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => {
			// EventEmitter starts listeners synchronously in registration order; asynchronous completion is not awaited.
			// EventEmitter 按注册顺序同步启动监听器，但不会等待异步处理完成。
			emitter.emit(channel, data);
		},
		on: (channel, handler) => {
			// Wrap each subscriber so one rejected handler cannot escape into or interrupt the emitter boundary.
			// 包装每个订阅者，使单个处理器的拒绝不会越过或中断事件分发边界。
			const safeHandler = async (data: unknown) => {
				try {
					await handler(data);
				} catch (err) {
					console.error(`Event handler error (${channel}):`, err);
				}
			};
			emitter.on(channel, safeHandler);
			// Unsubscribe with the exact wrapper registered above, making cancellation idempotent at the emitter level.
			// 使用上方注册的同一包装函数取消订阅，使重复取消在 emitter 层保持幂等。
			return () => emitter.off(channel, safeHandler);
		},
		clear: () => {
			// Controller cleanup removes every channel subscription owned by this bus instance.
			// 控制器清理会移除此事件总线实例拥有的所有频道订阅。
			emitter.removeAllListeners();
		},
	};
}
