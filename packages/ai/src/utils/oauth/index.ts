/**
 * OAuth credential management for AI providers.
 * AI 提供商的 OAuth 凭证管理入口。
 *
 * This module handles login, token refresh, and credential storage
 * 此模块统一暴露 OAuth 提供商的登录、token 刷新和凭证存储能力，
 * for OAuth-based providers:
 * 当前内置支持：
 * - Anthropic (Claude Pro/Max)
 * - GitHub Copilot
 */

// Anthropic
// Anthropic 登录与刷新实现
export { anthropicOAuthProvider, loginAnthropic, refreshAnthropicToken } from "./anthropic.ts";
export * from "./device-code.ts";
// GitHub Copilot
// GitHub Copilot 登录与刷新实现
export {
	getGitHubCopilotBaseUrl,
	githubCopilotOAuthProvider,
	loginGitHubCopilot,
	normalizeDomain,
	refreshGitHubCopilotToken,
} from "./github-copilot.ts";
// OpenAI Codex (ChatGPT OAuth)
// OpenAI Codex 的浏览器与 device-code 登录实现
// 具体登录交互和用户取消语义由各提供商实现负责，此入口只负责导出与注册分派。
export {
	loginOpenAICodex,
	loginOpenAICodexDeviceCode,
	OPENAI_CODEX_BROWSER_LOGIN_METHOD,
	OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD,
	openaiCodexOAuthProvider,
	refreshOpenAICodexToken,
} from "./openai-codex.ts";

export * from "./types.ts";

// ============================================================================
// Provider Registry
// OAuth 提供商注册表
// ============================================================================

import { anthropicOAuthProvider } from "./anthropic.ts";
import { githubCopilotOAuthProvider } from "./github-copilot.ts";
import { openaiCodexOAuthProvider } from "./openai-codex.ts";
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInfo, OAuthProviderInterface } from "./types.ts";

const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [
	anthropicOAuthProvider,
	githubCopilotOAuthProvider,
	openaiCodexOAuthProvider,
];

const oauthProviderRegistry = new Map<string, OAuthProviderInterface>(
	BUILT_IN_OAUTH_PROVIDERS.map((provider) => [provider.id, provider]),
);

/**
 * Get an OAuth provider by ID
 * 按 ID 获取当前生效的 OAuth 提供商实现。
 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return oauthProviderRegistry.get(id);
}

/**
 * Register a custom OAuth provider
 * 注册自定义 OAuth 提供商；同 ID 注册会覆盖当前实现，包括内置实现。
 */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	oauthProviderRegistry.set(provider.id, provider);
}

/**
 * Unregister an OAuth provider.
 * 注销 OAuth 提供商。
 *
 * If the provider is built-in, restores the built-in implementation.
 * 若该 ID 属于内置提供商，则恢复内置实现，
 * Custom providers are removed completely.
 * 而不是从注册表中彻底删除；纯自定义提供商则会被完全移除。
 */
export function unregisterOAuthProvider(id: string): void {
	const builtInProvider = BUILT_IN_OAUTH_PROVIDERS.find((provider) => provider.id === id);
	if (builtInProvider) {
		oauthProviderRegistry.set(id, builtInProvider);
		return;
	}
	oauthProviderRegistry.delete(id);
}

/**
 * Reset OAuth providers to built-ins.
 * 清空所有覆盖和自定义注册，并恢复内置 OAuth 提供商集合。
 */
export function resetOAuthProviders(): void {
	oauthProviderRegistry.clear();
	for (const provider of BUILT_IN_OAUTH_PROVIDERS) {
		oauthProviderRegistry.set(provider.id, provider);
	}
}

/**
 * Get all registered OAuth providers
 * 获取当前注册表中的全部 OAuth 提供商实现。
 */
export function getOAuthProviders(): OAuthProviderInterface[] {
	return Array.from(oauthProviderRegistry.values());
}

/**
 * @deprecated Use getOAuthProviders() which returns OAuthProviderInterface[]
 * @deprecated 请使用返回 OAuthProviderInterface[] 的 getOAuthProviders()。
 */
export function getOAuthProviderInfoList(): OAuthProviderInfo[] {
	return getOAuthProviders().map((p) => ({
		id: p.id,
		name: p.name,
		available: true,
	}));
}

// ============================================================================
// High-level API (uses provider registry)
// 使用提供商注册表的高层兼容 API
// ============================================================================

/**
 * Refresh token for any OAuth provider.
 * 按 providerId 分派到对应提供商并刷新 token。
 * @deprecated Use getOAuthProvider(id).refreshToken() instead
 * @deprecated 请改用 getOAuthProvider(id).refreshToken()。
 */
export async function refreshOAuthToken(
	providerId: OAuthProviderId,
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}
	return provider.refreshToken(credentials);
}

/**
 * Get API key for a provider from OAuth credentials.
 * 从指定提供商的 OAuth 凭证解析 API key。
 * Automatically refreshes expired tokens.
 * token 过期时会先刷新，并把更新后的凭证与 API key 一同返回，供调用方持久化。
 *
 * @returns API key string and updated credentials, or null if no credentials
 * @returns API key 和更新后的凭证；没有该提供商凭证时返回 null
 * @throws Error if refresh fails
 * @throws Error token 刷新失败时抛出；不会用已过期凭证继续请求
 */
export async function getOAuthApiKey(
	providerId: OAuthProviderId,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}

	// 不原地修改调用方的凭证记录；刷新结果通过 newCredentials 显式交还调用方保存。
	let creds = credentials[providerId];
	if (!creds) {
		return null;
	}

	// Refresh if expired
	// 仅在凭证已过期时刷新；未过期凭证保持原样返回
	if (Date.now() >= creds.expires) {
		try {
			creds = await provider.refreshToken(creds);
		} catch (_error) {
			// 高层兼容 API 保持统一错误契约，不泄露各提供商的刷新错误细节。
			throw new Error(`Failed to refresh OAuth token for ${providerId}`);
		}
	}

	const apiKey = provider.getApiKey(creds);
	return { newCredentials: creds, apiKey };
}
