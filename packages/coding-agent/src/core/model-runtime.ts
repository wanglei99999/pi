import { dirname, join } from "node:path";
import {
	type Api,
	type ApiStreamOptions,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthInteraction,
	type AuthResult,
	type AuthType,
	type Context,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	createModels,
	lazyStream,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	ModelsError,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsSimpleStreamOptions,
	type ModelsStore,
	type ModelsStreamTransforms,
	type MutableModels,
	type Provider,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { getAgentDir } from "../config.ts";
import { AuthStorage as DefaultAuthStorage } from "./auth-storage.ts";
import { ModelConfig } from "./model-config.ts";
import { FileModelsStore, InMemoryCodingAgentModelsStore } from "./models-store.ts";
import {
	type AuthStatus,
	type CompatibilityRequestConfig,
	composeModelProvider,
	configuredRequestAuthStatus,
	type ProviderConfigInput,
	resolveCompatibilityRequestConfig,
	resolveConfiguredModelHeaders,
	validateExtensionProvider,
} from "./provider-composer.ts";
import { withRemoteCatalog } from "./remote-catalog-provider.ts";
import { RuntimeCredentials } from "./runtime-credentials.ts";

// 面向 UI 的同步快照：认证检查是异步的，选择器/页脚等组件不能每次渲染都跑一遍，
// 因此把"全部模型/可用模型/各 provider 认证状态"缓存成不可变对象，异步刷新后整体替换。
interface ModelRuntimeSnapshot {
	all: readonly Model<Api>[];
	available: readonly Model<Api>[];
	configuredProviders: ReadonlySet<string>;
	storedProviders: ReadonlySet<string>;
	auth: ReadonlyMap<string, AuthCheck | undefined>;
}

export interface CreateModelRuntimeOptions {
	/** Credential storage. Defaults to the file at authPath. */
	credentials?: CredentialStore;
	authPath?: string;
	modelsPath?: string | null;
	modelsStore?: ModelsStore;
	modelsStorePath?: string;
	allowModelNetwork?: boolean;
	modelRefreshTimeoutMs?: number;
	catalogBaseUrl?: string;
}

export interface ModelRuntimeAuthOverrides {
	apiKey?: string;
	env?: Record<string, string>;
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

/** Configured pi-ai Models collection used by coding-agent and SDK consumers. */
/**
 * coding-agent 与 SDK 使用的、已配置好的 pi-ai Models 集合。
 * 这是旧 ModelRegistry/AuthStorage 组合的替代者：认证解析与流式分发都委托给 pi-ai 的
 * Models（this.models），本类只负责 coding-agent 特有的四层 provider 组合
 * （内置 catalog → models.json → 扩展 registerProvider → 原生扩展 Provider）、
 * 运行时密钥覆盖、以及供 TUI 同步读取的可用性快照。
 */
export class ModelRuntime implements Models {
	private readonly models: MutableModels;
	private readonly credentials: RuntimeCredentials;
	private readonly defaultBuiltins: ReadonlyMap<string, Provider>;
	private readonly builtins = new Map<string, Provider>();
	private readonly nativeExtensionProviders = new Map<string, Provider>();
	private readonly extensionProviders = new Map<string, ProviderConfigInput>();
	private readonly compositionErrors = new Map<string, string>();
	private readonly modelsPath: string | undefined;
	private readonly allowModelNetwork: boolean;
	private config: ModelConfig;
	private snapshot: ModelRuntimeSnapshot = {
		all: [],
		available: [],
		configuredProviders: new Set(),
		storedProviders: new Set(),
		auth: new Map(),
	};
	private availabilityRefresh: Promise<void> | undefined;
	private availabilityError: string | undefined;

	private constructor(
		credentials: RuntimeCredentials,
		config: ModelConfig,
		modelsPath: string | undefined,
		modelsStore: ModelsStore,
		providers: readonly Provider[],
		allowModelNetwork: boolean,
	) {
		this.credentials = credentials;
		this.config = config;
		this.modelsPath = modelsPath;
		this.allowModelNetwork = allowModelNetwork;
		this.defaultBuiltins = new Map(providers.map((provider) => [provider.id, provider]));
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		this.models = createModels({ credentials, modelsStore });
		this.rebuildProviders();
	}

	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		// 装配顺序：凭证存储（auth.json 外包一层运行时覆盖）→ models.json 快照 →
		// 动态目录持久化（models-store.json）→ 内置 provider 包上 pi.dev 远端目录 → 首次 refresh。
		const credentials = new RuntimeCredentials(options.credentials ?? DefaultAuthStorage.create(options.authPath));
		const modelsPath =
			options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
		const config = await ModelConfig.load(modelsPath);
		const modelsStore =
			options.modelsStore ??
			(modelsPath
				? new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))
				: new InMemoryCodingAgentModelsStore());
		const providers = builtinProviderCatalog
			.builtinProviders()
			.map((provider) =>
				provider.id === "radius" ? provider : withRemoteCatalog(provider, options.catalogBaseUrl),
			);
		const runtime = new ModelRuntime(
			credentials,
			config,
			modelsPath,
			modelsStore,
			providers,
			options.allowModelNetwork ?? process.env.PI_OFFLINE === undefined,
		);
		runtime.configureRadiusProviders();
		runtime.rebuildProviders();
		// 首次刷新有 15s 超时兜底：网络卡住时中止请求，CLI 启动不被模型目录拖死；
		// 离线模式（PI_OFFLINE）只从本地缓存恢复目录，不发网络请求。
		const controller = new AbortController();
		const timeout = runtime.allowModelNetwork
			? setTimeout(() => controller.abort(), options.modelRefreshTimeoutMs ?? 15_000)
			: undefined;
		try {
			await runtime.refresh({ allowNetwork: runtime.allowModelNetwork, signal: controller.signal });
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		return runtime;
	}

	// models.json 里 oauth: "radius" 的条目不是覆盖现有 provider，而是以 radius 网关为后端
	// 生成一个全新的内置 provider（自带 OAuth 登录），因此要在组合层之前先注入 builtins。
	private configureRadiusProviders(): void {
		this.builtins.clear();
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		for (const providerId of this.config.getProviderIds()) {
			const config = this.config.getProvider(providerId);
			if (config?.oauth !== "radius" || !config.baseUrl) continue;
			this.builtins.set(
				providerId,
				builtinProviderCatalog.radiusProvider({
					id: providerId,
					name: config.name ?? providerId,
					gateway: config.baseUrl.replace(/\/v1\/?$/u, ""),
				}),
			);
		}
	}

	private providerIds(): Set<string> {
		return new Set([
			...this.builtins.keys(),
			...this.nativeExtensionProviders.keys(),
			...this.config.getProviderIds(),
			...this.extensionProviders.keys(),
		]);
	}

	// 单个 provider 的四层组合：base（原生扩展 Provider 优先于内置）+ models.json + 扩展注册配置。
	// 组合失败不让整个运行时垮掉：记录错误并回退到未加工的 base（或删除该 provider）。
	private recomposeProvider(providerId: string): void {
		const base = this.nativeExtensionProviders.get(providerId) ?? this.builtins.get(providerId);
		const extension = this.extensionProviders.get(providerId);
		if (!base && !this.config.getProvider(providerId) && !extension) {
			this.models.deleteProvider(providerId);
			this.compositionErrors.delete(providerId);
			return;
		}
		if (base && !this.config.getProvider(providerId) && !extension) {
			// No overlays: use the builtin untouched so its auth/login/stream behavior is exact.
			// 没有任何覆盖层时直接用原始内置实现，保证其认证/登录/流式行为分毫不差。
			this.models.setProvider(base);
			this.compositionErrors.delete(providerId);
			return;
		}
		try {
			this.models.setProvider(composeModelProvider(providerId, base, this.config, extension));
			this.compositionErrors.delete(providerId);
		} catch (error) {
			this.compositionErrors.set(providerId, error instanceof Error ? error.message : String(error));
			if (base) this.models.setProvider(base);
			else this.models.deleteProvider(providerId);
		}
	}

	private rebuildProviders(): void {
		this.models.clearProviders();
		this.compositionErrors.clear();
		for (const providerId of this.providerIds()) this.recomposeProvider(providerId);
		this.updateModelSnapshot();
	}

	private updateModelSnapshot(): void {
		const all = [...this.models.getModels()];
		this.snapshot = {
			...this.snapshot,
			all,
			available: all.filter((model) => this.snapshot.configuredProviders.has(model.provider)),
		};
	}

	// 重算快照：并发拉取可用模型、逐 provider 认证检查和凭证列表，然后原子替换 this.snapshot。
	private async runAvailabilityRefresh(): Promise<void> {
		const providers = this.models.getProviders();
		const [available, checks, credentials] = await Promise.all([
			this.models.getAvailable(),
			Promise.all(
				providers.map(
					async (provider): Promise<[string, AuthCheck | undefined]> => [
						provider.id,
						await this.models.checkAuth(provider.id),
					],
				),
			),
			this.credentials.list(),
		]);
		const auth = new Map(checks);
		const configuredProviders = new Set(
			checks
				.filter((entry): entry is [string, AuthCheck] => entry[1] !== undefined)
				.map(([providerId]) => providerId),
		);
		this.snapshot = {
			all: [...this.models.getModels()],
			available: [...available],
			configuredProviders,
			storedProviders: new Set(credentials.map((entry) => entry.providerId)),
			auth,
		};
		this.availabilityError = undefined;
	}

	private queueAvailabilityRefresh(after: Promise<void> | undefined): Promise<void> {
		const refresh = (after ?? Promise.resolve()).catch(() => {}).then(() => this.runAvailabilityRefresh());
		const recorded = refresh.catch((error) => {
			this.availabilityError = error instanceof Error ? error.message : String(error);
			throw error;
		});
		const tracked = recorded.finally(() => {
			if (this.availabilityRefresh === tracked) this.availabilityRefresh = undefined;
		});
		this.availabilityRefresh = tracked;
		return tracked;
	}

	/** Coalesce concurrent readers onto the pending refresh. */
	/** 读路径：并发读者共享同一个进行中的刷新，不重复发起。 */
	private refreshAvailability(): Promise<void> {
		return this.availabilityRefresh ?? this.queueAvailabilityRefresh(undefined);
	}

	/** Mutations must not observe an in-flight refresh started before them. */
	/** 写路径：变更后必须排在旧刷新之后再刷一次，否则可能读到变更前启动的过期结果。 */
	private forceRefreshAvailability(): Promise<void> {
		return this.queueAvailabilityRefresh(this.availabilityRefresh);
	}

	getProviders(): readonly Provider[] {
		return this.models.getProviders();
	}

	getProvider(providerId: string): Provider | undefined {
		return this.models.getProvider(providerId);
	}

	getModels(providerId?: string): readonly Model<Api>[] {
		return this.models.getModels(providerId);
	}

	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.models.getModel(providerId, modelId);
	}

	async checkAuth(providerId: string): Promise<AuthCheck | undefined> {
		return this.models.checkAuth(providerId);
	}

	async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
		if (providerId) {
			if (this.availabilityRefresh) {
				await this.availabilityRefresh;
				return this.snapshot.available.filter((model) => model.provider === providerId);
			}
			try {
				return await this.models.getAvailable(providerId);
			} catch (error) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
				throw error;
			}
		}
		await this.refreshAvailability();
		return this.snapshot.available;
	}

	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.snapshot.available;
	}

	getError(): string | undefined {
		const errors: string[] = [];
		const configError = this.config.getError();
		if (configError) errors.push(configError);
		for (const [providerId, error] of this.compositionErrors) {
			errors.push(`Provider "${providerId}": ${error}`);
		}
		if (this.availabilityError) errors.push(`Availability refresh: ${this.availabilityError}`);
		return errors.length > 0 ? errors.join("\n\n") : undefined;
	}

	getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined {
		return this.extensionProviders.get(providerId);
	}

	getRegisteredProviderIds(): readonly string[] {
		return [...new Set([...this.extensionProviders.keys(), ...this.nativeExtensionProviders.keys()])];
	}

	getRegisteredNativeProvider(providerId: string): Provider | undefined {
		return this.nativeExtensionProviders.get(providerId);
	}

	/** @internal Compatibility fallback for ModelRegistry when provider auth is unconfigured. */
	getCompatibilityRequestConfig(model: Model<Api>): CompatibilityRequestConfig {
		return resolveCompatibilityRequestConfig(
			model,
			this.config.getProvider(model.provider),
			this.extensionProviders.get(model.provider),
		);
	}

	isUsingOAuth(providerId: string): boolean {
		return this.snapshot.auth.get(providerId)?.type === "oauth";
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.snapshot.configuredProviders.has(providerId);
	}

	getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | Model<Api>,
		overrides: ModelRuntimeAuthOverrides = {},
	): Promise<AuthResult | undefined> {
		// 传入模型时，在 pi-ai 解析结果之上再叠加 models.json/扩展配置的模型级 header
		//（可引用环境变量，因此要在解析出 env 之后才展开）。
		if (typeof providerOrModel === "string") return this.models.getAuth(providerOrModel, overrides);
		const resolution = await this.models.getAuth(providerOrModel, overrides);
		if (!resolution) return undefined;
		const configuredHeaders = resolveConfiguredModelHeaders(
			providerOrModel,
			this.config.getProvider(providerOrModel.provider),
			this.extensionProviders.get(providerOrModel.provider),
			{ ...(resolution.env ?? {}), ...(overrides.env ?? {}) },
		);
		return {
			...resolution,
			auth: {
				...resolution.auth,
				headers: mergeHeaders(resolution.auth.headers, configuredHeaders),
			},
		};
	}

	async setRuntimeApiKey(providerId: string, apiKey: string): Promise<void> {
		// 先乐观更新快照（--api-key 场景要求模型立即可选），异步 refresh 随后校正。
		this.credentials.setRuntimeApiKey(providerId, apiKey);
		const auth = new Map(this.snapshot.auth).set(providerId, { type: "api_key", source: "runtime API key" });
		const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
		const storedProviders = new Set(this.snapshot.storedProviders).add(providerId);
		this.snapshot = {
			...this.snapshot,
			auth,
			configuredProviders,
			storedProviders,
			available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
		};
		await this.refresh({ allowNetwork: this.allowModelNetwork });
	}

	async removeRuntimeApiKey(providerId: string): Promise<void> {
		this.credentials.removeRuntimeApiKey(providerId);
		await this.refresh({ allowNetwork: this.allowModelNetwork });
	}

	listCredentials(): Promise<readonly CredentialInfo[]> {
		return this.credentials.list();
	}

	getProviderAuthStatus(providerId: string): AuthStatus {
		if (this.credentials.hasRuntimeApiKey(providerId)) return { configured: true, source: "runtime" };
		if (this.snapshot.storedProviders.has(providerId)) return { configured: true, source: "stored" };
		const configured = configuredRequestAuthStatus(
			this.config.getProvider(providerId),
			this.extensionProviders.get(providerId),
		);
		if (configured) return configured;
		const check = this.snapshot.auth.get(providerId);
		return check ? { configured: true, source: "environment", label: check.source } : { configured: false };
	}

	// 与 pi-ai ModelsImpl.applyAuth 同构，但走本类的 getAuth 以叠加模型级配置 header：
	// 解析认证 → 合并 header（transformHeaders 最后执行）→ 凭证级 baseUrl 覆盖模型。
	private async prepareRequest(
		model: Model<Api>,
		options: (StreamOptions & ModelsStreamTransforms) | undefined,
	): Promise<{ provider: Provider; model: Model<Api>; options: StreamOptions }> {
		const provider = this.models.getProvider(model.provider);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		const resolution = await this.getAuth(model, { apiKey: options?.apiKey, env: options?.env });
		if (!resolution) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);

		const { transformHeaders, ...providerOptions } = options ?? {};
		let headers = mergeHeaders(resolution.auth.headers, providerOptions.headers);
		if (transformHeaders) headers = await transformHeaders(headers ?? {});
		const env =
			resolution.env || providerOptions.env
				? { ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) }
				: undefined;
		return {
			provider,
			model: resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model,
			options: {
				...providerOptions,
				apiKey: providerOptions.apiKey ?? resolution.auth.apiKey,
				headers,
				env,
			},
		};
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const prepared = await this.prepareRequest(
				model,
				options as (StreamOptions & ModelsStreamTransforms) | undefined,
			);
			return prepared.provider.stream(
				prepared.model as Model<TApi>,
				context,
				prepared.options as ApiStreamOptions<TApi>,
			);
		});
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const prepared = await this.prepareRequest(model, options);
			return prepared.provider.streamSimple(prepared.model, context, prepared.options as SimpleStreamOptions);
		});
	}

	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		const credential = await this.models.login(providerId, type, interaction);
		await this.refresh({ allowNetwork: this.allowModelNetwork });
		return credential;
	}

	async logout(providerId: string): Promise<void> {
		await this.models.logout(providerId);
		// Reset credential-dependent compatibility projections before the unconfigured provider is skipped by refresh.
		// 登出后先重组该 provider，清掉依赖凭证的模型投影（如 OAuth modifyModels 的 baseUrl 改写）；
		// 否则 refresh 会因 provider 未配置而跳过它，过期投影就残留下来了。
		this.recomposeProvider(providerId);
		await this.refresh({ allowNetwork: this.allowModelNetwork });
	}

	async reloadConfig(): Promise<void> {
		this.config = await ModelConfig.load(this.modelsPath);
		this.configureRadiusProviders();
		this.rebuildProviders();
		await this.refresh({ allowNetwork: this.allowModelNetwork });
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const refreshOptions = {
			...options,
			allowNetwork: options.allowNetwork ?? this.allowModelNetwork,
		};
		// Published pi-ai builds before ModelsStore returned void and accepted a provider ID.
		// The fallback keeps source-mode CLI tests working without rebuilding workspace dependencies.
		const result = ((await this.models.refresh(refreshOptions)) as ModelsRefreshResult | undefined) ?? {
			aborted: refreshOptions.signal?.aborted ?? false,
			errors: new Map(),
		};
		this.updateModelSnapshot();
		try {
			await this.forceRefreshAvailability();
		} catch {
			// Availability errors are recorded by forceRefreshAvailability; refreshed models remain usable.
		}
		return result;
	}

	registerNativeProvider(provider: Provider): void {
		if (!provider.id.trim()) throw new Error("Provider id must not be empty.");
		this.extensionProviders.delete(provider.id);
		this.nativeExtensionProviders.set(provider.id, provider);
		this.recomposeProvider(provider.id);
		this.updateModelSnapshot();
		void this.refresh({ allowNetwork: false });
	}

	registerProvider(providerId: string, config: ProviderConfigInput): void {
		// Validate the incoming registration on its own, like the legacy registry:
		// a broken re-registration must throw without touching the stored config.
		// 与旧 ModelRegistry 契约一致：先独立校验本次注册，坏配置直接抛错、不污染已存配置。
		validateExtensionProvider(providerId, this.builtins.get(providerId), this.config.getProvider(providerId), config);
		this.nativeExtensionProviders.delete(providerId);
		// Re-registration merges defined values over the previous registration and
		// preserves undefined ones, matching the legacy ModelRegistry contract.
		const previous = this.extensionProviders.get(providerId);
		const effective: ProviderConfigInput = { ...previous };
		for (const [key, value] of Object.entries(config)) {
			if (value !== undefined) (effective as Record<string, unknown>)[key] = value;
		}
		this.extensionProviders.set(providerId, effective);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		if (
			this.snapshot.storedProviders.has(providerId) ||
			configuredRequestAuthStatus(this.config.getProvider(providerId), effective)?.configured
		) {
			const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
			const auth = new Map(this.snapshot.auth);
			// Provisional entry until the async refresh lands; never clobber a real check result.
			// 异步刷新落地前先放一个临时认证条目，让注册的 provider 立即可用；已有真实检查结果时绝不覆盖。
			if (!auth.get(providerId)) {
				auth.set(providerId, {
					type: effective.oauth && !effective.apiKey ? "oauth" : "api_key",
					source: "configured provider",
				});
			}
			this.snapshot = {
				...this.snapshot,
				auth,
				configuredProviders,
				available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
			};
		}
		void this.refresh({ allowNetwork: false });
	}

	unregisterProvider(providerId: string): void {
		this.extensionProviders.delete(providerId);
		this.nativeExtensionProviders.delete(providerId);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		void this.refresh({ allowNetwork: false });
	}
}
