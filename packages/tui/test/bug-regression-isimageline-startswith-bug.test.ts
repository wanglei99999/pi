/**
 * Bug regression test for isImageLine() crash scenario
 *
 * Bug: When isImageLine() used startsWith() and terminal doesn't support images,
 * it would return false for lines containing image escape sequences, causing TUI to
 * crash with "Rendered line exceeds terminal width" error.
 *
 * Fix: Changed to use includes() to detect escape sequences anywhere in the line.
 *
 * This test demonstrates:
 * 1. The bug scenario with the old implementation
 * 2. That the fix works correctly
 *
 * isImageLine() 崩溃场景的回归测试：无图片能力的终端无法提供当前 prefix，
 * 旧实现因此把包含图片 escape sequence 的超长行当作普通文本并执行宽度检查。
 * 修复后使用 includes() 检测行内任意位置的 sequence；测试同时覆盖旧行为和修复边界。
 */

import assert from "node:assert";
import { describe, it } from "node:test";

describe("Bug regression: isImageLine() crash with image escape sequences", () => {
	describe("Bug scenario: Terminal without image support", () => {
		it("old implementation would return false, causing crash", () => {
			/**
			 * OLD IMPLEMENTATION (buggy):
			 * ```typescript
			 * export function isImageLine(line: string): boolean {
			 *   const prefix = getImageEscapePrefix();
			 *   return prefix !== null && line.startsWith(prefix);
			 * }
			 * ```
			 *
			 * When terminal doesn't support images:
			 * - getImageEscapePrefix() returns null
			 * - isImageLine() returns false even for lines containing image sequences
			 * - TUI performs width check on line containing 300KB+ of base64 data
			 * - Crash: "Rendered line exceeds terminal width (304401 > 115)"
			 *
			 * 旧实现把 terminal capability 与内容识别错误地绑定在一起；prefix 为 null 时，
			 * 即使行内已有图片 sequence 也会落入普通文本宽度检查，并被巨大的 base64 payload 触发崩溃。
			 */

			// Simulate old implementation behavior
			// 模拟旧实现，用于证明回归测试确实覆盖原始失败路径。
			const oldIsImageLine = (line: string, imageEscapePrefix: string | null): boolean => {
				return imageEscapePrefix !== null && line.startsWith(imageEscapePrefix);
			};

			// When terminal doesn't support images, prefix is null
			// 终端不支持图片时 prefix 为 null，这是旧逻辑误判的关键前置条件。
			const terminalWithoutImageSupport = null;

			// Line containing image escape sequence with text before it (common bug scenario)
			// 图片 escape sequence 前带普通文本，确保测试不是仅覆盖 sequence 位于行首的简单情况。
			const lineWithImageSequence =
				"Read image file [image/jpeg]\x1b]1337;File=size=800,600;inline=1:base64data...\x07";

			// Old implementation would return false (BUG!)
			// 断言旧实现返回 false，以固定此前会进入宽度检查的错误行为。
			const oldResult = oldIsImageLine(lineWithImageSequence, terminalWithoutImageSupport);
			assert.strictEqual(
				oldResult,
				false,
				"Bug: old implementation returns false for line containing image sequence when terminal has no image support",
			);
		});

		it("new implementation returns true correctly", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			// Line containing image escape sequence with text before it
			// 修复后的实现必须识别前面带文本的同一类图片 sequence。
			const lineWithImageSequence =
				"Read image file [image/jpeg]\x1b]1337;File=size=800,600;inline=1:base64data...\x07";

			// New implementation should return true (FIX!)
			// true 表示该行按图片输出处理，从而绕过普通文本宽度检查。
			const newResult = isImageLine(lineWithImageSequence);
			assert.strictEqual(newResult, true, "Fix: new implementation returns true for line containing image sequence");
		});

		it("new implementation detects Kitty sequences in any position", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			const scenarios = [
				"At start: \x1b_Ga=T,f=100,data...\x1b\\",
				"Prefix \x1b_Ga=T,data...\x1b\\",
				"Suffix text \x1b_Ga=T,data...\x1b\\ suffix",
				"Middle \x1b_Ga=T,data...\x1b\\ more text",
				// Very long line (simulating 300KB+ crash scenario)
				// 超长 payload 复现 300KB+ 崩溃规模，并验证 Kitty sequence 可位于任意位置。
				`Text before \x1b_Ga=T,f=100${"A".repeat(300000)} text after`,
			];

			for (const line of scenarios) {
				assert.strictEqual(isImageLine(line), true, `Should detect Kitty sequence in: ${line.slice(0, 50)}...`);
			}
		});

		it("new implementation detects iTerm2 sequences in any position", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			const scenarios = [
				"At start: \x1b]1337;File=size=100,100:base64...\x07",
				"Prefix \x1b]1337;File=inline=1:data==\x07",
				"Suffix text \x1b]1337;File=inline=1:data==\x07 suffix",
				"Middle \x1b]1337;File=inline=1:data==\x07 more text",
				// Very long line (simulating 304KB crash scenario)
				// 使用接近 304KB 的 payload 验证 iTerm2 sequence 同样不依赖行首位置。
				`Text before \x1b]1337;File=size=800,600;inline=1:${"B".repeat(300000)} text after`,
			];

			for (const line of scenarios) {
				assert.strictEqual(isImageLine(line), true, `Should detect iTerm2 sequence in: ${line.slice(0, 50)}...`);
			}
		});
	});

	describe("Integration: Tool execution scenario", () => {
		/**
		 * This simulates what happens when the `read` tool reads an image file.
		 * The tool result contains both text and image content:
		 *
		 * ```typescript
		 * {
		 *   content: [
		 *     { type: "text", text: "Read image file [image/jpeg]\n800x600" },
		 *     { type: "image", data: "base64...", mimeType: "image/jpeg" }
		 *   ]
		 * }
		 * ```
		 *
		 * When this is rendered, the image component creates escape sequences.
		 * If isImageLine() doesn't detect them, TUI crashes.
		 *
		 * 此集成场景模拟 `read` 同时返回文本与图片内容；渲染后的同一行可能包含普通文本和
		 * 图片 escape sequence。isImageLine() 必须按内容识别该行，不能依赖终端能力或行首位置。
		 */

		it("detects image sequences in read tool output", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			// Simulate output when read tool processes an image
			// The line might have text from the read result plus the image escape sequence
			// 模拟 read tool 处理图片后的混合输出：文本结果与图片 escape sequence 位于同一行。
			const toolOutputLine = "Read image file [image/jpeg]\x1b]1337;File=size=800,600;inline=1:base64image...\x07";

			assert.strictEqual(isImageLine(toolOutputLine), true, "Should detect image sequence in tool output line");
		});

		it("detects Kitty sequences from Image component", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			// Kitty image component creates multi-line output with escape sequences
			// Kitty Image component 可能生成包含多个 escape sequence 的行，任一有效 sequence 都应被识别。
			const kittyLine = "\x1b_Ga=T,f=100,t=f,d=base64data...\x1b\\\x1b_Gm=i=1;\x1b\\";

			assert.strictEqual(isImageLine(kittyLine), true, "Should detect Kitty image component output");
		});

		it("handles ANSI codes before image sequences", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			// Line might have styling (error, warning, etc.) before image data
			// 图片数据前可能存在 ANSI 样式；样式前缀不应遮蔽后续图片 sequence。
			const lines = [
				"\x1b[31mError\x1b[0m: \x1b]1337;File=inline=1:base64==\x07",
				"\x1b[33mWarning\x1b[0m: \x1b_Ga=T,data...\x1b\\",
				"\x1b[1mBold\x1b[0m \x1b]1337;File=:base64==\x07\x1b[0m",
			];

			for (const line of lines) {
				assert.strictEqual(
					isImageLine(line),
					true,
					`Should detect image sequence after ANSI codes: ${line.slice(0, 30)}...`,
				);
			}
		});
	});

	describe("Crash scenario simulation", () => {
		it("does NOT crash on very long lines with image sequences", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			/**
			 * Simulate the exact crash scenario:
			 * - Line is 304,401 characters (the crash log showed 58649 > 115)
			 * - Contains image escape sequence somewhere in the middle
			 * - Old implementation would return false, causing TUI to do width check
			 * - New implementation returns true, skipping width check (preventing crash)
			 *
			 * 此处按真实崩溃量级构造超长行，并把图片 sequence 放在中间；预期边界不是测量
			 * 终端宽度，而是必须先识别图片行并跳过普通文本宽度校验。
			 */

			const base64Char = "A".repeat(100);
			const iterm2Sequence = "\x1b]1337;File=size=800,600;inline=1:";

			// Build a line that would cause the crash
			// 构造旧实现会送入宽度检查并触发崩溃的行。
			const crashLine =
				"Output: " +
				iterm2Sequence +
				base64Char.repeat(3040) + // ~304,000 chars
				// 上一段保持约 304,000 字符，以匹配原始崩溃的 payload 量级。
				" end of output";

			// Verify line is very long
			// 先固定输入规模，防止测试数据缩小后失去回归价值。
			assert(crashLine.length > 300000, "Test line should be > 300KB");

			// New implementation should detect it (prevents crash)
			// 修复后的检测必须在不扫描终端列宽的情况下识别该 sequence。
			const detected = isImageLine(crashLine);
			assert.strictEqual(detected, true, "Should detect image sequence in very long line, preventing TUI crash");
		});

		it("handles lines exactly matching crash log dimensions", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			/**
			 * Crash log showed: line 58649 chars wide, terminal width 115
			 * Let's create a line with similar characteristics
			 *
			 * 使用崩溃日志中的行宽与终端宽度量级，验证修复覆盖实际报告的边界条件。
			 */

			const targetWidth = 58649;
			const prefix = "Text";
			const sequence = "\x1b_Ga=T,f=100";
			const suffix = "End";
			const padding = "A".repeat(targetWidth - prefix.length - sequence.length - suffix.length);
			const line = `${prefix}${sequence}${padding}${suffix}`;

			assert.strictEqual(line.length, 58649);
			assert.strictEqual(isImageLine(line), true, "Should detect image sequence in 58649-char line");
		});
	});

	describe("Negative cases: Don't false positive", () => {
		it("does not detect images in regular long text", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			// Very long line WITHOUT image sequences
			// 超长本身不能构成图片行；缺少有效 sequence 时必须保持 false，避免误报。
			const longText = "A".repeat(100000);

			assert.strictEqual(isImageLine(longText), false, "Should not detect images in plain long text");
		});

		it("does not detect images in lines with file paths", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			const filePaths = [
				"/path/to/1337/image.jpg",
				"/usr/local/bin/File_converter",
				"~/Documents/1337File_backup.png",
				"./_G_test_file.txt",
			];

			for (const path of filePaths) {
				assert.strictEqual(isImageLine(path), false, `Should not falsely detect image sequence in path: ${path}`);
			}
		});
	});
});
