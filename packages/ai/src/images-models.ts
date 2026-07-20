import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { type AuthResolutionOverrides, ModelsError, resolveProviderAuth } from "./auth/resolve.ts";
import type { AuthContext, AuthResult, CredentialStore, ProviderAuth } from "./auth/types.ts";
import type { CreateModelsOptions } from "./models.ts";
import type { AssistantImages, ImagesApi, ImagesContext, ImagesModel, ImagesOptions, ProviderImages } from "./types.ts";

/**
 * An image-generation provider: the image-side counterpart of `Provider`.
 * 图片生成提供商，是聊天侧 `Provider` 的对应抽象。
 * Owns id/name metadata, auth, model listing, and generation behavior.
 * 负责 id/name 元数据、认证、模型列表和图片生成行为。
 */
export interface ImagesProvider {
	readonly id: string;
	readonly name: string;

	/**
	 * Required: at least one of `apiKey`/`oauth`. Same semantics as chat
	 * 必填：至少定义 `apiKey` 或 `oauth` 之一，语义与聊天提供商一致；
	 * providers; `ImagesModels.getAuth()` returns undefined when the provider
	 * 提供商未配置时，`ImagesModels.getAuth()`
	 * is unconfigured.
	 * 返回 undefined。
	 */
	readonly auth: ProviderAuth;

	/**
	 * Current known models, sync. Static providers return their catalog;
	 * 同步返回当前已知模型。静态提供商返回固定目录；
	 * dynamic providers return the list as of the last `refreshModels()`
	 * 动态提供商返回最近一次 `refreshModels()` 得到的列表，
	 * (empty before the first). Must not throw; `ImagesModels` treats a
	 * 首次刷新前为空。此方法不得抛出；若实现抛出，
	 * throwing implementation as having no models.
	 * `ImagesModels` 会将该提供商视为没有模型。
	 */
	getModels(): readonly ImagesModel<ImagesApi>[];

	/**
	 * Dynamic providers only: fetch and update the model list. May reject
	 * 仅用于动态提供商：获取并更新模型列表。网络失败时可以 reject；
	 * (network); on rejection the model list stays at its last-known state
	 * 失败后保留最近一次成功的模型列表，
	 * and a later call retries.
	 * 后续调用会重新尝试。
	 */
	refreshModels?(): Promise<void>;

	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

/**
 * Runtime collection of image-generation providers plus auth application and
 * 图片生成提供商的运行时集合，同时负责应用认证并提供
 * generation convenience: the image-side counterpart of `Models`.
 * 生成便捷方法，是聊天侧 `Models` 的对应抽象。
 */
export interface ImagesModels {
	getProviders(): readonly ImagesProvider[];
	getProvider(id: string): ImagesProvider | undefined;

	/**
	 * Sync read of last-known models from one provider or all providers.
	 * 同步读取单个或全部提供商最近已知的模型列表。
	 * Best-effort: a provider whose `getModels()` throws yields no models.
	 * 采用尽力而为语义：某提供商的 `getModels()` 抛出时，该提供商返回空列表。
	 */
	getModels(provider?: string): readonly ImagesModel<ImagesApi>[];

	/** Sync runtime model lookup against last-known lists. */
	/** 在最近已知列表中按 provider 和 id 同步查询图片模型。 */
	getModel(provider: string, id: string): ImagesModel<ImagesApi> | undefined;

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
	 * Resolve request auth by provider id or image model. Same contract as
	 * 为图片模型解析请求认证，契约与
	 * `Models.getAuth()`: undefined when unknown/unconfigured, rejects with
	 * `Models.getAuth()` 相同：未知或未配置时返回 undefined，真实认证失败时
	 * `ModelsError` ("oauth"/"auth") on real failures.
	 * 以 `ModelsError`（"oauth"/"auth"）reject。
	 */
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: ImagesModel<ImagesApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;

