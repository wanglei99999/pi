/**
 * Shared command execution utilities for extensions and custom tools.
 * 命令通过 argv 直接启动而不经过 shell，捕获两个输出通道，并把进程失败统一编码为 ExecResult。
 */

import { spawn } from "node:child_process";
import { waitForChildProcess } from "../utils/child-process.ts";

/**
 * Options for executing shell commands.
 * cwd 由 execCommand 的显式参数提供；signal 与 timeout 仅控制当前子进程生命周期。
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
}

/**
 * Result of executing a shell command.
 * 非零退出、取消和超时都以结果返回而不是抛出；killed 用于区分主动终止与命令自身失败。
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 * command 与 args 不进行 shell 拼接或转义，环境默认继承父进程 process.env，调用方负责提供正确 argv 边界。
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			// shell:false 避免平台 shell 二次解释元字符；stdout/stderr 独立捕获，stdin 明确关闭。
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;

		const killProcess = () => {
			// AbortSignal 与 timeout 共用幂等终止路径，首次触发记录 killed 并发送温和 SIGTERM。
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
				// Force kill after 5 seconds if SIGTERM doesn't work
				// 宽限期后再 SIGKILL，给命令清理临时状态和刷新输出的机会。
				setTimeout(() => {
					if (!proc.killed) {
						proc.kill("SIGKILL");
					}
				}, 5000);
			}
		};

		// Handle abort signal
		// 已取消的 signal 在 spawn 后立即触发终止；否则使用 once 监听并在结算时主动移除。
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// Handle timeout
		// 未提供、为零或负值表示不启用定时终止。
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.on("data", (data) => {
			// Buffer 按 Node 默认 UTF-8 转成字符串；两个通道分别保持各自到达顺序。
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		// 以主进程终止为结算点，避免后台后代继续持有 pipe 导致 Promise 永久等待。
		waitForChildProcess(proc)
			.then((code) => {
				// signal 终止可能没有退出码；契约用 0 兜底并依赖 killed 表达主动终止状态。
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: code ?? 0, killed });
			})
			.catch((_err) => {
				// spawn/等待错误也转换为 code 1，保留终止前已收集的 stdout/stderr，不向调用方抛异常。
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: 1, killed });
			});
	});
}
