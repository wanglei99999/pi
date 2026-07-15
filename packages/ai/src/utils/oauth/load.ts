import type { OAuthAuth } from "../../auth/types.ts";

/**
 * Loads an OAuth flow module through a variable specifier so bundlers cannot
 * follow the import into Node-only flow code (`node:http` callback servers,
 * `node:crypto` PKCE). The `.ts`/`.js` rewrite keeps the trick working from
 * both source and built output.
 */
/**
 * 通过变量形式的模块说明符加载 OAuth 流程，使打包器无法静态追踪到仅限 Node 的流程代码
 *（`node:http` 回调服务器和 `node:crypto` PKCE）。运行时改写 `.ts`/`.js` 后缀，
 * 让该隔离方式在源码运行和构建产物中均能生效。
 */
const importOAuthModule = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

export const loadAnthropicOAuth = async (): Promise<OAuthAuth> =>
	((await importOAuthModule("./anthropic.ts")) as { anthropicOAuth: OAuthAuth }).anthropicOAuth;

export const loadOpenAICodexOAuth = async (): Promise<OAuthAuth> =>
	((await importOAuthModule("./openai-codex.ts")) as { openaiCodexOAuth: OAuthAuth }).openaiCodexOAuth;

export const loadGitHubCopilotOAuth = async (): Promise<OAuthAuth> =>
	((await importOAuthModule("./github-copilot.ts")) as { githubCopilotOAuth: OAuthAuth }).githubCopilotOAuth;
