import { open } from "node:fs/promises";

const IMAGE_TYPE_SNIFF_BYTES = 4100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function detectSupportedImageMimeType(buffer: Uint8Array): string | null {
	// Detection is signature-based only; filenames and extensions never override missing or invalid bytes.
	// 检测仅依据字节签名；文件名或扩展名不会覆盖缺失或无效的内容。
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
		// Reject the explicitly unsupported marker even though it shares the common JPEG prefix.
		// 即使共享常见 JPEG 前缀，也会拒绝这个明确不支持的 marker。
		return buffer[3] === 0xf7 ? null : "image/jpeg";
	}
	if (startsWith(buffer, PNG_SIGNATURE)) {
		// PNG requires a structurally valid IHDR and is accepted only when no APNG control chunk is detected.
		// PNG 必须具有结构有效的 IHDR，且仅在未检测到 APNG control chunk 时接受。
		return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
	}
	if (startsWithAscii(buffer, 0, "GIF")) {
		return "image/gif";
	}
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
		return "image/webp";
	}
	if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) {
		return "image/bmp";
	}
	// null covers unsupported formats, truncated headers, and malformed supported containers alike.
	// null 同时表示不支持的格式、被截断的 header，以及格式受支持但结构损坏的 container。
	return null;
}

export async function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null> {
	// Read only a bounded prefix for sniffing; the decoder remains responsible for validating the complete file.
	// 仅读取固定上限的前缀进行 sniffing；完整文件的最终校验仍由 decoder 负责。
	const fileHandle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(IMAGE_TYPE_SNIFF_BYTES);
		const { bytesRead } = await fileHandle.read(buffer, 0, IMAGE_TYPE_SNIFF_BYTES, 0);
		return detectSupportedImageMimeType(buffer.subarray(0, bytesRead));
	} finally {
		// Always release the descriptor, including read or detection failures.
		// 即使读取或检测失败，也始终释放文件描述符。
		await fileHandle.close();
	}
}

function isPng(buffer: Uint8Array): boolean {
	// Validate the fixed first-chunk contract instead of trusting PNG_SIGNATURE alone.
	// 除 PNG_SIGNATURE 外还校验固定的首个 chunk 约束，避免仅凭签名接受伪造内容。
	return (
		buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR")
	);
}

function isAnimatedPng(buffer: Uint8Array): boolean {
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= buffer.length) {
		const chunkLength = readUint32BE(buffer, offset);
		const chunkTypeOffset = offset + 4;
		if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
		// In a valid APNG, acTL precedes IDAT, so reaching IDAT proves the image is not animated.
		// 在有效 APNG 中 acTL 必须位于 IDAT 之前，因此到达 IDAT 即可判定图片不是动画。
		if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;

		const nextOffset = offset + 8 + chunkLength + 4;
		// Stop on impossible progress or a chunk beyond the sniffed prefix; no animation evidence was found in bounds.
		// 遇到无法前进或超出 sniffed prefix 的 chunk 时停止；有效边界内尚未发现动画证据。
		if (nextOffset <= offset || nextOffset > buffer.length) return false;
		offset = nextOffset;
	}
	return false;
}

function isBmp(buffer: Uint8Array): boolean {
	// BMP needs additional header consistency checks because the two-byte BM marker is too weak by itself.
	// BMP 需要额外校验 header 一致性，因为两字节 BM marker 本身过于宽松。
	if (buffer.length < 26) return false;

	const declaredFileSize = readUint32LE(buffer, 2);
	const pixelDataOffset = readUint32LE(buffer, 10);
	const dibHeaderSize = readUint32LE(buffer, 14);
	if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
	if (pixelDataOffset < 14 + dibHeaderSize) return false;
	if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;

	let colorPlanes: number;
	let bitsPerPixel: number;
	if (dibHeaderSize === 12) {
		colorPlanes = readUint16LE(buffer, 22);
		bitsPerPixel = readUint16LE(buffer, 24);
	} else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
		if (buffer.length < 30) return false;
		colorPlanes = readUint16LE(buffer, 26);
		bitsPerPixel = readUint16LE(buffer, 28);
	} else {
		return false;
	}

	return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

function readUint16LE(buffer: Uint8Array, offset: number): number {
	return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) * 0x1000000 +
		((buffer[offset + 1] ?? 0) << 16) +
		((buffer[offset + 2] ?? 0) << 8) +
		(buffer[offset + 3] ?? 0)
	);
}

function readUint32LE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) +
		((buffer[offset + 1] ?? 0) << 8) +
		((buffer[offset + 2] ?? 0) << 16) +
		(buffer[offset + 3] ?? 0) * 0x1000000
	);
}

function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
	if (buffer.length < bytes.length) return false;
	return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
	if (buffer.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index++) {
		if (buffer[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}
