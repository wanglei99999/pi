import { lazyStream } from "./api/lazy.ts";
import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { type AuthResolutionOverrides, ModelsError, resolveProviderAuth } from "./auth/resolve.ts";
import type {
	AuthCheck,
	AuthContext,
	AuthInteraction,
	AuthResult,
	AuthType,
	Credential,
	CredentialStore,
	ProviderAuth,
} from "./auth/types.ts";
import { InMemoryModelsStore, type ModelsStore, type ProviderModelsStore } from "./models-store.ts";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ModelCostRates,
	ModelThinkingLevel,
	ProviderHeaders,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
	Usage,
} from "./types.ts";

export { ModelsError, type ModelsErrorCode } from "./auth/resolve.ts";

export interface RefreshModelsContext {
	/** Effective configured credential. OAuth credentials are refreshed before network access. */
	credential?: Credential;
	/** Persistent model storage scoped to this provider ID. */
	store: ProviderModelsStore;
	/** False during offline/cache-only initialization. */
	allowNetwork: boolean;
	/** Bypass provider freshness checks and fetch immediately when network access is allowed. */
	force?: boolean;
	signal?: AbortSignal;
}

export interface ModelsRefreshOptions {
	allowNetwork?: boolean;
	/** Bypass provider freshness checks and fetch immediately when network access is allowed. */
	force?: boolean;
	signal?: AbortSignal;
}

export interface ModelsRefreshResult {
	aborted: boolean;
	errors: ReadonlyMap<string, Error>;
}

export interface ModelsStreamTransforms {
	/** Transform fully assembled model/auth/request headers before provider dispatch. */
	transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
}

export type ModelsApiStreamOptions<TApi extends Api> = ApiStreamOptions<TApi> & ModelsStreamTransforms;
export type ModelsSimpleStreamOptions = SimpleStreamOptions & ModelsStreamTransforms;

/**
 * A provider is the concrete runtime unit. It owns id/name/base metadata,
 * Provider 是具体的运行时单元，负责 id/name/base 元数据、
 * auth methods, model listing, and stream behavior.
 * 认证方法、模型列表和流式行为。
 *
 * `TApi` lets concrete provider factories declare which APIs their models
 * `TApi` 允许具体提供商工厂声明其模型使用的 API，
 * use (e.g. `openaiProvider(): Provider<"openai-responses" | "openai-completions">`),
 * 从而让直接使用工厂的调用方获得精确的模型类型；
 * giving typed model lists to direct factory users. Inside a `Models`
 * 进入 `Models` 集合后，提供商则统一按
 * collection providers are held as `Provider<Api>`.
 * `Provider<Api>` 保存，以支持跨 API 的运行时查询。
 */
export interface Provider<TApi extends Api = Api> {
	readonly id: string;
	readonly name: string;

	readonly baseUrl?: string;
	readonly headers?: ProviderHeaders;

	/**
	 * Required: at least one of `apiKey`/`oauth`. Every provider has auth
	 * 必填：至少定义 `apiKey` 或 `oauth` 之一。每个提供商都有认证语义，
	 * semantics — even providers with only ambient credentials (env vars, AWS
	 * 即使仅依赖环境凭据（环境变量、AWS profile、
	 * profiles, ADC files) and keyless local servers provide `apiKey` auth
	 * ADC 文件）或无密钥本地服务，也要提供 `apiKey` auth，
	 * whose `resolve()` reports whether the provider is configured.
	 * 由其 `resolve()` 报告当前是否已配置。
	 * `Models.getAuth()` returns undefined when the provider is unconfigured.
	 * 提供商未配置时，`Models.getAuth()` 返回 undefined。
	 */
	readonly auth: ProviderAuth;

	/**
	 * Current known models, sync. Static providers return their catalog;
	 * 同步返回当前已知模型。静态提供商返回固定目录；
	 * dynamic providers return the list as of the last `refreshModels()`
	 * 动态提供商返回最近一次 `refreshModels()` 得到的列表，
	 * (empty before the first). Must not throw; `Models` treats a throwing
	 * 首次刷新前为空。此方法不得抛出；若实现抛出，
	 * implementation as having no models.
	 * `Models` 会将该提供商视为没有模型。
	 */
	getModels(): readonly Model<TApi>[];

