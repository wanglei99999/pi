import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProcessSync } from "./child-process.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export interface PathInputOptions {
	/** Trim leading/trailing whitespace before normalization. */
	/** 规范化前移除首尾空白。 */
	trim?: boolean;
	/** Expand leading `~` to a home directory. Defaults to true. */
	/** 将开头的 `~` 展开为主目录，默认启用。 */
	expandTilde?: boolean;
	/** Home directory used for `~` expansion. Defaults to `os.homedir()`. */
	/** `~` 展开使用的主目录，默认取 `os.homedir()`。 */
	homeDir?: string;
	/** Strip a leading `@`, used for CLI @file paths. */
	/** 移除开头的 `@`，用于 CLI 的 @file 路径语法。 */
	stripAtPrefix?: boolean;
	/** Normalize unicode space variants to regular spaces. */
	/** 把多种 Unicode 空格统一为普通空格。 */
	normalizeUnicodeSpaces?: boolean;
}

/**
 * Resolve a path to its canonical (real) form, following symlinks.
 * 跟随符号链接，将路径解析为规范的真实路径。
 * Falls back to the raw path if resolution fails (e.g. the target does
 * not exist yet), so that callers never crash on missing filesystem
 * entries.
 * 解析失败时（例如目标尚未创建）返回原始路径，使调用方不会因缺失文件系统条目而崩溃。
 */
export function canonicalizePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Returns true if the value is NOT a package source (npm:, git:, etc.)
 * or a remote URL protocol. Bare names, relative paths, and file: URLs
 * are considered local.
 * 当值不是包来源或远程 URL 协议时返回 true；裸名称、相对路径和 file: URL 均视为本地路径。
 */
export function isLocalPath(value: string): boolean {
	const trimmed = value.trim();
	// Known non-local prefixes. file: URLs are local paths and are intentionally resolved by resolvePath().
	// 这里只排除已知远程前缀；file: URL 刻意保留为本地路径，交给 resolvePath() 转换。
	if (
		trimmed.startsWith("npm:") ||
		trimmed.startsWith("git:") ||
		trimmed.startsWith("github:") ||
		trimmed.startsWith("http:") ||
		trimmed.startsWith("https:") ||
		trimmed.startsWith("ssh:")
	) {
		return false;
	}
	return true;
}

export function normalizePath(input: string, options: PathInputOptions = {}): string {
	// 处理顺序固定为清理输入、移除 CLI 前缀、展开主目录、转换 file URL，避免后一步掩盖前一步语法。
	let normalized = options.trim ? input.trim() : input;
	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(UNICODE_SPACES, " ");
	}
	if (options.stripAtPrefix && normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}

	if (options.expandTilde ?? true) {
		// 只展开独立的 ~ 或 ~/、~\ 前缀，不实现 shell 的 ~user 账户查找语义。
		const home = options.homeDir ?? homedir();
		if (normalized === "~") return home;
		if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
			return join(home, normalized.slice(2));
		}
	}

	if (/^file:\/\//.test(normalized)) {
		// 使用标准 URL 转换处理平台盘符、转义字符和 UNC 路径，而非手工截取前缀。
		return fileURLToPath(normalized);
	}

	return normalized;
}

export function resolvePath(input: string, baseDir: string = process.cwd(), options: PathInputOptions = {}): string {
	// resolvePath 只生成绝对规范形式，不跟随符号链接；需要真实路径时另行调用 canonicalizePath。
	const normalized = normalizePath(input, options);
	const normalizedBaseDir = normalizePath(baseDir);
	return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
}

export function getCwdRelativePath(filePath: string, cwd: string): string | undefined {
	// path.relative 后同时排除 .. 前缀和绝对结果，避免把兄弟目录或不同 Windows 盘符误判为 cwd 内部。
	const resolvedCwd = resolvePath(cwd);
	const resolvedPath = resolvePath(filePath, resolvedCwd);
	const relativePath = relative(resolvedCwd, resolvedPath);
	const isInsideCwd =
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));

	return isInsideCwd ? relativePath || "." : undefined;
}

export function formatPathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string {
	// cwd 内路径优先缩短为相对形式，外部路径保留绝对形式；最终统一为 / 便于日志和提示词跨平台展示。
	const absolutePath = resolvePath(filePath, cwd);
	return (getCwdRelativePath(absolutePath, cwd) ?? absolutePath).split(sep).join("/");
}

export function markPathIgnoredByCloudSync(path: string): void {
	// macOS/Linux 通过扩展属性提示 Dropbox/File Provider 忽略目录；其他平台保持无操作。
	const attrs =
		process.platform === "darwin"
			? ["com.dropbox.ignored", "com.apple.fileprovider.ignore#P"]
			: process.platform === "linux"
				? ["user.com.dropbox.ignored"]
				: [];

	for (const attr of attrs) {
		// 逐项写入当前平台配置的属性，命令输出被抑制，避免可选优化干扰主流程界面。
		if (process.platform === "darwin") {
			spawnProcessSync("xattr", ["-w", attr, "1", path], { encoding: "utf-8", stdio: "ignore" });
		} else {
			spawnProcessSync("setfattr", ["-n", attr, "-v", "1", path], { encoding: "utf-8", stdio: "ignore" });
		}
	}
}
