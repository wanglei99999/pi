/**
 * Armin says hi! A fun easter egg with animated XBM art.
 * 组件随机选择一次性动画效果，完成后保留最终帧；dispose 负责停止尚未结束的定时器。
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

// XBM image: 31x36 pixels, LSB first, 1=background, 0=foreground
// XBM 每行按字节存储且最低位对应较小 x；这里反转位值，使 0 成为需要绘制的前景像素。
const WIDTH = 31;
const HEIGHT = 36;
const BITS = [
	0xff, 0xff, 0xff, 0x7f, 0xff, 0xf0, 0xff, 0x7f, 0xff, 0xed, 0xff, 0x7f, 0xff, 0xdb, 0xff, 0x7f, 0xff, 0xb7, 0xff,
	0x7f, 0xff, 0x77, 0xfe, 0x7f, 0x3f, 0xf8, 0xfe, 0x7f, 0xdf, 0xff, 0xfe, 0x7f, 0xdf, 0x3f, 0xfc, 0x7f, 0x9f, 0xc3,
	0xfb, 0x7f, 0x6f, 0xfc, 0xf4, 0x7f, 0xf7, 0x0f, 0xf7, 0x7f, 0xf7, 0xff, 0xf7, 0x7f, 0xf7, 0xff, 0xe3, 0x7f, 0xf7,
	0x07, 0xe8, 0x7f, 0xef, 0xf8, 0x67, 0x70, 0x0f, 0xff, 0xbb, 0x6f, 0xf1, 0x00, 0xd0, 0x5b, 0xfd, 0x3f, 0xec, 0x53,
	0xc1, 0xff, 0xef, 0x57, 0x9f, 0xfd, 0xee, 0x5f, 0x9f, 0xfc, 0xae, 0x5f, 0x1f, 0x78, 0xac, 0x5f, 0x3f, 0x00, 0x50,
	0x6c, 0x7f, 0x00, 0xdc, 0x77, 0xff, 0xc0, 0x3f, 0x78, 0xff, 0x01, 0xf8, 0x7f, 0xff, 0x03, 0x9c, 0x78, 0xff, 0x07,
	0x8c, 0x7c, 0xff, 0x0f, 0xce, 0x78, 0xff, 0xff, 0xcf, 0x7f, 0xff, 0xff, 0xcf, 0x78, 0xff, 0xff, 0xdf, 0x78, 0xff,
	0xff, 0xdf, 0x7d, 0xff, 0xff, 0x3f, 0x7e, 0xff, 0xff, 0xff, 0x7f,
];

const BYTES_PER_ROW = Math.ceil(WIDTH / 8);
const DISPLAY_HEIGHT = Math.ceil(HEIGHT / 2); // Half-block rendering
// 每个终端字符组合上下两个像素，因此显示行数约为原图高度的一半。

type Effect = "typewriter" | "scanline" | "rain" | "fade" | "crt" | "glitch" | "dissolve";

const EFFECTS: Effect[] = ["typewriter", "scanline", "rain", "fade", "crt", "glitch", "dissolve"];

// Get pixel at (x, y): true = foreground, false = background
// 越过底部的奇数补齐像素视为背景，便于半块字符安全读取最后一行。
function getPixel(x: number, y: number): boolean {
	if (y >= HEIGHT) return false;
	const byteIndex = y * BYTES_PER_ROW + Math.floor(x / 8);
	const bitIndex = x % 8;
	return ((BITS[byteIndex] >> bitIndex) & 1) === 0;
}

// Get the character for a cell (2 vertical pixels packed)
// 根据上下像素组合选择全块、上半块或下半块，在单个终端单元中保留垂直分辨率。
function getChar(x: number, row: number): string {
	const upper = getPixel(x, row * 2);
	const lower = getPixel(x, row * 2 + 1);
	if (upper && lower) return "█";
	if (upper) return "▀";
	if (lower) return "▄";
	return " ";
}

// Build the final image grid
function buildFinalGrid(): string[][] {
	const grid: string[][] = [];
	for (let row = 0; row < DISPLAY_HEIGHT; row++) {
		const line: string[] = [];
		for (let x = 0; x < WIDTH; x++) {
			line.push(getChar(x, row));
		}
		grid.push(line);
	}
	return grid;
}

export class ArminComponent implements Component {
	private ui: TUI;
	private interval: ReturnType<typeof setInterval> | null = null;
	private effect: Effect;
	private finalGrid: string[][];
	private currentGrid: string[][];
	private effectState: Record<string, unknown> = {};
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private gridVersion = 0;
	private cachedVersion = -1;

	constructor(ui: TUI) {
		this.ui = ui;
		this.effect = EFFECTS[Math.floor(Math.random() * EFFECTS.length)];
		this.finalGrid = buildFinalGrid();
		this.currentGrid = this.createEmptyGrid();

		this.initEffect();
		this.startAnimation();
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		if (width === this.cachedWidth && this.cachedVersion === this.gridVersion) {
			// 只有网格版本或终端宽度变化时才重建带颜色的行，动画帧之间避免重复格式化。
			return this.cachedLines;
		}

		const padding = 1;
		const availableWidth = width - padding;

		this.cachedLines = this.currentGrid.map((row) => {
			// Clip row to available width before applying color
			// 先按字符网格裁剪再加 ANSI 颜色，避免控制序列干扰宽度计算；窄终端只显示左侧可用部分。
			const clipped = row.slice(0, availableWidth).join("");
			const padRight = Math.max(0, width - padding - clipped.length);
			return ` ${theme.fg("accent", clipped)}${" ".repeat(padRight)}`;
		});

		// Add "ARMIN SAYS HI" at the end
		// 文案与图像使用相同左边距和右侧填充，使组件宽度始终匹配当前布局。
		const message = "ARMIN SAYS HI";
		const msgPadRight = Math.max(0, width - padding - message.length);
		this.cachedLines.push(` ${theme.fg("accent", message)}${" ".repeat(msgPadRight)}`);

		this.cachedWidth = width;
		this.cachedVersion = this.gridVersion;

		return this.cachedLines;
	}

	private createEmptyGrid(): string[][] {
		return Array.from({ length: DISPLAY_HEIGHT }, () => Array(WIDTH).fill(" "));
	}

	private initEffect(): void {
		// 每种效果只初始化自身状态；tickEffect 随后按同一 effect 判别并解释该结构。
		switch (this.effect) {
			case "typewriter":
				this.effectState = { pos: 0 };
				break;
			case "scanline":
				this.effectState = { row: 0 };
				break;
			case "rain":
				// Track falling position for each column
				// 每列独立下落并记录已沉积高度，可在不同起始延迟下逐列还原图像。
				this.effectState = {
					drops: Array.from({ length: WIDTH }, () => ({
						y: -Math.floor(Math.random() * DISPLAY_HEIGHT * 2),
						settled: 0,
					})),
				};
				break;
			case "fade": {
				// Shuffle all pixel positions
				// 预先随机排列坐标，后续每帧顺序取一批即可保证每个单元恰好显现一次。
				const positions: [number, number][] = [];
				for (let row = 0; row < DISPLAY_HEIGHT; row++) {
					for (let x = 0; x < WIDTH; x++) {
						positions.push([row, x]);
					}
				}
				// Fisher-Yates shuffle
				// 原地 Fisher-Yates 提供均匀排列，不需要在动画过程中重复随机查重。
				for (let i = positions.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					[positions[i], positions[j]] = [positions[j], positions[i]];
				}
				this.effectState = { positions, idx: 0 };
				break;
			}
			case "crt":
				this.effectState = { expansion: 0 };
				break;
			case "glitch":
				this.effectState = { phase: 0, glitchFrames: 8 };
				break;
			case "dissolve": {
				// Start with random noise
				// 初始噪声覆盖完整网格，再按洗牌坐标逐步替换为目标字符。
				this.currentGrid = Array.from({ length: DISPLAY_HEIGHT }, () =>
					Array.from({ length: WIDTH }, () => {
						const chars = [" ", "░", "▒", "▓", "█", "▀", "▄"];
						return chars[Math.floor(Math.random() * chars.length)];
					}),
				);
				// Shuffle positions for gradual resolve
				const dissolvePositions: [number, number][] = [];
				for (let row = 0; row < DISPLAY_HEIGHT; row++) {
					for (let x = 0; x < WIDTH; x++) {
						dissolvePositions.push([row, x]);
					}
				}
				for (let i = dissolvePositions.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					[dissolvePositions[i], dissolvePositions[j]] = [dissolvePositions[j], dissolvePositions[i]];
				}
				this.effectState = { positions: dissolvePositions, idx: 0 };
				break;
			}
		}
	}

	private startAnimation(): void {
		const fps = this.effect === "glitch" ? 60 : 30;
		// glitch 依赖短暂高频扰动，其余效果以 30fps 降低 TUI 重绘开销。
		this.interval = setInterval(() => {
			const done = this.tickEffect();
			this.updateDisplay();
			this.ui.requestRender();
			if (done) {
				// 完成帧已更新并请求渲染后再停表，确保最终干净图像可见。
				this.stopAnimation();
			}
		}, 1000 / fps);
	}

	private stopAnimation(): void {
		// 方法可重复调用，完成回调与组件 dispose 竞争时不会重复清理。
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	private tickEffect(): boolean {
		switch (this.effect) {
			case "typewriter":
				return this.tickTypewriter();
			case "scanline":
				return this.tickScanline();
			case "rain":
				return this.tickRain();
			case "fade":
				return this.tickFade();
			case "crt":
				return this.tickCrt();
			case "glitch":
				return this.tickGlitch();
			case "dissolve":
				return this.tickDissolve();
			default:
				return true;
		}
	}

	private tickTypewriter(): boolean {
		const state = this.effectState as { pos: number };
		const pixelsPerFrame = 3;

		for (let i = 0; i < pixelsPerFrame; i++) {
			const row = Math.floor(state.pos / WIDTH);
			const x = state.pos % WIDTH;
			if (row >= DISPLAY_HEIGHT) return true;
			this.currentGrid[row][x] = this.finalGrid[row][x];
			state.pos++;
		}
		return false;
	}

	private tickScanline(): boolean {
		const state = this.effectState as { row: number };
		if (state.row >= DISPLAY_HEIGHT) return true;

		// Copy row
		for (let x = 0; x < WIDTH; x++) {
			this.currentGrid[state.row][x] = this.finalGrid[state.row][x];
		}
		state.row++;
		return false;
	}

	private tickRain(): boolean {
		const state = this.effectState as {
			drops: { y: number; settled: number }[];
		};

		let allSettled = true;
		this.currentGrid = this.createEmptyGrid();
		// rain 每帧从空网格重建沉积层和活动落点，避免旧下落字符留下拖影。

		for (let x = 0; x < WIDTH; x++) {
			const drop = state.drops[x];

			// Draw settled pixels
			for (let row = DISPLAY_HEIGHT - 1; row >= DISPLAY_HEIGHT - drop.settled; row--) {
				if (row >= 0) {
					this.currentGrid[row][x] = this.finalGrid[row][x];
				}
			}

			// Check if this column is done
			if (drop.settled >= DISPLAY_HEIGHT) continue;

			allSettled = false;

			// Find the target row for this column (lowest non-space pixel)
			// 当前列从尚未沉积区域寻找最低目标像素，落点到达后一次锁定该段高度。
			let targetRow = -1;
			for (let row = DISPLAY_HEIGHT - 1 - drop.settled; row >= 0; row--) {
				if (this.finalGrid[row][x] !== " ") {
					targetRow = row;
					break;
				}
			}

			// Move drop down
			drop.y++;

			// Draw falling drop
			if (drop.y >= 0 && drop.y < DISPLAY_HEIGHT) {
				if (targetRow >= 0 && drop.y >= targetRow) {
					// Settle
					drop.settled = DISPLAY_HEIGHT - targetRow;
					drop.y = -Math.floor(Math.random() * 5) - 1;
				} else {
					// Still falling
					this.currentGrid[drop.y][x] = "▓";
				}
			}
		}

		return allSettled;
	}

	private tickFade(): boolean {
		const state = this.effectState as { positions: [number, number][]; idx: number };
		const pixelsPerFrame = 15;

		for (let i = 0; i < pixelsPerFrame; i++) {
			if (state.idx >= state.positions.length) return true;
			const [row, x] = state.positions[state.idx];
			this.currentGrid[row][x] = this.finalGrid[row][x];
			state.idx++;
		}
		return false;
	}

	private tickCrt(): boolean {
		const state = this.effectState as { expansion: number };
		const midRow = Math.floor(DISPLAY_HEIGHT / 2);

		this.currentGrid = this.createEmptyGrid();

		// Draw from middle expanding outward
		// 每帧从中心向上下各扩一行，模拟 CRT 图像由中线展开。
		const top = midRow - state.expansion;
		const bottom = midRow + state.expansion;

		for (let row = Math.max(0, top); row <= Math.min(DISPLAY_HEIGHT - 1, bottom); row++) {
			for (let x = 0; x < WIDTH; x++) {
				this.currentGrid[row][x] = this.finalGrid[row][x];
			}
		}

		state.expansion++;
		return state.expansion > DISPLAY_HEIGHT;
	}

	private tickGlitch(): boolean {
		const state = this.effectState as { phase: number; glitchFrames: number };

		if (state.phase < state.glitchFrames) {
			// Glitch phase: show corrupted version
			// 扰动帧从 finalGrid 派生，随机水平偏移或替换整行，不累积前一帧损坏。
			this.currentGrid = this.finalGrid.map((row) => {
				const offset = Math.floor(Math.random() * 7) - 3;
				const glitchRow = [...row];

				// Random horizontal offset
				if (Math.random() < 0.3) {
					const shifted = glitchRow.slice(offset).concat(glitchRow.slice(0, offset));
					return shifted.slice(0, WIDTH);
				}

				// Random vertical swap
				if (Math.random() < 0.2) {
					const swapRow = Math.floor(Math.random() * DISPLAY_HEIGHT);
					return [...this.finalGrid[swapRow]];
				}

				return glitchRow;
			});
			state.phase++;
			return false;
		}

		// Final frame: show clean image
		// 结束时复制目标网格，避免 currentGrid 与 finalGrid 共享行数组后被后续修改。
		this.currentGrid = this.finalGrid.map((row) => [...row]);
		return true;
	}

	private tickDissolve(): boolean {
		const state = this.effectState as { positions: [number, number][]; idx: number };
		const pixelsPerFrame = 20;

		for (let i = 0; i < pixelsPerFrame; i++) {
			if (state.idx >= state.positions.length) return true;
			const [row, x] = state.positions[state.idx];
			this.currentGrid[row][x] = this.finalGrid[row][x];
			state.idx++;
		}
		return false;
	}

	private updateDisplay(): void {
		// 单调版本号使 render 缓存失效，而无需比较整个二维网格。
		this.gridVersion++;
	}

	dispose(): void {
		// TUI 移除组件时必须清理 interval，防止后台继续 requestRender 并保持进程存活。
		this.stopAnimation();
	}
}
