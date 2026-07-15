import type { generateImages as generateImagesOpenRouterFunction } from "../../api/openrouter-images.ts";
import { registerImagesApiProvider } from "../../images-api-registry.ts";
import type { AssistantImages, ImagesContext, ImagesFunction, ImagesModel, ImagesOptions } from "../../types.ts";

interface OpenRouterImagesProviderModule {
	// Keep the lazy module surface minimal so this registry file does not eagerly load provider runtime dependencies.
	// 保持延迟模块接口最小化，使本注册文件不会提前加载 provider 运行时依赖。
	generateImages: typeof generateImagesOpenRouterFunction;
}

// All calls share one import promise, preserving module singleton state and preventing concurrent duplicate loads.
// 所有调用共享同一个 import Promise，以保留模块单例状态并避免并发重复加载。
let openRouterImagesProviderModulePromise: Promise<OpenRouterImagesProviderModule> | undefined;

function createLazyLoadErrorImages(model: ImagesModel<"openrouter-images">, error: unknown): AssistantImages {
	// Convert import or provider failures into the normal AssistantImages error shape instead of rejecting the public function.
	// 将 import 或 provider 失败转换为标准 AssistantImages 错误结构，而不是让公共函数 reject。
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

function loadOpenRouterImagesProviderModule(): Promise<OpenRouterImagesProviderModule> {
	// The cached promise also preserves a failed import result, so repeated calls do not spin on a broken runtime dependency.
	// 缓存 Promise 也会保留失败的 import 结果，避免依赖损坏时重复尝试加载。
	openRouterImagesProviderModulePromise ||= import("../../api/openrouter-images.ts").then(
		(module) => module as OpenRouterImagesProviderModule,
	);
	return openRouterImagesProviderModulePromise;
}

export const generateImagesOpenRouter: ImagesFunction<"openrouter-images", ImagesOptions> = async (
	model: ImagesModel<"openrouter-images">,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	// Provider code is loaded only on the first image request; registration itself remains lightweight and side-effect free beyond the map.
	// provider 代码只在首次图片请求时加载；注册阶段除写入 map 外保持轻量。
	try {
		const module = await loadOpenRouterImagesProviderModule();
		return await module.generateImages(model, context, options);
	} catch (error) {
		return createLazyLoadErrorImages(model, error);
	}
};

export function registerBuiltInImagesApiProviders(): void {
	// Re-registering is behaviorally idempotent: the registry's last-write-wins entry is replaced with the same built-in callable.
	// 重复注册在行为上幂等：注册表后写覆盖的仍是同一个内置 callable。
	registerImagesApiProvider({
		api: "openrouter-images",
		generateImages: generateImagesOpenRouter,
	});
}

// Importing this module installs built-ins automatically; the exported function supports explicit registry reinitialization.
// 导入本模块会自动安装内置 provider；导出函数则支持显式重新初始化注册表。
registerBuiltInImagesApiProviders();
