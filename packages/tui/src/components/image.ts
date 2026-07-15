import {
	allocateImageId,
	getCapabilities,
	getCellDimensions,
	getImageDimensions,
	type ImageDimensions,
	imageFallback,
	renderImage,
} from "../terminal-image.ts";
import type { Component } from "../tui.ts";

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	/**
	 * Kitty image ID. If provided, reuses this ID (for animations/updates).
	 * Kitty 图像 ID；提供后会复用该 ID（用于动画或更新）。
	 */
	imageId?: number;
}

export class Image implements Component {
	private base64Data: string;
	private mimeType: string;
	private dimensions: ImageDimensions;
	private theme: ImageTheme;
	private options: ImageOptions;
	private imageId?: number;

	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.base64Data = base64Data;
		this.mimeType = mimeType;
		this.theme = theme;
		this.options = options;
		this.dimensions = dimensions || getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
		this.imageId = options.imageId;
	}

	/**
	 * Get the Kitty image ID used by this image (if any).
	 * 获取该图像使用的 Kitty 图像 ID（如有）。
	 */
	getImageId(): number | undefined {
		return this.imageId;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const maxWidth = Math.max(1, Math.min(width - 2, this.options.maxWidthCells ?? 60));
		const cellDimensions = getCellDimensions();
		const defaultMaxHeight = Math.max(1, Math.ceil((maxWidth * cellDimensions.widthPx) / cellDimensions.heightPx));
		const maxHeight = this.options.maxHeightCells ?? defaultMaxHeight;

		const caps = getCapabilities();
		let lines: string[];

		if (caps.images) {
			if (caps.images === "kitty" && this.imageId === undefined) {
				this.imageId = allocateImageId();
			}
			const result = renderImage(this.base64Data, this.dimensions, {
				maxWidthCells: maxWidth,
				maxHeightCells: maxHeight,
				imageId: this.imageId,
				moveCursor: false,
			});

			if (result) {
				// Store the image ID for later cleanup
				// 保存图像 ID，供后续清理使用
				if (result.imageId) {
					this.imageId = result.imageId;
				}

				if (caps.images === "kitty") {
					// For Kitty: C=1 prevents cursor movement.
					// 对 Kitty 而言，C=1 可阻止光标移动。
					// Don't need the cursor movement.
					// 因此不需要额外移动光标。
					lines = [result.sequence];

					// Return `rows` lines so TUI accounts for image height.
					// 返回 `rows` 行，使 TUI 能计入图像高度。
					for (let i = 0; i < result.rows - 1; i++) {
						lines.push("");
					}
				} else {
					// Return `rows` lines so TUI accounts for image height.
					// 返回 `rows` 行，使 TUI 能计入图像高度。
					// First (rows-1) lines are empty and cleared before the image is drawn.
					// 前 (rows-1) 行为空行，并在绘制图像前清除。
					// Last line: move cursor back up, draw the image, then move back down
					// 最后一行：先将光标上移并绘制图像，再将其下移，
					// so TUI cursor accounting stays inside the scroll area.
					// 从而让 TUI 的光标位置计算始终处于滚动区域内。
					lines = [];
					for (let i = 0; i < result.rows - 1; i++) {
						lines.push("");
					}
					const rowOffset = result.rows - 1;
					const moveUp = rowOffset > 0 ? `\x1b[${rowOffset}A` : "";
					lines.push(moveUp + result.sequence);
				}
			} else {
				const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
				lines = [this.theme.fallbackColor(fallback)];
			}
		} else {
			const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
			lines = [this.theme.fallbackColor(fallback)];
		}

		this.cachedLines = lines;
		this.cachedWidth = width;

		return lines;
	}
}
