import { lazyStream } from "./api/lazy.ts";
import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { ModelsError, resolveProviderAuth } from "./auth/resolve.ts";
import type { AuthContext, AuthResult, CredentialStore, ProviderAuth } from "./auth/types.ts";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ModelThinkingLevel,
	ProviderHeaders,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
	Usage,
} from "./types.ts";

export { type AuthModel, ModelsError, type ModelsErrorCode } from "./auth/resolve.ts";

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
	 * Dynamic providers only: fetch and update the model list. Side-effect-free
	 * 仅用于动态提供商：获取并更新模型列表。发现过程不得加载或下载模型；
	 * discovery (no loading/downloading); provider-specific model lifecycle
	 * 提供商专属的模型生命周期操作
	 * belongs in app commands. Concurrent calls share one in-flight fetch.
	 * 应由应用命令处理。并发调用共享同一个进行中的请求。
	 * May reject (network); on rejection the model list stays at its last-known
	 * 网络失败时可以 reject；失败后保留最近一次成功的模型列表，
	 * state and a later call retries.
	 * 后续调用会重新尝试。
	 */
	refreshModels?(): Promise<void>;

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
	 * Ask dynamic providers to re-fetch their model lists. With a provider id,
	 * 要求动态提供商重新获取模型列表。指定 provider id 时，
	 * rejects with `ModelsError` ("model_source") on that provider's fetch
	 * 该提供商获取失败会以 `ModelsError`（"model_source"）reject；
	 * failure; without one, refreshes all providers concurrently best-effort.
	 * 不指定时并发刷新全部提供商，并采用尽力而为语义。
	 * Static providers (no `refreshModels`) are no-ops.
	 * 静态提供商没有 `refreshModels`，因此不执行任何操作。
	 */
	refresh(provider?: string): Promise<void>;

	/**
	 * Resolve request auth for a model. Includes a source label for status UI.
	 * 为模型解析请求认证，并携带供状态 UI 展示的来源标签。
	 * Resolves `undefined` when the provider is unknown or unconfigured.
	 * 提供商未知或未配置时解析为 undefined。
	 * Rejects with `ModelsError`: code "oauth" when a token refresh fails (the
	 * token 刷新失败时以 code "oauth" 的 `ModelsError` reject，
	 * stored credential is preserved for retry; re-login fixes it), code "auth"
	 * 已存凭据会保留以便重试，重新登录可修复；api-key 解析或凭据存储失败时
	 * when api-key resolution or the credential store fails. Request paths
	 * 使用 code "auth"。请求路径会把 reject 转换为流错误；
	 * surface rejections as stream errors; status/availability UIs catch them
	 * 状态和可用性 UI 则捕获错误并显示
	 * and render "needs re-login" instead of treating them as unconfigured.
	 * "needs re-login"，而不是误判为未配置。
	 */
	getAuth(model: Model<Api>): Promise<AuthResult | undefined>;

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ApiStreamOptions<TApi>,
	): AssistantMessageEventStream;

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ApiStreamOptions<TApi>,
	): Promise<AssistantMessage>;

	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
	completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
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
	authContext?: AuthContext;
}

class ModelsImpl implements MutableModels {
	private providers = new Map<string, Provider>();
	private credentials: CredentialStore;
	private authContext: AuthContext;

	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
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

	async refresh(provider?: string): Promise<void> {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry?.refreshModels) return;
			try {
				await entry.refreshModels();
			} catch (error) {
				if (error instanceof ModelsError) throw error;
				throw new ModelsError("model_source", `Model refresh failed for ${provider}`, { cause: error });
			}
			return;
		}

		// Cannot reject: the async mapper turns even sync throws from ill-behaved
		// 此处不会 reject：异步 mapper 会把异常提供商的同步抛错也转换为 rejection，
		// providers into rejections, and allSettled captures all of them.
		// 而 allSettled 会收集所有结果。
		await Promise.allSettled(Array.from(this.providers.values(), async (entry) => entry.refreshModels?.()));
	}

	async getAuth(model: Model<Api>): Promise<AuthResult | undefined> {
		const provider = this.providers.get(model.provider);
		if (!provider) return undefined;
		return resolveProviderAuth(provider, model, this.credentials, this.authContext);
	}

	private requireProvider(model: Model<Api>): Provider {
		const provider = this.providers.get(model.provider);
		if (!provider) {
			throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		}
		return provider;
	}

	private async applyAuth<TOptions extends StreamOptions>(
		model: Model<Api>,
		options: TOptions | undefined,
	): Promise<{ requestModel: Model<Api>; requestOptions: TOptions | undefined }> {
		const resolution = await resolveProviderAuth(
			this.requireProvider(model),
			model,
			this.credentials,
			this.authContext,
			{
				apiKey: options?.apiKey,
				env: options?.env,
			},
		);
		const auth = resolution?.auth;
		if (!auth) return { requestModel: model, requestOptions: options };

		const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;

		// Explicit request options win per-field; headers/env merge per key.
		// 显式请求选项按字段优先；headers 和 env 则按键合并，使调用方可局部覆盖认证结果。
		const apiKey = options?.apiKey ?? auth.apiKey;
		const headers = auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined;
		const env = resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;
		const requestOptions = { ...options, apiKey, headers, env } as TOptions;

		return { requestModel, requestOptions };
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(model, options as StreamOptions | undefined);
			return provider.stream(requestModel as Model<TApi>, context, requestOptions as ApiStreamOptions<TApi>);
		});
	}

	async complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return provider.streamSimple(requestModel, context, requestOptions);
		});
	}

	async completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> {
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
	/** Initial model list (empty for purely dynamic providers). */
	/** 初始模型列表；纯动态提供商可为空。 */
	models: readonly Model<TApi>[];
	/**
	 * Dynamic providers: fetch the current list. Stored on success; concurrent
	 * 动态提供商通过此函数获取当前模型列表。成功结果会被保存，并发
	 * calls share one in-flight fetch. May reject: the stored list then stays
	 * 调用共享同一个进行中的请求。失败时允许 reject，已保存列表仍保持
	 * at its last-known state, the rejection propagates to the caller of
	 * 最近一次成功状态；rejection 会传递给 `refreshModels()` 调用方，
	 * `refreshModels()` (wrapped as ModelsError "model_source" by
	 * 并由 `Models.refresh(provider)` 包装为 ModelsError "model_source"，
	 * `Models.refresh(provider)`), and a later call retries.
	 * 后续调用会重新尝试。
	 */
	refreshModels?: () => Promise<readonly Model<TApi>[]>;
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
	let models = input.models;
	let inflightRefresh: Promise<void> | undefined;
	const refreshModels = input.refreshModels;
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
		getModels: () => models,
		refreshModels: refreshModels
			? () => {
					inflightRefresh ??= (async () => {
						try {
							models = await refreshModels();
						} finally {
							inflightRefresh = undefined;
						}
					})();
					return inflightRefresh;
				}
			: undefined,
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
	// Anthropic charges 2x base input for 1h cache writes.
	// Anthropic 对保留 1 小时的缓存写入按基础输入价格的 2 倍计费。
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite * shortWrite + model.cost.input * 2 * longWrite) / 1000000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	// null 明确表示不支持该级别；xhigh 只有在模型提供显式映射时才暴露。
	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
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