	/**
	 * Dynamic providers only: restore the provider-scoped stored catalog and optionally fetch
	 * 仅用于动态提供商：恢复该提供商作用域的已存目录，并可选地
	 * a newer list using the effective credential. Implementations must retain their previous
	 * 用生效凭据获取更新的列表。实现必须在失败时保留之前的列表，
	 * list on failure and honor the shared abort signal for network requests.
	 * 并让网络请求遵守共享的中止信号。
	 */
	refreshModels?(context: RefreshModelsContext): Promise<void>;

	/**
	 * Optional provider policy for credential-specific model availability.
	 * 可选的提供商策略，用于按凭证过滤模型可用性。
	 * `getModels()` remains the complete synchronous catalog; `Models.getAvailable()`
	 * `getModels()` 仍是完整的同步目录；`Models.getAvailable()`
	 * applies this filter after confirming that provider auth is configured.
	 * 在确认提供商认证已配置后才应用此过滤。
	 */
	filterModels?(models: readonly Model<TApi>[], credential: Credential | undefined): readonly Model<TApi>[];

	stream<T extends TApi>(
		model: Model<T>,
		context: Context,
		options?: ApiStreamOptions<T>,
	): AssistantMessageEventStream;

	streamSimple(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

/**
 * Runtime collection of providers plus auth application and stream
 * 提供商的运行时集合，同时负责应用认证并提供流式调用便捷方法。
 * convenience. Providers own stream behavior; `Models` resolves auth and
 * 流式行为仍由各 Provider 实现；`Models` 解析认证，
 * delegates each request to the provider that owns the model.
 * 再把请求委派给拥有该模型的提供商。
 */
export interface Models {
	getProviders(): readonly Provider[];
	getProvider(id: string): Provider | undefined;

	/**
	 * Sync read of last-known models from one provider or all providers.
	 * 同步读取单个或全部提供商最近已知的模型列表。
	 * Best-effort: a provider whose `getModels()` throws yields no models.
	 * 采用尽力而为语义：某提供商的 `getModels()` 抛出时，该提供商返回空列表。
	 */
	getModels(provider?: string): readonly Model<Api>[];

	/**
	 * Sync runtime model lookup against last-known lists. Dynamic model lists
	 * 在最近已知列表中同步查询运行时模型。动态模型列表
	 * are typed as `Model<Api>`; narrow with the `hasApi()` type guard.
	 * 统一类型为 `Model<Api>`，需要使用 `hasApi()` 类型守卫缩窄。
	 */
	getModel(provider: string, id: string): Model<Api> | undefined;

	/**
	 * Refresh every configured dynamic provider concurrently. Provider errors and cancellation
	 * 并发刷新所有已配置的动态提供商。提供商错误与取消
	 * are returned without rejecting; static and unconfigured providers are skipped.
	 * 通过返回值报告而不 reject；静态和未配置的提供商会被跳过。
	 */
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;

	/** Check whether a provider has complete auth configuration without refreshing OAuth. */
	/** 检查提供商是否具备完整认证配置；不会触发 OAuth 刷新。 */
	checkAuth(providerId: string): Promise<AuthCheck | undefined>;

	/** Return models whose providers have complete auth configuration. */
	/** 返回其提供商已具备完整认证配置的模型。 */
	getAvailable(providerId?: string): Promise<readonly Model<Api>[]>;

	/**
	 * Resolve provider-scoped auth by provider id, or provider auth plus static
	 * model headers when passed a model. Includes a source label for status UI.
	 * 为模型解析请求认证，并携带供状态 UI 展示的来源标签。
	 * Resolves `undefined` when the provider is unknown or unconfigured.
	 * 提供商未知或未配置时解析为 undefined。
	 * Rejects with `ModelsError`: code "oauth" when a token refresh fails (the
	 * token 刷新失败时以 code "oauth" 的 `ModelsError` reject，
	 * stored credential is preserved for retry; re-login fixes it), code "auth"
	 * 已存凭据会保留以便重试，重新登录可修复；api-key 解析或凭据存储失败时
	 * when api-key resolution or the credential store fails. Request paths
	 * 使用 code "auth"。请求路径
	 * surface rejections as stream errors.
	 * 会把 reject 转换为流错误。
	 */
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;

	/** Run a provider-owned login flow and persist its returned credential. */
	/** 执行提供商自有的登录流程，并持久化其返回的凭证。 */
	login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;

	/** Remove the stored credential for a provider. */
	/** 删除该提供商已存储的凭证。 */
	logout(providerId: string): Promise<void>;

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream;

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage>;

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
}

export interface MutableModels extends Models {
	/** Upsert/replace by provider.id. Provider ids are unique. */
	/** 按 provider.id 新增或替换；provider id 在集合内唯一。 */
	setProvider(provider: Provider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}

export interface CreateModelsOptions {
	credentials?: CredentialStore;
	modelsStore?: ModelsStore;
	authContext?: AuthContext;
}

function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

class ModelsImpl implements MutableModels {
	private providers = new Map<string, Provider>();
	private credentials: CredentialStore;
	private modelsStore: ModelsStore;
	private authContext: AuthContext;

	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.modelsStore = options?.modelsStore ?? new InMemoryModelsStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	setProvider(provider: Provider): void {
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.providers.delete(id);
	}

	clearProviders(): void {
		this.providers.clear();
	}

	getProviders(): readonly Provider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): Provider | undefined {
		return this.providers.get(id);
	}

	getModels(provider?: string): readonly Model<Api>[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		const models: Model<Api>[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...entry.getModels());
			} catch {
				// Best-effort: ill-behaved providers yield no models.
				// 尽力而为：行为异常的提供商不贡献任何模型，也不影响其他提供商。
			}
		}
		return models;
	}

