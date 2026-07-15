interface StdoutTakeoverState {
	// Preserve bound raw writers and the original method so protocol output can bypass the redirect and later restore it.
	// 保存绑定后的原始 writer 和原方法，使协议输出可绕过重定向，并在之后恢复。
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;
// The singleton state makes takeover idempotent; this is a single-owner guard rather than a nested reference count.
// 单例状态使 takeover 幂等；这是单一所有者保护，不是可嵌套的引用计数。

const RAW_STDOUT_RETRY_DELAY_MS = 10;

let rawStdoutWriteTail: Promise<void> = Promise.resolve();
// Raw stdout writes form one promise chain to preserve frame order across concurrent callers.
// raw stdout 写入串成单一 Promise 链，以保持并发调用之间的帧顺序。

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	// During takeover use the captured stdout writer; otherwise bind the current process writer on demand.
	// takeover 期间使用预先捕获的 stdout writer；否则按需绑定当前进程 writer。
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

async function writeRawStdoutChunk(text: string): Promise<void> {
	// Retry only transient buffer-pressure failures; all other write errors remain fatal to the protocol stream.
	// 只重试临时缓冲区压力错误；其他写入失败对协议流仍是致命错误。
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				try {
					getRawStdoutWrite()(text, (error) => {
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

export function takeOverStdout(): void {
	// Redirect ordinary stdout writes to stderr, reserving raw stdout for machine-readable transport output.
	// 将普通 stdout 写入重定向到 stderr，把 raw stdout 保留给机器可读的传输输出。
	if (stdoutTakeoverState) {
		// Repeated takeover calls must not replace the original restoration point.
		// 重复 takeover 不得覆盖最初保存的恢复点。
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

export function restoreStdout(): void {
	// Restore exactly the method captured by takeover; calling restore without an active takeover is a no-op.
	// 精确恢复 takeover 时捕获的方法；未 takeover 时调用 restore 不执行任何操作。
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

export function writeRawStdout(text: string): void {
	// Fire-and-forget callers enqueue work synchronously; a rejected chain terminates the process to avoid corrupt partial output.
	// 调用方以 fire-and-forget 方式同步入队；链路失败时终止进程，避免继续产生损坏的部分输出。
	if (text.length === 0) {
		return;
	}
	rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));
	void rawStdoutWriteTail.catch(() => {
		process.exit(1);
	});
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
	// Recheck the tail after awaiting because another caller may append a write while the previous tail is settling.
	// 等待后重新检查 tail，因为前一个 tail 完成期间可能有其他调用方追加写入。
	while (true) {
		const tail = rawStdoutWriteTail;
		await tail;
		if (tail === rawStdoutWriteTail) {
			return;
		}
	}
}

export async function flushRawStdout(): Promise<void> {
	// First drain the serialized queue, then issue an empty write whose callback observes the underlying stream flush boundary.
	// 先排空串行队列，再执行空写入，通过回调观察底层 stream 的刷新边界。
	await waitForRawStdoutBackpressure();
	await writeRawStdoutChunk("");
}
