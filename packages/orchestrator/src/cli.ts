#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";
import type { RpcCommand, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { getSocketPath } from "./config.ts";
import { sendIpcRequest } from "./ipc/client.ts";
import { encodeMessage } from "./ipc/protocol.ts";
import { serve } from "./serve.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Resolve package metadata relative to this module, not the caller's cwd, so --version works from any directory.
// package metadata 相对当前模块解析，而不是相对调用方 cwd，因此 --version 可在任意目录工作。
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8")) as {
	version: string;
};

function printHelp(): void {
	console.log(
		`orchestrator v${packageJson.version}\n\nUsage:\n  orchestrator serve\n  orchestrator list\n  orchestrator spawn [--cwd <path>] [--label <label>]\n  orchestrator status <instance-id>\n  orchestrator stop <instance-id>\n  orchestrator rpc <instance-id> <json-command>\n  orchestrator rpc-stream <instance-id>\n  orchestrator --help\n  orchestrator --version\n\nRPC stream stdin expects JSONL RpcCommand or extension_ui_response messages.`,
	);
}

function printResponse(response: unknown): void {
	// IPC-level error responses are still printed as JSON; CLI validation, local parsing, or transport failures drive non-zero exits.
	// IPC 层错误响应仍按 JSON 输出；CLI 校验、本地解析或传输失败才会导致非零退出。
	console.log(JSON.stringify(response, null, 2));
}

function getFlagValue(args: string[], flag: string): string | undefined {
	// This intentionally reads the first separate flag value only; command routing owns defaults and downstream interpretation.
	// 此函数只读取首个独立 flag 后的值；默认值和后续解释由具体命令路由负责。
	const index = args.indexOf(flag);
	if (index === -1 || index + 1 >= args.length) {
		return undefined;
	}
	return args[index + 1];
}

async function rpcStream(instanceId: string): Promise<void> {
	// rpc-stream bypasses the one-shot IPC client and keeps one socket open for bidirectional JSONL traffic.
	// rpc-stream 绕过一次性 IPC client，保持单个 socket 用于双向 JSONL 流量。
	const socket = createConnection(getSocketPath());
	let stdinBuffer = "";
	process.stdin.setEncoding("utf8");

	await new Promise<void>((resolve, reject) => {
		// Do not consume stdin until the socket connects and the stream-upgrade request has been written.
		// 在 socket 连接并写入流升级请求前，不开始消费 stdin。
		socket.once("connect", () => {
			socket.write(encodeMessage({ type: "rpc_stream", instanceId }));
			resolve();
		});
		socket.once("error", reject);
	});

	socket.on("data", (chunk: Buffer | string) => {
		// Forward server frames verbatim to stdout; diagnostics stay on stderr so stdout remains machine-readable JSONL.
		// 服务端帧原样转发到 stdout；诊断写入 stderr，使 stdout 保持机器可读 JSONL。
		process.stdout.write(chunk.toString());
	});
	console.error(`connected to rpc stream ${instanceId}; send JSONL RpcCommand or extension_ui_response on stdin`);
	socket.on("error", (error) => {
		// A socket failure is a client/transport failure and exits non-zero; a clean remote end exits successfully.
		// socket 失败属于客户端/传输错误并以非零码退出；远端正常结束则成功退出。
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
	socket.on("end", () => {
		process.exit(0);
	});
	process.stdin.on("data", (chunk: string) => {
		// Buffer partial stdin chunks and emit only complete non-empty lines, preserving JSONL message framing.
		// 缓冲不完整 stdin 分片，只发送完整的非空行，从而保持 JSONL 消息分帧。
		stdinBuffer += chunk;
		while (true) {
			const newlineIndex = stdinBuffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}
			const line = stdinBuffer.slice(0, newlineIndex).trim();
			stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
			if (!line) {
				continue;
			}
			const parsed = JSON.parse(line) as RpcCommand | RpcExtensionUIResponse;
			socket.write(encodeMessage(parsed));
		}
	});
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	// The first argument selects one command; help and version are local, while operational commands route to daemon IPC.
	// 第一个参数选择唯一命令；help/version 在本地处理，操作类命令则路由到 daemon IPC。
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		printHelp();
		process.exit(0);
	}

	if (args[0] === "--version" || args[0] === "-v") {
		console.log(packageJson.version);
		process.exit(0);
	}

	if (args[0] === "serve") {
		// serve owns the daemon lifecycle in this process and does not contact an existing IPC client endpoint.
		// serve 在当前进程中管理 daemon 生命周期，不通过 IPC client 发请求。
		await serve();
		return;
	}

	if (args[0] === "list") {
		printResponse(await sendIpcRequest({ type: "list" }));
		return;
	}

	if (args[0] === "spawn") {
		// spawn defaults the new instance cwd to the client's current directory; explicit flags override only that request.
		// spawn 默认使用客户端当前目录作为新实例 cwd；显式 flag 只覆盖本次请求。
		const spawnCwd = getFlagValue(args, "--cwd") ?? cwd();
		const label = getFlagValue(args, "--label");
		printResponse(await sendIpcRequest({ type: "spawn", cwd: spawnCwd, label }));
		return;
	}

	if (args[0] === "status") {
		// Missing required positional arguments are CLI usage errors and exit 1 before any daemon request is sent.
		// 缺少必需位置参数属于 CLI 用法错误，会在发送 daemon 请求前以 1 退出。
		const instanceId = args[1];
		if (!instanceId) {
			console.error("Usage: orchestrator status <instance-id>");
			process.exit(1);
		}
		printResponse(await sendIpcRequest({ type: "status", instanceId }));
		return;
	}

	if (args[0] === "stop") {
		const instanceId = args[1];
		if (!instanceId) {
			console.error("Usage: orchestrator stop <instance-id>");
			process.exit(1);
		}
		printResponse(await sendIpcRequest({ type: "stop", instanceId }));
		return;
	}

	if (args[0] === "rpc") {
		const instanceId = args[1];
		const commandJson = args[2];
		if (!instanceId || !commandJson) {
			console.error("Usage: orchestrator rpc <instance-id> <json-command>");
			process.exit(1);
		}
		printResponse(
			await sendIpcRequest({
				type: "rpc",
				instanceId,
				command: JSON.parse(commandJson),
			}),
		);
		return;
	}

	if (args[0] === "rpc-stream") {
		const instanceId = args[1];
		if (!instanceId) {
			console.error("Usage: orchestrator rpc-stream <instance-id>");
			process.exit(1);
		}
		await rpcStream(instanceId);
		return;
	}

	console.error(`Unknown command: ${args[0]}`);
	// Unknown commands share the usage-error boundary: print help for recovery, then exit non-zero.
	// 未知命令同属用法错误：输出帮助以便修正，然后以非零码退出。
	printHelp();
	process.exit(1);
}

await main();