	getModel(provider: string, id: string): Model<Api> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const allowNetwork = options.allowNetwork ?? true;
		const errors = new Map<string, Error>();
		const refreshable = Array.from(this.providers.values()).filter(
			(provider): provider is Provider & Required<Pick<Provider, "refreshModels">> =>
				provider.refreshModels !== undefined,
		);

		await Promise.all(
			refreshable.map(async (provider) => {
				if (options.signal?.aborted) return;
				const store: ProviderModelsStore = {
					read: () => this.modelsStore.read(provider.id),
					write: (entry) => this.modelsStore.write(provider.id, entry),
					delete: () => this.modelsStore.delete(provider.id),
				};
				let stored: Credential | undefined;
				try {
					stored = await this.readCredential(provider.id);
					const credential = await this.resolveRefreshCredential(provider, stored, allowNetwork, options.signal);
					if (!credential) return;
					await provider.refreshModels({
						credential,
						store,
						allowNetwork,
						force: options.force,
						signal: options.signal,
					});
				} catch (error) {
					if (!options.signal?.aborted) {
						errors.set(
							provider.id,
							error instanceof Error
								? error
								: new ModelsError("model_source", `Model refresh failed for ${provider.id}`, { cause: error }),
						);
					}
					try {
						await provider.refreshModels({
							credential: stored,
							store,
							allowNetwork: false,
							signal: options.signal,
						});
					} catch {
						// Preserve the original auth/network error; cache restoration is best-effort here.
					}
				}
			}),
		);

