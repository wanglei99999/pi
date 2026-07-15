import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import { isBunBinary } from "./config.ts";

interface PendingRequest {
	resolve(response: RpcResponse): void;
	reject(error: Error): void;
}

const require = createRequire(import.meta.url);

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export class RpcProcessInstance {
	readonly process: ChildProcess;

	private exited = false;
	private nextRequestId = 0;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly exitListeners = new Set<(error?: Error) => void>();
	private uiRequestHandler: ((request: RpcExtensionUIRequest) => void) | undefined;

	constructor(options: { cwd: string }) {
		const rpcCommand = this.getSpawnCommand();
		// The child owns one RPC session and communicates exclusively through piped stdio.
		// 每个子进程承载一个 RPC session，并仅通过管道 stdio 通信。
		this.process = spawn(rpcCommand.command, rpcCommand.args, {
			cwd: options.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (!this.process.stdin || !this.process.stdout) {
			throw new Error("Failed to create RPC process stdio");
		}
		this.attachListeners();
	}

	private getSpawnCommand(): { command: string; args: string[] } {
		// Bundled Bun launches the sibling pi executable; Node launches the package RPC entry module directly.
		// Bun 打包产物启动同目录的 pi 可执行文件；Node 则直接启动 package 的 RPC entry module。
		if (isBunBinary) {
			return {
				command: join(dirname(process.execPath), process.platform === "win32" ? "pi.exe" : "pi"),
				args: ["--mode", "rpc"],
			};
		}
		return {
			command: process.execPath,
			args: [require.resolve("@earendil-works/pi-coding-agent/rpc-entry")],
		};
	}

	private attachListeners(): void {
		this.process.stdout?.setEncoding("utf8");
		this.process.stdout?.on("data", (chunk: string) => {
			// stdout is JSONL; retain an incomplete trailing record until a later chunk supplies LF.
			// stdout 使用 JSONL；末尾不完整记录会保留，直到后续 chunk 提供 LF。
			this.stdoutBuffer += chunk;
			while (true) {
				const newlineIndex = this.stdoutBuffer.indexOf("\n");
				if (newlineIndex === -1) {
					break;
				}
				const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
				this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
				if (!line) {
					continue;
				}
				this.handleLine(line);
			}
		});

		this.process.stderr?.setEncoding("utf8");
		this.process.stderr?.on("data", (chunk: string) => {
			// Stderr is retained for lifecycle diagnostics and is never parsed as protocol data.
			// stderr 会保留用于生命周期诊断，但绝不会作为协议数据解析。
			this.stderrBuffer += chunk;
		});

		this.process.once("error", (error) => {
			// Spawn/process errors make every outstanding request impossible to complete.
			// spawn 或 process 错误会使所有未完成请求都无法继续完成。
			this.exited = true;
			const wrapped = new Error(`RPC process error: ${error.message}. Stderr: ${this.stderrBuffer}`);
			this.rejectAllPending(wrapped);
			this.notifyExit(wrapped);
		});

		this.process.once("exit", (code, signal) => {
			// Normal or signaled exit shares the same terminal cleanup boundary for pending requests.
			// 正常退出或 signal 退出对未完成请求采用相同的终止清理边界。
			this.exited = true;
			const error = new Error(`RPC process exited (code=${code} signal=${signal}). Stderr: ${this.stderrBuffer}`);
			this.rejectAllPending(error);
			this.notifyExit(error);
		});
	}

	private handleLine(line: string): void {
		const parsed = JSON.parse(line) as { type?: string; id?: string };
		switch (parsed.type) {
			case "response": {
				// Correlate `response` by `id`; unknown or duplicate ids are stale and safely ignored.
				// 通过 `id` 关联 `response`；未知或重复 id 属于过期消息，可安全忽略。
				if (!parsed.id) {
					return;
				}
				const pending = this.pendingRequests.get(parsed.id);
				if (!pending) {
					return;
				}
				this.pendingRequests.delete(parsed.id);
				pending.resolve(parsed as RpcResponse);
				return;
			}

			case "extension_ui_request": {
				// UI requests use a dedicated request/response path rather than the general event fan-out.
				// UI 请求使用独立的请求/响应路径，不进入通用事件广播。
				this.uiRequestHandler?.(parsed as RpcExtensionUIRequest);
				return;
			}

			default: {
				// All remaining protocol records are broadcast to current session event subscribers.
				// 其余协议记录都会广播给当前 session 的事件订阅者。
				for (const listener of this.eventListeners) {
					listener(parsed as AgentSessionEvent);
				}
			}
		}
	}

	private rejectAllPending(error: Error): void {
		// Delete before rejecting so callbacks cannot observe requests that are already terminal.
		// 在 reject 前先删除，避免回调观察到已经终止的请求仍留在 pendingRequests 中。
		for (const [id, pending] of this.pendingRequests) {
			this.pendingRequests.delete(id);
			pending.reject(error);
		}
	}

	private notifyExit(error?: Error): void {
		for (const listener of this.exitListeners) {
			listener(error);
		}
	}

	send(command: RpcCommand): Promise<RpcResponse> {
		if (this.exited) {
			throw new Error(`RPC process is not running. Stderr: ${this.stderrBuffer}`);
		}
		// Preserve caller-supplied ids; generated ids combine local ordering with process-wide uniqueness.
		// 保留调用方提供的 id；自动生成的 id 同时包含本地顺序和进程级唯一性。
		const id = command.id ?? `orchestrator_${++this.nextRequestId}_${randomUUID()}`;
		const fullCommand = { ...command, id };
		return new Promise<RpcResponse>((resolve, reject) => {
			// Register correlation before writing so an immediate child response cannot race ahead of bookkeeping.
			// 写入前先登记关联关系，避免子进程立即响应时早于本地 bookkeeping。
			this.pendingRequests.set(id, { resolve, reject });
			this.process.stdin?.write(`${JSON.stringify(fullCommand)}\n`, (error) => {
				if (!error) {
					return;
				}
				this.pendingRequests.delete(id);
				reject(toError(error));
			});
		});
	}

	handleUiResponse(response: RpcExtensionUIResponse): void {
		// UI responses are fire-and-forget protocol records; an exited child cannot consume them.
		// UI response 是无需等待回执的协议记录；已退出的子进程无法再消费。
		if (this.exited) {
			return;
		}
		this.process.stdin?.write(`${JSON.stringify(response)}\n`);
	}

	setUiRequestHandler(handler?: (request: RpcExtensionUIRequest) => void): void {
		this.uiRequestHandler = handler;
	}

	onEvent(listener: (event: AgentSessionEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	onExit(listener: (error?: Error) => void): () => void {
		this.exitListeners.add(listener);
		return () => {
			this.exitListeners.delete(listener);
		};
	}

	async dispose(): Promise<void> {
		// Stop accepting UI work and reject callers before terminating the child, then wait for exit completion.
		// 先停止接收 UI 工作并拒绝调用方，再终止子进程并等待退出完成。
		this.uiRequestHandler = undefined;
		this.rejectAllPending(new Error("RPC process disposed"));
		if (this.exited) {
			return;
		}
		this.process.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			this.process.once("exit", () => resolve());
		});
	}
}

export function createRpcProcessInstance(options: { cwd: string }): RpcProcessInstance {
	return new RpcProcessInstance(options);
}
