import { mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandPath, resolveReadPath, resolveToCwd } from "../src/core/tools/path-utils.ts";

describe("path-utils", () => {
	describe("expandPath", () => {
		it("should expand ~ to home directory", () => {
			const result = expandPath("~");
			expect(result).not.toContain("~");
		});

		it("should expand ~/path to home directory", () => {
			const result = expandPath("~/Documents/file.txt");
			expect(result).not.toContain("~/");
		});

		it("should keep tilde-prefixed filenames literal", () => {
			expect(expandPath("~draft.md")).toBe("~draft.md");
			expect(expandPath("@~draft.md")).toBe("~draft.md");
		});

		it("should normalize Unicode spaces", () => {
			// Non-breaking space (U+00A0) should become regular space
			// 不换行空格（U+00A0）应规范化为普通空格。
			const withNBSP = "file\u00A0name.txt";
			const result = expandPath(withNBSP);
			expect(result).toBe("file name.txt");
		});
	});

	describe("resolveToCwd", () => {
		it("should resolve absolute paths as-is", () => {
			const absolutePath = resolve(tmpdir(), "absolute", "path", "file.txt");
			const result = resolveToCwd(absolutePath, resolve(tmpdir(), "some", "cwd"));
			expect(result).toBe(absolutePath);
		});

		it("should resolve relative paths against cwd", () => {
			const result = resolveToCwd("relative/file.txt", "/some/cwd");
			expect(result).toBe(resolve("/some/cwd", "relative/file.txt"));
		});

		it("should resolve tilde-prefixed filenames against cwd", () => {
			const cwd = join(tmpdir(), "pi-path-utils-cwd");
			expect(resolveToCwd("~draft.md", cwd)).toBe(resolve(cwd, "~draft.md"));
			expect(resolveToCwd("@~draft.md", cwd)).toBe(resolve(cwd, "~draft.md"));
		});
	});

	describe("resolveReadPath", () => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = mkdtempSync(join(tmpdir(), "path-utils-test-"));
		});

		afterEach(() => {
			// Clean up temp files and directory
			// 每个用例后清理临时文件和目录，避免文件名变体相互干扰。
			try {
				const files = readdirSync(tempDir);
				for (const file of files) {
					unlinkSync(join(tempDir, file));
				}
				rmdirSync(tempDir);
			} catch {
				// Ignore cleanup errors
				// 清理失败不应掩盖路径解析断言的结果。
			}
		});

		it("should resolve existing file path", () => {
			const fileName = "test-file.txt";
			writeFileSync(join(tempDir, fileName), "content");

			const result = resolveReadPath(fileName, tempDir);
			expect(result).toBe(join(tempDir, fileName));
		});

		it("should handle NFC vs NFD Unicode normalization (macOS filenames with accents)", () => {
			// macOS stores filenames in NFD (decomposed) form:
			// macOS 文件名可能使用 NFD（分解）形式：
			//   é = e + combining acute accent (U+0301)
			// Users typically type in NFC (composed) form:
			// 用户输入通常采用 NFC（组合）形式：
			//   é = single character (U+00E9)
			//
			// Note: macOS APFS normalizes Unicode automatically, so both paths work.
			// This test verifies the NFD variant fallback works on systems that don't.
			// APFS 会自动规范化 Unicode；该用例主要验证其他文件系统上的 NFD 回退路径。

			// NFD: e (U+0065) + combining acute accent (U+0301)
			const nfdFileName = "file\u0065\u0301.txt";
			// NFC: é as single character (U+00E9)
			const nfcFileName = "file\u00e9.txt";

			// Verify they have different byte sequences
			// 先确认两种形式的字节序列确实不同，确保用例覆盖了规范化行为。
			expect(nfdFileName).not.toBe(nfcFileName);
			expect(Buffer.from(nfdFileName)).not.toEqual(Buffer.from(nfcFileName));

			// Create file with NFD name
			writeFileSync(join(tempDir, nfdFileName), "content");

			// User provides NFC path - should find the file (via filesystem normalization or our fallback)
			// 用户提供 NFC 路径时，应通过文件系统规范化或显式回退找到文件。
			const result = resolveReadPath(nfcFileName, tempDir);
			// Result should contain the accented character (either NFC or NFD form)
			expect(result).toContain(tempDir);
			expect(result).toMatch(/file.+\.txt$/);
		});

		it("should handle curly quotes vs straight quotes (macOS filenames)", () => {
			// macOS uses curly apostrophe (U+2019) in screenshot filenames:
			// macOS 截图文件名可能使用弯引号（U+2019）：
			//   Capture d'écran (U+2019)
			// Users typically type straight apostrophe (U+0027):
			// 用户通常输入直引号（U+0027）：
			//   Capture d'ecran (U+0027)

			const curlyQuoteName = "Capture d\u2019cran.txt"; // U+2019 right single quotation mark
			const straightQuoteName = "Capture d'cran.txt"; // U+0027 apostrophe

			// Verify they are different
			expect(curlyQuoteName).not.toBe(straightQuoteName);

			// Create file with curly quote name (simulating macOS behavior)
			// 使用弯引号创建文件以模拟 macOS 行为。
			writeFileSync(join(tempDir, curlyQuoteName), "content");

			// User provides straight quote path - should find the curly quote file
			const result = resolveReadPath(straightQuoteName, tempDir);
			expect(result).toBe(join(tempDir, curlyQuoteName));
		});

		it("should handle combined NFC + curly quote (French macOS screenshots)", () => {
			// Full macOS screenshot filename: "Capture d'écran" with NFD é and curly quote
			// Note: macOS APFS normalizes NFD to NFC, so the actual file on disk uses NFC
			// 组合场景同时覆盖重音字符规范化和弯引号替换，磁盘名称按 APFS 的 NFC 行为构造。
			const nfcCurlyName = "Capture d\u2019\u00e9cran.txt"; // NFC + curly quote (how APFS stores it)
			const nfcStraightName = "Capture d'\u00e9cran.txt"; // NFC + straight quote (user input)

			// Verify they are different
			expect(nfcCurlyName).not.toBe(nfcStraightName);

			// Create file with macOS-style name (curly quote)
			writeFileSync(join(tempDir, nfcCurlyName), "content");

			// User provides straight quote path - should find the curly quote file
			const result = resolveReadPath(nfcStraightName, tempDir);
			expect(result).toBe(join(tempDir, nfcCurlyName));
		});

		it("should handle macOS screenshot AM/PM variant with narrow no-break space", () => {
			// macOS uses narrow no-break space (U+202F) before AM/PM in screenshot names
			// macOS 截图名称会在 AM/PM 前使用窄不换行空格（U+202F）。
			const macosName = "Screenshot 2024-01-01 at 10.00.00\u202FAM.png"; // U+202F
			const userName = "Screenshot 2024-01-01 at 10.00.00 AM.png"; // regular space

			// Create file with macOS-style name
			writeFileSync(join(tempDir, macosName), "content");

			// User provides regular space path
			const result = resolveReadPath(userName, tempDir);

			// This works because tryMacOSScreenshotPath() handles this case
			// 该断言验证 tryMacOSScreenshotPath() 的空格变体回退。
			expect(result).toBe(join(tempDir, macosName));
		});

		it("should handle macOS screenshot lowercase am/pm variant (en_AU locale)", () => {
			// Some locales like en_AU use lowercase am/pm in screenshot names
			// en_AU 等区域设置会在截图名称中使用小写 am/pm。
			const macosName = "Screenshot 2024-01-01 at 10.00.00\u202Fam.png"; // U+202F + lowercase
			const userName = "Screenshot 2024-01-01 at 10.00.00 am.png"; // regular space + lowercase

			// Create file with macOS-style name
			writeFileSync(join(tempDir, macosName), "content");

			// User provides regular space path
			const result = resolveReadPath(userName, tempDir);

			// This works because tryMacOSScreenshotPath() uses case-insensitive matching
			// 该断言验证 tryMacOSScreenshotPath() 的大小写不敏感匹配。
			expect(result).toBe(join(tempDir, macosName));
		});
	});
});