	/**
	 * Generate images through the owning provider with auth resolved and
	 * 解析认证并合并请求选项后，通过拥有该模型的提供商生成图片；
	 * merged (explicit options win per field). Never rejects; failures are
	 * 显式选项按字段优先。此方法永不 reject，失败会
	 * returned as an `AssistantImages` with `stopReason: "error"`.
	 * 转换为 `stopReason: "error"` 的 `AssistantImages`。
	 */
	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

export interface MutableImagesModels extends ImagesModels {
	/** Upsert/replace by provider.id. Provider ids are unique. */
	/** 按 provider.id 新增或替换；provider id 在集合内唯一。 */
	setProvider(provider: ImagesProvider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}

class ImagesModelsImpl implements MutableImagesModels {
	private providers = new Map<string, ImagesProvider>();
	private credentials: CredentialStore;
	private authContext: AuthContext;

	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	setProvider(provider: ImagesProvider): void {
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.providers.delete(id);
	}

	clearProviders(): void {
		this.providers.clear();
	}

	getProviders(): readonly ImagesProvider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): ImagesProvider | undefined {
		return this.providers.get(id);
	}

	getModels(provider?: string): readonly ImagesModel<ImagesApi>[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		const models: ImagesModel<ImagesApi>[] = [];
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

	getModel(provider: string, id: string): ImagesModel<ImagesApi> | undefined {
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

	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: ImagesModel<ImagesApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | ImagesModel<ImagesApi>,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		return resolveProviderAuth(provider, this.credentials, this.authContext, overrides);
	}

	async generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages> {
		try {
			const provider = this.providers.get(model.provider);
			if (!provider) {
				throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
			}

			const resolution = await this.getAuth(model, {
				apiKey: options?.apiKey,
				env: options?.env,
			});
			const auth = resolution?.auth;
			if (!auth) {
				return provider.generateImages(model, context, options);
			}

			const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;

			// Explicit request options win per-field; headers/env merge per key.
			// 显式请求选项按字段优先；headers 和 env 按键合并，允许调用方局部覆盖认证结果。
			const apiKey = options?.apiKey ?? auth.apiKey;
			const headers = auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined;
			const env =
				resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;

			return await provider.generateImages(requestModel, context, { ...options, apiKey, headers, env });
		} catch (error) {
			return {
				api: model.api,
				provider: model.provider,
				model: model.id,
				output: [],
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				timestamp: Date.now(),
			};
		}
	}
}

export function createImagesModels(options?: CreateModelsOptions): MutableImagesModels {
	return new ImagesModelsImpl(options);
}

export interface CreateImagesProviderOptions {
	id: string;
	/** Display name. Default: `id`. */
	/** 显示名称，默认使用 `id`。 */
	name?: string;
	/** Required — every provider has auth semantics, even ambient/keyless ones. */
	/** 必填；即使依赖环境凭据或无密钥的提供商也必须声明认证语义。 */
	auth: ProviderAuth;
	/** Initial model list (empty for purely dynamic providers). */
	/** 初始模型列表；纯动态提供商可为空。每个 ImagesModel 声明其输入和输出能力。 */
	models: readonly ImagesModel<ImagesApi>[];
	/**
	 * Dynamic providers: fetch the current list. Stored on success; concurrent
	 * 动态提供商通过此函数获取当前模型列表。成功结果会被保存，并发
	 * calls share one in-flight fetch. May reject: the stored list then stays
	 * 调用共享同一个进行中的请求。失败时允许 reject，已保存列表仍保持
	 * at its last-known state, the rejection propagates to the caller of
	 * 最近一次成功状态；rejection 会传递给 `refreshModels()` 调用方，
	 * `refreshModels()` (wrapped as ModelsError "model_source" by
	 * 并由 `ImagesModels.refresh(provider)` 包装为 ModelsError "model_source"，
	 * `ImagesModels.refresh(provider)`), and a later call retries.
	 * 后续调用会重新尝试。
	 */
	refreshModels?: () => Promise<readonly ImagesModel<ImagesApi>[]>;
	api: ProviderImages;
}

/** Builds an image-generation provider from parts. */
/** 由认证、模型列表和图片 API 实现组装图片生成提供商。 */
export function createImagesProvider(input: CreateImagesProviderOptions): ImagesProvider {
	let models = input.models;
	let inflightRefresh: Promise<void> | undefined;
	const refreshModels = input.refreshModels;

	return {
		id: input.id,
		name: input.name ?? input.id,
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
		generateImages: (model, context, options) => input.api.generateImages(model, context, options),
	};
}
