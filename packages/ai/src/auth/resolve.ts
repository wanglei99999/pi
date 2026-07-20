import type { ProviderEnv } from "../types.ts";
import type {
	ApiKeyAuth,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Credential,
	CredentialStore,
	OAuthAuth,
	OAuthCredential,
	ProviderAuth,
} from "./types.ts";

export type ModelsErrorCode = "model_source" | "model_validation" | "provider" | "stream" | "auth" | "oauth";

export interface AuthResolutionOverrides {
	apiKey?: string;
	env?: ProviderEnv;
}

export class ModelsError extends Error {
	readonly code: ModelsErrorCode;

	constructor(code: ModelsErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ModelsError";
		this.code = code;
	}
}

/**
 * Auth resolution shared by the `Models` and `ImagesModels` collections.
 * A stored credential owns the provider: ambient/env is consulted only when
 * nothing is stored. No silent env fallback after a failed refresh or for a
 * credential type without a matching handler.
 */
/**
 * `Models` 与 `ImagesModels` 集合共用的认证解析逻辑。
 * 已存储凭据确定其所属提供商；仅在没有存储凭据时才查询环境变量等外部认证来源。
 * 刷新失败或凭据类型没有匹配处理器时，不会静默回退到环境认证。
 */
export async function resolveProviderAuth(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides?: AuthResolutionOverrides,
): Promise<AuthResult | undefined> {
	const requestAuthContext = overrides?.env ? overlayEnvAuthContext(authContext, overrides.env) : authContext;

	if (overrides?.apiKey !== undefined && provider.auth.apiKey) {
		return resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, {
			type: "api_key",
			key: overrides.apiKey,
			env: overrides.env,
		});
	}

	const stored = await readCredential(credentials, provider.id);
	if (stored) {
		if (stored.type === "oauth" && provider.auth.oauth) {
			return resolveStoredOAuth(credentials, provider.id, provider.auth.oauth, stored);
		}
		if (stored.type === "api_key" && provider.auth.apiKey) {
			const credential = overrides?.env ? { ...stored, env: { ...stored.env, ...overrides.env } } : stored;
			return resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, credential);
		}
		return undefined;
	}

	// Ambient (env vars, AWS profiles, ADC files).
	// 外部认证来源（环境变量、AWS 配置文件、ADC 文件）。
	return provider.auth.apiKey
		? resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, undefined)
		: undefined;
}

function overlayEnvAuthContext(base: AuthContext, env: ProviderEnv): AuthContext {
	return {
		env: async (name) => env[name] || (await base.env(name)),
		fileExists: (path) => base.fileExists(path),
	};
}

/**
 * OAuth resolution with double-checked locking (same pattern as today's
 * AuthStorage): valid tokens cost zero locks; expired tokens lock, re-check
 * expiry under the lock, refresh once globally, and persist the rotated
 * credential before release.
 */
/**
 * 使用双重检查锁定解析 OAuth（与当前 `AuthStorage` 的模式相同）：
 * 有效令牌无需加锁；过期令牌先获取锁并在锁内重新检查，只在全局刷新一次，
 * 且在释放锁前持久化轮换后的凭据。
 */
async function resolveStoredOAuth(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	stored: OAuthCredential,
): Promise<AuthResult | undefined> {
	let credential = stored;

	if (Date.now() >= credential.expires) {
		// Optimistic check said expired; the authoritative check runs under the lock.
		// 乐观检查发现令牌已过期；最终判定仍需在锁内完成。
		let post: Credential | undefined;
		try {
			post = await credentials.modify(providerId, async (current) => {
				if (current?.type !== "oauth") return undefined; // logged out meanwhile
				// 此期间可能已退出登录。
				if (Date.now() < current.expires) return undefined; // another process/request refreshed
				// 另一个进程或请求已完成刷新。
				try {
					return await oauth.refresh(current);
				} catch (error) {
					throw new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, { cause: error });
				}
			});
		} catch (error) {
			if (error instanceof ModelsError) throw error;
			throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
		}
		if (post?.type !== "oauth") return undefined; // logged out meanwhile
		// 获取锁和完成修改期间可能已退出登录。
		credential = post;
	}

	try {
		return { auth: await oauth.toAuth(credential), source: "OAuth" };
	} catch (error) {
		throw new ModelsError("oauth", `OAuth auth derivation failed for ${providerId}`, { cause: error });
	}
}

async function resolveApiKey(
	authContext: AuthContext,
	apiKey: ApiKeyAuth,
	providerId: string,
	credential: ApiKeyCredential | undefined,
): Promise<AuthResult | undefined> {
	try {
		return await apiKey.resolve({ ctx: authContext, credential });
	} catch (error) {
		throw new ModelsError("auth", `API key auth failed for provider ${providerId}`, { cause: error });
	}
}

async function readCredential(credentials: CredentialStore, providerId: string): Promise<Credential | undefined> {
	try {
		return await credentials.read(providerId);
	} catch (error) {
		throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
	}
}
