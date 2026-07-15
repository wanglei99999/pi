/**
 * Process @file CLI arguments into text content and image attachments
 * 将 @file CLI 参数处理为文本内容和图片附件。
 */

import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { processImage } from "../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	// 是否自动将图片缩放至最大 2000x2000。默认值：true。
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
}

// 将 @file 参数处理为文本内容和图片附件。
/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
		// 展开并解析路径（支持 ~ 展开及 macOS 截图文件名中的 Unicode 空格）。
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// Check if file exists
		// 先检查文件是否存在，使 CLI 能报告明确路径并立即以失败状态退出。
		try {
			await access(absolutePath);
		} catch {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		// Check if file is empty
		// 空文件既不产生文本标签也不产生附件，避免向模型发送无意义内容。
		const stats = await stat(absolutePath);
		if (stats.size === 0) {
			// Skip empty files
			// 跳过空文件。
			continue;
		}

		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

		if (mimeType) {
			// Handle image file
			// 图片按二进制读取，并统一经过格式校验及可选缩放处理。
			const content = await readFile(absolutePath);
			const processed = await processImage(content, mimeType, { autoResizeImages });

			if (!processed.ok) {
				// 图片处理失败时保留文字提示并继续其他文件，而不是丢弃该输入或终止整批处理。
				text += `<file name="${absolutePath}">${processed.message}</file>\n`;
				continue;
			}

			const attachment: ImageContent = {
				type: "image",
				mimeType: processed.mimeType,
				data: processed.data,
			};
			images.push(attachment);

			// Add text reference to image with optional processing hints
			// 为图片附件添加文本引用，并在发生转换或缩放时附带处理提示。
			if (processed.hints.length > 0) {
				text += `<file name="${absolutePath}">${processed.hints.join("\n")}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			// Handle text file
			// 非受支持图片按 UTF-8 文本读取；读取失败属于 CLI 致命输入错误。
			try {
				const content = await readFile(absolutePath, "utf-8");
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
		}
	}

	return { text, images };
}
