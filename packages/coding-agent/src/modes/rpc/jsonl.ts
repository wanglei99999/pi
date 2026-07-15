import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Serialize a single strict JSONL record.
 * 序列化单条严格的 JSONL 记录。
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such as
 * U+2028 and U+2029. Clients must split records on `\n` only.
 * 帧边界仅使用 LF。负载字符串可以包含 U+2028、U+2029 等其他 Unicode 分隔符，
 * 客户端必须只按 `\n` 拆分记录。
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * Attach an LF-only JSONL reader to a stream.
 * 为流附加一个仅以 LF 分帧的 JSONL 读取器。
 *
 * This intentionally does not use Node readline. Readline splits on additional
 * Unicode separators that are valid inside JSON strings and therefore does not
 * implement strict JSONL framing.
 * 此处有意不使用 Node readline：readline 还会按其他 Unicode 分隔符拆分，
 * 而这些字符在 JSON 字符串内部是合法内容，因此不符合严格 JSONL 分帧规则。
 */
export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
	// StringDecoder 会保留跨 chunk 拆分的不完整 UTF-8 字节，避免产生替换字符或损坏负载。
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	const emitLine = (line: string) => {
		// 记录仍以 LF 分帧，但容忍发送端使用 CRLF，并仅移除紧邻 LF 的 CR。
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	const onData = (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}

			emitLine(buffer.slice(0, newlineIndex));
			buffer = buffer.slice(newlineIndex + 1);
		}
	};

	const onEnd = () => {
		buffer += decoder.end();
		// 流结束时也交付未以 LF 结尾的最后一条记录，避免静默丢失完整负载。
		if (buffer.length > 0) {
			emitLine(buffer);
			buffer = "";
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
