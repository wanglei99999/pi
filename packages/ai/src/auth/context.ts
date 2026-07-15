import type { AuthContext } from "./types.ts";

interface NodeFsModule {
	access(path: string): Promise<void>;
}

interface NodeOsModule {
	homedir(): string;
}

// Variable specifier so browser bundlers do not try to resolve node builtins.
// 使用变量 specifier，避免浏览器 bundler 尝试解析 Node 内置模块。
const importNodeModule = (specifier: string): Promise<unknown> => import(specifier);

function getProcessEnv(): Record<string, string | undefined> | undefined {
	const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
	return proc?.env;
}

/**
 * Default auth context: env vars from `process.env` (undefined in browsers),
 * file existence via node:fs (always false in browsers).
 * 默认认证上下文：环境变量来自 `process.env`（浏览器中为 undefined），
 * 文件存在性通过 node:fs 判断（浏览器中始终为 false）。
 */
export function defaultProviderAuthContext(): AuthContext {
	return {
		async env(name: string): Promise<string | undefined> {
			const value = getProcessEnv()?.[name];
			// 空白字符串不构成有效配置，但有效值保持原样返回，不擅自修改凭证内容。
			return typeof value === "string" && value.trim().length > 0 ? value : undefined;
		},

		async fileExists(path: string): Promise<boolean> {
			try {
				// 延迟导入仅限 Node 的 API，使同一认证探测代码可安全加载到浏览器 bundle 中。
				const fs = (await importNodeModule("node:fs/promises")) as NodeFsModule;
				let resolved = path;
				if (resolved.startsWith("~")) {
					const os = (await importNodeModule("node:os")) as NodeOsModule;
					resolved = os.homedir() + resolved.slice(1);
				}
				await fs.access(resolved);
				return true;
			} catch {
				// 模块不可用与路径不可访问都视为不存在；认证探测不应因可选凭证文件而抛错。
				return false;
			}
		},
	};
}
