import { type ExecutionEnv, ExecutionError, err, ok, type Result, type ShellExecOptions, toError } from "../types.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./truncate.ts";

export interface ShellCaptureOptions extends Omit<ShellExecOptions, "onStdout" | "onStderr"> {
	onChunk?: (chunk: string) => void;
}

export interface ShellCaptureResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
}

function toExecutionError(error: unknown): ExecutionError {
	if (error instanceof ExecutionError) return error;
	const cause = toError(error);
	return new ExecutionError("unknown", cause.message, cause);
}

export function sanitizeBinaryOutput(str: string): string {
	// Remove unsafe C0 controls, including ESC, without interpreting ANSI sequences; printable remnants stay plain text.
	// 移除包括 ESC 在内的不安全 C0 控制字符，但不解析 ANSI 序列；其余可打印内容保留为纯文本。
	return Array.from(str)
		.filter((char) => {
			const code = char.codePointAt(0);
			if (code === undefined) return false;
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
			if (code <= 0x1f) return false;
			if (code >= 0xfff9 && code <= 0xfffb) return false;
			return true;
		})
		.join("");
}

export async function executeShellWithCapture(
	env: ExecutionEnv,
	command: string,
	options?: ShellCaptureOptions,
): Promise<Result<ShellCaptureResult, ExecutionError>> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	// The rolling buffer is deliberately larger than the final limit to retain extra recent context before truncation.
	// 滚动缓冲区刻意大于最终限制，以便截断前保留更多近期上下文。
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;
	const encoder = new TextEncoder();

	let totalBytes = 0;
	let fullOutputPath: string | undefined;
	// Serialize temp-file operations to preserve chunk order even when filesystem writes are asynchronous.
	// 临时文件操作通过 Promise chain 串行化，确保异步文件写入仍保持 chunk 顺序。
	let writeChain: Promise<Result<void, ExecutionError>> = Promise.resolve(ok(undefined));
	let captureError: ExecutionError | undefined;

	const appendFullOutput = (text: string): void => {
		if (!fullOutputPath || captureError) return;
		const path = fullOutputPath;
		writeChain = writeChain.then(async (previous) => {
			if (!previous.ok) return previous;
			const appendResult = await env.appendFile(path, text, options?.abortSignal);
			return appendResult.ok ? ok(undefined) : err(toExecutionError(appendResult.error));
		});
	};

	const ensureFullOutputFile = (initialContent: string): void => {
		if (fullOutputPath || captureError) return;
		writeChain = writeChain.then(async (previous) => {
			if (!previous.ok) return previous;
			// Delegate path allocation to ExecutionEnv so persistence stays inside the environment's temp boundary.
			// 路径分配交给 ExecutionEnv，确保持久化位置位于该环境的临时目录边界内。
			const tempFile = await env.createTempFile({
				prefix: "bash-",
				suffix: ".log",
				abortSignal: options?.abortSignal,
			});
			if (!tempFile.ok) return err(toExecutionError(tempFile.error));
			fullOutputPath = tempFile.value;
			const appendResult = await env.appendFile(tempFile.value, initialContent, options?.abortSignal);
			return appendResult.ok ? ok(undefined) : err(toExecutionError(appendResult.error));
		});
	};

	const onChunk = (chunk: string) => {
		try {
			// The persistence threshold counts original UTF-8 bytes before sanitization, so binary/control data still costs budget.
			// 持久化阈值按清理前的原始 UTF-8 字节计量，因此二进制或控制数据仍会占用预算。
			totalBytes += encoder.encode(chunk).byteLength;
			// Normalize both stdout and stderr into one safe LF-oriented stream before callbacks or storage.
			// stdout 与 stderr 会合并为同一个安全、以 LF 为主的流，再交给回调或存储。
			const text = sanitizeBinaryOutput(chunk).replace(/\r/g, "");
			if (totalBytes > DEFAULT_MAX_BYTES && !fullOutputPath) {
				ensureFullOutputFile(outputChunks.join("") + text);
			} else {
				appendFullOutput(text);
			}
			outputChunks.push(text);
			// This rolling guard uses JavaScript string length; truncateTail later enforces exact UTF-8 byte and line limits.
			// 此滚动保护按 JavaScript 字符串长度计量；最终由 truncateTail 精确执行 UTF-8 字节和行数限制。
			outputBytes += text.length;
			while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
				const removed = outputChunks.shift()!;
				outputBytes -= removed.length;
			}
			options?.onChunk?.(text);
		} catch (error) {
			captureError = toExecutionError(error);
		}
	};

	try {
		const result = await env.exec(command, {
			...(options ?? {}),
			onStdout: onChunk,
			onStderr: onChunk,
		});
		const tailOutput = outputChunks.join("");
		// Shell results keep the tail because errors and final summaries usually appear at the end of output.
		// shell 结果保留尾部，因为错误和最终摘要通常位于输出末端。
		const truncationResult = truncateTail(tailOutput);
		if (truncationResult.truncated && !fullOutputPath) {
			// Line-limit truncation also persists the captured text, even when the byte threshold was not crossed.
			// 即使未超过字节阈值，只要因行数限制截断，也会持久化已捕获文本。
			ensureFullOutputFile(tailOutput);
		}
		// Do not expose fullOutputPath until all queued writes have completed successfully.
		// 所有排队写入成功完成前，不向调用方返回 fullOutputPath。
		const writeResult = await writeChain;
		if (!writeResult.ok) return err(writeResult.error);
		if (captureError) return err(captureError);

		if (!result.ok) {
			if (result.error.code === "aborted" || options?.abortSignal?.aborted) {
				// Cancellation is a successful capture outcome with partial output, distinct from execution failure.
				// 取消属于携带部分输出的成功捕获结果，与执行失败不同。
				return ok({
					output: truncationResult.truncated ? truncationResult.content : tailOutput,
					exitCode: undefined,
					cancelled: true,
					truncated: truncationResult.truncated,
					fullOutputPath,
				});
			}
			return err(result.error);
		}
		const cancelled = options?.abortSignal?.aborted ?? false;
		return ok({
			output: truncationResult.truncated ? truncationResult.content : tailOutput,
			exitCode: cancelled ? undefined : result.value.exitCode,
			cancelled,
			truncated: truncationResult.truncated,
			fullOutputPath,
		});
	} catch (error) {
		return err(toExecutionError(error));
	}
}
