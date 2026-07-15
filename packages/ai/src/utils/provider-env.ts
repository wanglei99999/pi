import type { ProviderEnv } from "../types.ts";

let procEnvCache: Map<string, string> | null = null;

/**
 * Fallback for https://github.com/oven-sh/bun/issues/27802.
 * 针对 https://github.com/oven-sh/bun/issues/27802 的回退处理。
 * Bun compiled binaries can expose an empty process.env inside Linux sandboxes
 * even though /proc/self/environ contains the environment.
 * Bun 编译产物在 Linux 沙箱中可能看到空的 process.env，但实际环境仍存在于 /proc/self/environ。
 *
 * This intentionally duplicates restoreSandboxEnv() in
 * packages/coding-agent/src/bun/restore-sandbox-env.ts. The ai package can be
 * used directly, without going through that entrypoint, so provider env lookup
 * must not depend on process.env having been patched.
 * 此处刻意重复 restoreSandboxEnv() 的逻辑：ai 包可以绕过 coding-agent 入口独立使用，
 * 因此提供商环境查找不能依赖其他入口已经修补 process.env。
 */
function getBunSandboxEnvValue(name: string): string | undefined {
	if (typeof process === "undefined" || !process.versions?.bun || Object.keys(process.env).length > 0) {
		return undefined;
	}

	if (procEnvCache === null) {
		// /proc/self/environ 只读取和解析一次；失败也缓存为空映射，避免每次变量查找重复访问文件系统。
		procEnvCache = new Map();
		try {
			const { readFileSync } = require("node:fs") as {
				readFileSync(path: string, encoding: BufferEncoding): string;
			};
			const data = readFileSync("/proc/self/environ", "utf-8");
			for (const entry of data.split("\0")) {
				const idx = entry.indexOf("=");
				if (idx > 0) {
					procEnvCache.set(entry.slice(0, idx), entry.slice(idx + 1));
				}
			}
		} catch {
			// /proc/self/environ may not exist or may not be readable.
			// /proc/self/environ 可能不存在或不可读；回退失败时按未设置处理。
		}
	}

	return procEnvCache.get(name);
}

/**
 * Resolve a provider env value from scoped overrides, normal process.env, then
 * the duplicated Bun sandbox fallback for direct pi-ai consumers.
 * 按顺序从调用方作用域覆盖、正常 process.env、Bun 沙箱回退中解析提供商环境值。
 * 空字符串不视为显式值，会继续尝试下一来源；这与原有基于真值的配置语义保持一致。
 */
export function getProviderEnvValue(name: string, env?: ProviderEnv): string | undefined {
	return (
		env?.[name] ||
		(typeof process !== "undefined" ? process.env[name] : undefined) ||
		getBunSandboxEnvValue(name) ||
		undefined
	);
}
