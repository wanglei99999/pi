import type { ApiKeyAuth, OAuthAuth } from "./types.ts";

/**
 * Standard api-key auth: a stored credential key wins, otherwise the first
 * set env var resolves. Includes a `login` that prompts for the key.
 * Providers with non-standard resolution (provider env, ambient files, IAM)
 * write their own `ApiKeyAuth`.
 * 标准 API key 认证优先使用已保存凭据，否则按顺序读取首个有效环境变量，并提供交互式登录。
 * 依赖提供商环境、外部凭据文件或 IAM 的特殊来源应自行实现 `ApiKeyAuth`。
 */
export function envApiKeyAuth(name: string, envVars: readonly string[]): ApiKeyAuth {
	return {
		name,
		login: async (interaction) => {
			const key = await interaction.prompt({ type: "secret", message: `Enter ${name}` });
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential }) => {
			if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
			for (const envVar of envVars) {
				const value = await ctx.env(envVar);
				if (value) return { auth: { apiKey: value }, source: envVar };
			}
			return undefined;
		},
	};
}

/**
 * Wraps a dynamically imported `OAuthAuth` so provider definitions can
 * advertise OAuth without importing the implementation. The flow loads on
 * first `login`/`refresh`/`toAuth` call; callers keep Node-only flow code out
 * of bundles by loading through a bundler-opaque dynamic import (variable
 * specifier, see the bedrock lazy wrapper).
 * 延迟包装使提供商可以声明 OAuth 能力而不立即加载实现；首次 login、refresh 或 toAuth 时才加载。
 * 这样浏览器等 bundle 不会意外包含仅限 Node 的授权流程，且所有入口共享同一个加载 Promise。
 */
export function lazyOAuth(input: { name: string; loginLabel?: string; load: () => Promise<OAuthAuth> }): OAuthAuth {
	let promise: Promise<OAuthAuth> | undefined;
	const loaded = () => {
		promise ??= input.load();
		return promise;
	};
	return {
		name: input.name,
		loginLabel: input.loginLabel,
		login: async (interaction) => (await loaded()).login(interaction),
		refresh: async (credential) => (await loaded()).refresh(credential),
		toAuth: async (credential) => (await loaded()).toAuth(credential),
	};
}
