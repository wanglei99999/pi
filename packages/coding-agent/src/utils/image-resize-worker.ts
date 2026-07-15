import { parentPort } from "node:worker_threads";
import { type ImageResizeOptions, type ResizedImage, resizeImageInProcess } from "./image-resize-core.ts";

interface ResizeImageWorkerRequest {
	inputBytes: Uint8Array;
	mimeType: string;
	options?: ImageResizeOptions;
}

interface ResizeImageWorkerResponse {
	result?: ResizedImage | null;
	error?: string;
}

function isResizeImageWorkerRequest(value: unknown): value is ResizeImageWorkerRequest {
	// Validate the structured-clone boundary before treating parent data as a resize request.
	// 在将父线程数据视为缩放请求前，先校验 structured-clone 消息边界。
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.inputBytes instanceof Uint8Array && typeof record.mimeType === "string";
}

const port = parentPort;
// This module is valid only inside a worker spawned with a parent communication channel.
// 本模块仅能在带父线程通信通道的 worker 中运行。
if (!port) {
	throw new Error("image resize worker requires parentPort");
}

port.once("message", (message: unknown) => {
	// One worker handles exactly one request; completion is reported with one response message.
	// 每个 worker 只处理一个请求，并通过一条响应消息报告完成结果。
	void (async () => {
		try {
			if (!isResizeImageWorkerRequest(message)) {
				throw new Error("Invalid image resize worker request");
			}
			const result = await resizeImageInProcess(message.inputBytes, message.mimeType, message.options);
			const response: ResizeImageWorkerResponse = { result };
			port.postMessage(response);
		} catch (error) {
			// Errors are reduced to strings because Error objects are not part of the response contract.
			// 错误会序列化为字符串，因为 Error 对象不属于响应协议。
			const response: ResizeImageWorkerResponse = {
				error: error instanceof Error ? error.message : String(error),
			};
			port.postMessage(response);
		}
	})();
});
