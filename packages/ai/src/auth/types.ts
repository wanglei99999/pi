import type { Api, ImagesApi, ImagesModel, Model, ProviderEnv, ProviderHeaders } from "../types.ts";
import type { OAuthCredentials } from "../utils/oauth/types.ts";

/**
 * Request auth for a single model request. If a value cannot be expressed as
 * `apiKey`, `headers`, or `baseUrl`, it is provider config, not auth.
 * 单次模型请求的认证结果只包含 apiKey、headers 和 baseUrl；其他值属于提供商配置，不应混入认证对象。
 */
export interface ModelAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	baseUrl?: string;
}

/**
 * Stored api-key credential. `env` holds provider-scoped environment/config
 * values such as Cloudflare account/gateway ids.
 * 持久化 API Key 凭证可同时保存提供商级环境配置，例如 Cloudflare 账户或网关标识。
 */
export interface ApiKeyCredential {
	type: "api_key";
	key?: string;
	env?: ProviderEnv;
}

/**
 * Stored OAuth credential (`access`, `refresh`, `expires` from OAuthCredentials).
 * 持久化 OAuth 凭证沿用 OAuthCredentials 的访问令牌、刷新令牌与过期时间结构。
 */
export interface OAuthCredential extends OAuthCredentials {
	type: "oauth";
}

/**
 * One type-tagged credential per provider — the shape of today's auth.json.
 * 每个提供商只保存一个带类型标签的凭证，与当前 auth.json 数据模型一致。
 */
export type Credential = ApiKeyCredential | OAuthCredential;

/**
 * App-owned credential storage, keyed by `Provider.id`, one credential per
 * provider. `modify` is the only write path, so every mutation is a
 * serialized read-modify-write; `Models.getAuth()` runs OAuth refresh inside
 * `modify` so concurrent requests cannot double-refresh a rotated token. The
 * app persists a credential after login via
 * `modify(provider.id, async () => credential)`. Login/logout orchestration
 * is app-owned.
 *
 * Error semantics: `read` resolves `undefined` for missing entries. Methods
 * reject only on storage failure; `Models` wraps such rejections in
 * `ModelsError` with code "auth". Best-effort stores that serve an in-memory
 * view and record persistence errors internally (like coding-agent's
 * AuthStorage) are valid implementations.
 *
 * 凭证存储以 Provider.id 为键，并把 modify 作为唯一写入口；OAuth 刷新也必须在该串行化事务内执行，
 * 从而避免并发请求重复刷新旋转令牌。缺失条目返回 undefined，只有真实存储故障才拒绝 Promise。
 * 允许实现先维护内存视图并单独记录持久化错误。
 */
export interface CredentialStore {
	/**
	 * Read the stored credential, possibly expired. Display/status use;
	 * resolved request auth comes from `Models.getAuth()`.
	 * 读取原始持久化凭证供状态展示，结果可能已过期；实际请求认证必须通过 Models.getAuth() 解析。
	 */
	read(providerId: string): Promise<Credential | undefined>;

	/**
	 * Serialized write — the only write path. `fn` sees the current credential
	 * because correct writes (refresh, login-during-refresh) depend on it;
	 * return the new credential, or undefined to leave the entry unchanged.
	 * Mutual exclusion per provider id, cross-process too where the backing
	 * store supports it (e.g. a file lock). Resolves with the post-write
	 * credential. Rejections from `fn` propagate.
	 *
	 * 对同一 provider 执行串行的读改写，fn 必须看到锁内最新凭证；返回 undefined 表示保持条目不变。
	 * 文件等后端还应提供跨进程互斥，fn 抛出的错误原样传播。
	 */
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined>;

	/**
	 * Remove a credential (logout). Implementations serialize this against `modify`.
	 * 删除凭证代表登出，并且必须与 modify 使用同一串行化边界。
	 */
	delete(providerId: string): Promise<void>;
}

/**
 * Environment access for auth resolution. Injectable for tests and browsers.
 * 认证解析所需的环境抽象可注入，便于浏览器和测试环境替换进程与文件系统访问。
 */
export interface AuthContext {
	env(name: string): Promise<string | undefined>;
	/**
	 * Check whether a file exists. Supports a leading `~`. Always false in browsers.
	 * 检查支持 `~` 的文件路径；浏览器实现始终返回 false。
	 */
	fileExists(path: string): Promise<boolean>;
}

/**
 * Result of resolving auth for a model.
 * 模型认证解析结果同时包含请求凭证、提供商环境配置和面向状态 UI 的来源标签。
 */