		return { aborted: options.signal?.aborted ?? false, errors };
	}

	private async resolveRefreshCredential(
		provider: Provider,
		stored: Credential | undefined,
		allowNetwork: boolean,
		signal?: AbortSignal,
	): Promise<Credential | undefined> {
		if (stored?.type === "oauth") {
			const oauth = provider.auth.oauth;
			if (!oauth) return undefined;
			if (!allowNetwork || Date.now() < stored.expires) return stored;
			if (signal?.aborted) return undefined;
			const post = await this.credentials.modify(provider.id, async (current) => {
				if (current?.type !== "oauth" || Date.now() < current.expires) return undefined;
				return oauth.refresh(current, signal);
			});
			return post?.type === "oauth" ? post : undefined;
		}

		const apiKey = provider.auth.apiKey;
		if (!apiKey) return undefined;
		const credential = stored?.type === "api_key" ? stored : undefined;
		const result = await apiKey.resolve({ ctx: this.authContext, credential });
		if (!result) return undefined;
		return { type: "api_key", key: result.auth.apiKey, env: result.env };
	}

	private async readCredential(providerId: string): Promise<Credential | undefined> {
		try {
			return await this.credentials.read(providerId);
		} catch (error) {
			throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
		}
	}

	private async checkProviderAuth(
		provider: Provider,
		credential: Credential | undefined,
	): Promise<AuthCheck | undefined> {
		if (credential?.type === "oauth") {
			return provider.auth.oauth ? { source: "OAuth", type: "oauth" } : undefined;
		}
		const apiKey = provider.auth.apiKey;
		if (!apiKey) return undefined;
		if (apiKey.check) {
			try {
				return await apiKey.check({
					ctx: this.authContext,
					credential: credential?.type === "api_key" ? credential : undefined,
				});
			} catch (error) {
				throw new ModelsError("auth", `API key auth check failed for provider ${provider.id}`, { cause: error });
			}
		}

		const resolution = await resolveProviderAuth(provider, this.credentials, this.authContext);
		return resolution ? { source: resolution.source, type: "api_key" } : undefined;
	}

	async checkAuth(providerId: string): Promise<AuthCheck | undefined> {
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		return this.checkProviderAuth(provider, await this.readCredential(providerId));
	}

	async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
		const providers = providerId
			? [this.providers.get(providerId)].filter((entry) => entry !== undefined)
			: this.getProviders();
		const checks = await Promise.all(
			providers.map(async (provider) => {
				const credential = await this.readCredential(provider.id);
				return { provider, credential, auth: await this.checkProviderAuth(provider, credential) };
			}),
		);
		return checks.flatMap(({ provider, credential, auth }) => {
			if (!auth) return [];
			const models = provider.getModels();
			return provider.filterModels?.(models, credential) ?? models;
		});
	}

	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | Model<Api>,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		const result = await resolveProviderAuth(provider, this.credentials, this.authContext, overrides);
		if (!result || typeof providerOrModel === "string" || !providerOrModel.headers) return result;
		return {
			...result,
			auth: {
				...result.auth,
				headers: mergeHeaders(result.auth.headers, providerOrModel.headers),
			},
		};
	}

	async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		const provider = this.providers.get(providerId);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${providerId}`);
		const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
		if (!method?.login) {
			throw new ModelsError("auth", `${provider.name} does not support ${type} login`);
		}
		const credential = await method.login(interaction);
		try {
			await this.credentials.modify(providerId, async () => credential);
		} catch (error) {
			throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
		}
		return credential;
	}

	async logout(providerId: string): Promise<void> {
		try {
			await this.credentials.delete(providerId);
		} catch (error) {
			throw new ModelsError("auth", `Credential store delete failed for ${providerId}`, { cause: error });
		}
	}

	private requireProvider(model: Model<Api>): Provider {
		const provider = this.providers.get(model.provider);
		if (!provider) {
			throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		}
		return provider;
	}

	private async applyAuth<TOptions extends StreamOptions & ModelsStreamTransforms>(
		model: Model<Api>,
		options: TOptions | undefined,
	): Promise<{ requestModel: Model<Api>; requestOptions: StreamOptions | undefined }> {
		this.requireProvider(model);
		const resolution = await this.getAuth(model, {
			apiKey: options?.apiKey,
			env: options?.env,
		});
		if (!resolution) {
			throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
		}
		const auth = resolution.auth;

		// Explicit request options win per-field; the Models-only transform runs last.
		// 显式请求选项按字段优先；headers 和 env 则按键合并，使调用方可局部覆盖认证结果。
		const apiKey = options?.apiKey ?? auth.apiKey;
		let headers = mergeHeaders(auth.headers, options?.headers);
		if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
		const env = resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;
		const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
		const { transformHeaders: _transformHeaders, ...providerOptions } = options ?? {};
		const requestOptions = { ...providerOptions, apiKey, headers, env } as StreamOptions;

		return { requestModel, requestOptions };
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(
				model,
				options as ModelsApiStreamOptions<Api> | undefined,
			);
			return provider.stream(requestModel as Model<TApi>, context, requestOptions as ApiStreamOptions<TApi>);
		});
	}

	async complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return provider.streamSimple(requestModel, context, requestOptions as SimpleStreamOptions);
		});
	}

	async completeSimple(
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}
}

export function createModels(options?: CreateModelsOptions): MutableModels {
	return new ModelsImpl(options);
}

export interface CreateProviderOptions<TApi extends Api = Api> {
	id: string;
	/** Display name. Default: `id`. */
	/** 显示名称，默认使用 `id`。 */
	name?: string;
	baseUrl?: string;
	headers?: ProviderHeaders;
	/** Required — every provider has auth semantics, even ambient/keyless ones. */
	/** 必填；即使依赖环境凭据或无密钥的提供商也必须声明认证语义。 */
	auth: ProviderAuth;
	/** Static baseline model list (empty for purely dynamic providers). */
	/** 初始模型列表；纯动态提供商可为空。 */
	models: readonly Model<TApi>[];
	/** Fetch a dynamic model overlay. createProvider restores/persists it through ModelsStore. */
	fetchModels?: (context: RefreshModelsContext) => Promise<readonly Model<TApi>[]>;
	filterModels?: (models: readonly Model<TApi>[], credential: Credential | undefined) => readonly Model<TApi>[];
	/** Single implementation, or map keyed by `model.api` for mixed-API providers. */
	/** 单一 API 实现，或混合 API 提供商按 `model.api` 索引的实现映射。 */
	api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;
}

/**
 * Builds a provider from parts. Built-in provider factories and models.json
 * 由各组成部分构建 Provider；内置提供商工厂和 models.json
 * custom providers both go through this. A single `api` streams all models;
 * 自定义提供商都经过此入口。单个 `api` 实现处理全部模型；
 * an `api` map dispatches on `model.api`, and a model whose api has no entry
 * `api` 映射则按 `model.api` 分派。若模型的 api 没有对应实现，
 * produces a stream error.
 * 请求会以流错误终止。
 */
export function createProvider<TApi extends Api = Api>(input: CreateProviderOptions<TApi>): Provider<TApi> {
	const baselineModels = input.models;
	let dynamicModels: readonly Model<TApi>[] = [];
	let inflightRefresh: Promise<void> | undefined;
	const fetchModels = input.fetchModels;
	const currentModels = (): readonly Model<TApi>[] => {
		const merged = [...baselineModels];
		for (const model of dynamicModels) {
			const index = merged.findIndex((entry) => entry.id === model.id);
			if (index >= 0) merged[index] = model;
			else merged.push(model);
		}
		return merged;
	};
	const single =
		typeof (input.api as ProviderStreams).stream === "function" ? (input.api as ProviderStreams) : undefined;
	const byApi = single ? undefined : (input.api as Partial<Record<string, ProviderStreams>>);

	const apiFor = (model: Model<Api>): ProviderStreams | undefined => single ?? byApi?.[model.api];

	const dispatch = (
		model: Model<Api>,
		run: (streams: ProviderStreams) => AssistantMessageEventStream,
	): AssistantMessageEventStream => {
		const streams = apiFor(model);
		if (!streams) {
			return lazyStream(model, async () => {
				throw new ModelsError("stream", `Provider ${input.id} has no API implementation for "${model.api}"`);
			});
		}
		return run(streams);
	};

	return {
		id: input.id,
		name: input.name ?? input.id,
		baseUrl: input.baseUrl,
		headers: input.headers,
		auth: input.auth,
		getModels: currentModels,
		refreshModels: fetchModels
			? (context) => {
					inflightRefresh ??= (async () => {
						try {
							const stored = await context.store.read();
							if (stored) {
								dynamicModels = stored.models
									.filter((model) => model.provider === input.id)
									.map((model) => model as Model<TApi>);
							}
							if (!context.allowNetwork || context.signal?.aborted) return;
							const refreshed = await fetchModels(context);
							if (context.signal?.aborted) return;
							dynamicModels = refreshed;
							await context.store.write({ models: refreshed, checkedAt: Date.now() });
						} finally {
							inflightRefresh = undefined;
						}
					})();
					return inflightRefresh;
				}
			: undefined,
		filterModels: input.filterModels,
		stream: (model, context, options) => dispatch(model, (streams) => streams.stream(model, context, options)),
		streamSimple: (model, context, options) =>
			dispatch(model, (streams) => streams.streamSimple(model, context, options)),
	};
}

/**
 * Runtime-checked narrowing for dynamically looked-up models:
 * 对运行时动态查询得到的模型执行类型缩窄：
 *
 * ```ts
 * const model = models.getModel("anthropic", "claude-opus-4-7");
 * if (model && hasApi(model, "anthropic-messages")) {
 *   // model: Model<"anthropic-messages">, stream options fully typed
 * }
 * ```
 */
export function hasApi<TApi extends Api>(model: Model<Api>, api: TApi): model is Model<TApi> {
	return model.api === api;
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	let rates: ModelCostRates = model.cost;
	let matchedThreshold = -1;
	for (const tier of model.cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}

	// Anthropic charges 2x base input for 1h cache writes.
	// Anthropic 对保留 1 小时的缓存写入按基础输入价格的 2 倍计费。
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	usage.cost.input = (rates.input / 1000000) * usage.input;
	usage.cost.output = (rates.output / 1000000) * usage.output;
	usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	// null 明确表示不支持该级别；xhigh 只有在模型提供显式映射时才暴露。
	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	// 优先向更高级别寻找可用值；若没有，再向下回退，避免无意降低推理强度。
	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * 通过同时比较 id 和 provider 判断两个模型是否相同。
 * Returns false if either model is null or undefined.
 * 任一模型为 null 或 undefined 时返回 false。
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
