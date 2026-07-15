import { existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import type { AgentSessionEvent, RpcExtensionUIRequest, RpcResponse } from "@earendil-works/pi-coding-agent";
import { getSocketPath } from "../config.ts";
import {
	type ErrorResponse,
	encodeMessage,
	type ListRequest,
	type ListResponse,
	type OrchestratorRequest,
	type OrchestratorResponse,
	parseRequestLine,
	type RpcBridgeResponse,
	type RpcReadyResponse,
	type RpcRequest,
	type RpcStreamRequest,
	type SpawnRequest,
	type SpawnResponse,
	type StatusRequest,
	type StatusResponse,
	type StopRequest,
	type StopResponse,
} from "./protocol.ts";

export interface IpcRequestHandler {
	// Unary requests return one response, while rpc_stream upgrades the connection to a long-lived bidirectional bridge.
	// 一次性请求只返回一个响应；rpc_stream 则把连接升级为长期双向桥接。
	(request: SpawnRequest): Promise<SpawnResponse | ErrorResponse> | SpawnResponse | ErrorResponse;
	(request: ListRequest): Promise<ListResponse | ErrorResponse> | ListResponse | ErrorResponse;
	(request: StopRequest): Promise<StopResponse | ErrorResponse> | StopResponse | ErrorResponse;
	(request: StatusRequest): Promise<StatusResponse | ErrorResponse> | StatusResponse | ErrorResponse;
	(request: RpcRequest): Promise<RpcBridgeResponse | ErrorResponse> | RpcBridgeResponse | ErrorResponse;
	(request: RpcStreamRequest): Promise<RpcReadyResponse | ErrorResponse> | RpcReadyResponse | ErrorResponse;
	(request: OrchestratorRequest): Promise<OrchestratorResponse> | OrchestratorResponse;
	openRpcStream(
		instanceId: string,
		onResponse: (response: RpcResponse) => void,
		onSessionEvent: (event: AgentSessionEvent) => void,
		onUiRequest: (request: RpcExtensionUIRequest) => void,
	):
		| {
				handleRequest(request: RpcRequest["command"] | { type: "extension_ui_response" }): Promise<void>;
				close(): void;
		  }
		| undefined;
}

export async function startIpcServer(handler: IpcRequestHandler): Promise<Server> {
	const socketPath = getSocketPath();
	// Probe and remove only a stale socket before binding; a live endpoint is treated as another orchestrator instance.
	// 绑定前仅探测并移除失效 socket；活动端点表示已有另一个 orchestrator 实例。
	await removeStaleSocketIfNeeded(socketPath);

	const server = createServer((socket) => {
		// Each client owns an independent text buffer so partial frames never leak across connections.
		// 每个客户端拥有独立文本缓冲区，分段消息不会在连接之间串流。
		let buffer = "";

		socket.on("data", async (chunk: Buffer | string) => {
			// The protocol is newline-delimited; retain incomplete data until a full request line arrives.
			// 协议以换行分帧；数据不完整时保留缓冲区，直到收到完整请求行。
			buffer += chunk.toString();
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}

			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (!line) {
				return;
			}

			try {
				const request = parseRequestLine(line);
				if (request.type === "rpc_stream") {
					// Complete the normal handler handshake before replacing the one-shot parser with RPC stream handling.
					// 先完成普通 handler 握手，再把一次性解析器替换为 RPC 流处理。
					const response = await handler(request);
					if (!response.ok || response.type !== "rpc_ready" || !response.instance) {
						socket.end(encodeMessage(response));
						return;
					}

					socket.removeAllListeners("data");
					// The bridge multiplexes responses, session events, and UI requests onto the same framed client connection.
					// bridge 将响应、会话事件和 UI 请求复用到同一条分帧客户端连接。
					const rpcStream = handler.openRpcStream(
						request.instanceId,
						(response) => {
							socket.write(encodeMessage(response));
						},
						(event) => {
							socket.write(encodeMessage(event));
						},
						(request) => {
							socket.write(encodeMessage(request));
						},
					);
					if (!rpcStream) {
						// A ready response is not sufficient if the instance disappears before openRpcStream; fail and close the socket.
						// 即使握手已 ready，实例也可能在 openRpcStream 前消失；此时返回失败并关闭 socket。
						socket.end(
							encodeMessage({ type: "error", ok: false, error: `Unknown instance: ${request.instanceId}` }),
						);
						return;
					}

					socket.write(encodeMessage(response));
					let rpcRequestQueue = Promise.resolve();
					// Serialize inbound RPC commands in wire order even when data events and handlers overlap asynchronously.
					// 即使 data 事件和异步 handler 重叠，也按线路顺序串行执行入站 RPC 命令。
					socket.on("data", (rpcChunk: Buffer | string) => {
						buffer += rpcChunk.toString();
						for (;;) {
							const rpcNewlineIndex = buffer.indexOf("\n");
							if (rpcNewlineIndex === -1) {
								break;
							}
							const rpcLine = buffer.slice(0, rpcNewlineIndex).trim();
							buffer = buffer.slice(rpcNewlineIndex + 1);
							if (!rpcLine) {
								continue;
							}
							rpcRequestQueue = rpcRequestQueue
								.then(async () => {
									try {
										await rpcStream.handleRequest(JSON.parse(rpcLine));
									} catch (rpcError: unknown) {
										// Command errors are framed back to the client without tearing down the long-lived stream.
										// 单条命令错误会按帧返回客户端，但不会关闭长期 RPC 流。
										socket.write(
											encodeMessage({
												type: "error",
												ok: false,
												error: rpcError instanceof Error ? rpcError.message : String(rpcError),
											}),
										);
									}
								})
								.catch((rpcError: Error) => {
									socket.write(
										encodeMessage({
											type: "error",
											ok: false,
											error: rpcError.message,
										}),
									);
								});
						}
					});
					socket.once("close", () => rpcStream.close());
					// Close the backend bridge exactly once when the client disconnects, releasing subscriptions and pending resources.
					// 客户端断开时只关闭一次后端 bridge，以释放订阅和待处理资源。
					return;
				}

				const response = await handler(request);
				// Non-stream requests are one-shot: encode one response and end the client connection.
				// 非流式请求为一次性交互：编码单个响应后结束客户端连接。
				socket.end(encodeMessage(response));
			} catch (error: unknown) {
				// Parse and handler failures share the same error frame boundary; protocol strings remain opaque to the server.
				// 解析和 handler 失败使用同一错误帧边界；服务器不解释协议字符串内容。
				const response: ErrorResponse = {
					type: "error",
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				};
				socket.end(encodeMessage(response));
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		// Startup resolves only after listen succeeds; the temporary error listener covers bind failures without leaking.
		// 只有 listen 成功后启动 Promise 才完成；临时 error 监听器负责绑定失败且随后被移除。
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});

	return server;
}

async function removeStaleSocketIfNeeded(socketPath: string): Promise<void> {
	if (!existsSync(socketPath)) {
		return;
	}

	const isLive = await isSocketLive(socketPath);
	// Unexpected probe errors propagate and preserve the path; only recognized dead endpoints are unlinked.
	// 非预期探测错误会向上传播并保留路径；只有确认失效的端点才会被删除。
	if (isLive) {
		throw new Error(`orchestrator is already running: ${socketPath}`);
	}

	unlinkSync(socketPath);
}

async function isSocketLive(socketPath: string): Promise<boolean> {
	// Connection success proves liveness; known refusal/reset/missing errors classify the filesystem entry as stale.
	// 连接成功表示端点活动；已知的拒绝、重置或缺失错误则把该文件系统条目判为失效。
	return new Promise<boolean>((resolve, reject) => {
		const socket = createConnection(socketPath);
		let settled = false;

		const finish = (result: boolean) => {
			// A settled guard centralizes listener removal and socket destruction across racing connect/error events.
			// settled 防护在竞争的 connect/error 事件之间统一移除监听器并销毁 socket。
			if (settled) {
				return;
			}
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			resolve(result);
		};

		socket.on("connect", () => finish(true));
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
				finish(false);
				return;
			}
			if (error.code === "EPIPE" || error.code === "ECONNRESET") {
				finish(false);
				return;
			}
			if (settled) {
				return;
			}
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			reject(error);
		});
	});
}