export interface AuthResult {
	auth: ModelAuth;
	/** Provider-scoped environment/config values resolved from credentials and ambient context. */
	env?: ProviderEnv;
	/** Human-readable label for status UI: "ANTHROPIC_API_KEY", "OAuth", "~/.aws/credentials". */
	source?: string;
}

/**
 * Prompt shown to the user during login. `signal` lets the flow cancel a
 * pending prompt when an out-of-band event resolves the step, e.g. a
 * `manual_code` prompt raced against a callback server, aborted when the
 * callback wins.
 * 登录提示可携带独立 signal；当回调服务器等带外流程先完成时，可取消仍在等待的人工输入。
 */
export type AuthPrompt = { signal?: AbortSignal } & (
	| { type: "text"; message: string; placeholder?: string }
	| { type: "secret"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
	| { type: "manual_code"; message: string; placeholder?: string }
);

export type AuthEvent =
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

/**
 * Login interaction callbacks serving both api-key and OAuth flows.
 *
 * `prompt()` returns the entered/selected string (`select` returns the option
 * id). Rejects on cancel/abort. `signal` aborts the whole login flow;
 * per-prompt cancellation uses `AuthPrompt.signal`.
 * prompt 返回输入值或选择项 id，取消时拒绝；callbacks.signal 控制整个登录流程，AuthPrompt.signal 只取消单次提示。
 */
export interface AuthLoginCallbacks {
	signal?: AbortSignal;

	prompt(prompt: AuthPrompt): Promise<string>;
	notify(event: AuthEvent): void;
}

/**
 * Api-key auth: stored key/provider env plus ambient sources (env vars, AWS
 * profiles, ADC files). Ambient-only providers omit `login`.
 * API Key 认证可合并持久化凭证与环境变量、AWS profile、ADC 文件等环境来源；纯环境认证提供商可不实现 login。
 */
export interface ApiKeyAuth {
	/** Display name, e.g. "Anthropic API key". */
	name: string;

	/** Interactive setup (prompt for key/provider env). Absent = ambient-only. */
	login?(callbacks: AuthLoginCallbacks): Promise<ApiKeyCredential>;

	/**
	 * Resolve auth from the stored credential and/or ambient sources, merging
	 * per field (`credential.key ?? env("...")`, `credential.env?.NAME ?? env("...")`).
	 * undefined = not configured. Receives the chat or image-generation model
	 * the request is for (both carry `provider` and `baseUrl`).
	 *
	 * resolve 按字段合并持久化值和环境来源，并根据具体聊天或图片模型解析；返回 undefined 表示当前未配置。
	 */
	resolve(input: {
		model: Model<Api> | ImagesModel<ImagesApi>;
		ctx: AuthContext;
		credential?: ApiKeyCredential;
	}): Promise<AuthResult | undefined>;
}

/**
 * OAuth auth. The `refresh`/`toAuth` split lets `Models` own the locked
 * refresh pattern: `refresh` produces a credential, `toAuth` derives request
 * auth from whatever credential ends up stored.
 * OAuth 将刷新凭证与派生请求认证拆开，使 Models 能在存储锁内刷新，再从最终落盘的凭证无副作用地构造请求认证。
 */
export interface OAuthAuth {
	/** Display name, e.g. "Anthropic (Claude Pro/Max)". */
	name: string;

	login(callbacks: AuthLoginCallbacks): Promise<OAuthCredential>;

	/**
	 * Exchange the refresh token. Network call; throws on failure
	 * (invalid_grant etc.). `Models` runs this under the store lock.
	 * 使用刷新令牌执行网络交换，失败时抛错；Models 必须在凭证存储锁内调用。
	 */
	refresh(credential: OAuthCredential): Promise<OAuthCredential>;

	/**
	 * Side-effect-free derivation of request auth from a valid credential.
	 * Covers per-credential baseUrl (GitHub Copilot). Async so lazy wrappers
	 * can load the implementation on first use.
	 * 从有效凭证无副作用地派生请求认证，并支持凭证级 baseUrl；异步形式允许惰性包装器按需加载实现。
	 */
	toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}

/**
 * Provider auth. At least one of `apiKey`/`oauth` must be present: even
 * ambient-credential providers and keyless local servers provide `apiKey`
 * auth whose `resolve()` reports whether the provider is configured.
 * 提供商至少声明 apiKey 或 oauth 之一；即使使用环境凭证或无密钥本地服务，也通过 apiKey.resolve 报告可用状态。
 */
export interface ProviderAuth {
	apiKey?: ApiKeyAuth;
	oauth?: OAuthAuth;
}
