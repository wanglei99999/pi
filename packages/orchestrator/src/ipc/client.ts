import { createConnection } from "node:net";
import { getSocketPath } from "../config.ts";
import { encodeMessage, type OrchestratorRequest, type OrchestratorResponse, parseResponseLine } from "./protocol.ts";

export async function sendIpcRequest(request: OrchestratorRequest): Promise<OrchestratorResponse> {
	// A short-lived connection carries exactly one request and the first complete response frame.
	// 每个短连接只承载一个请求和首个完整响应帧。
	const socketPath = getSocketPath();

	return new Promise<OrchestratorResponse>((resolve, reject) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		let settled = false;

		const cleanup = () => {
			// Remove listeners before closing so local teardown cannot trigger a second settlement path.
			// 关闭前移除监听器，避免本地清理再次触发 Promise 结算路径。
			socket.removeAllListeners();
			socket.end();
		};

		socket.on("connect", () => {
			socket.write(encodeMessage(request));
		});

		socket.on("data", (chunk: Buffer | string) => {
			// Accumulate arbitrary socket chunks until the protocol newline delimiter arrives.
			// 累积任意 socket 分块，直到收到协议规定的换行分隔符。
			buffer += chunk.toString();
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}

			const line = buffer.slice(0, newlineIndex).trim();
			if (!line) {
				return;
			}

			try {
				// Parsing is the response validation boundary; transport success alone is not enough.
				// 解析是响应校验边界，仅传输成功并不足以完成请求。
				settled = true;
				resolve(parseResponseLine(line));
				cleanup();
			} catch (error) {
				settled = true;
				reject(error);
				cleanup();
			}
		});

		socket.on("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			reject(error);
			cleanup();
		});

		socket.on("end", () => {
			if (settled) {
				return;
			}
			settled = true;
			// EOF before a frame is a protocol failure rather than an empty successful response.
			// 在响应帧前收到 EOF 属于协议失败，而不是空的成功响应。
			reject(new Error(`Orchestrator socket closed before a response was received: ${socketPath}`));
			cleanup();
		});
	});
}
