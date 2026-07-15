import "./providers/images/register-builtins.ts";

// Importing the built-in registration module establishes default APIs before any lookup occurs.
// 导入内置注册模块会在首次查找前建立默认图片 API。
import { getImagesApiProvider } from "./images-api-registry.ts";
import type { AssistantImages, ImagesApi, ImagesContext, ImagesModel, ProviderImagesOptions } from "./types.ts";

function resolveImagesApiProvider(api: ImagesApi) {
	// Fail at the dispatch boundary when a model references an API with no registered implementation.
	// 模型引用未注册实现的 API 时，在分发边界立即失败。
	const provider = getImagesApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

export async function generateImages<TApi extends ImagesApi>(
	model: ImagesModel<TApi>,
	context: ImagesContext,
	options?: ProviderImagesOptions,
): Promise<AssistantImages> {
	// Dispatch by the model's API field while preserving its provider-specific option type at the public boundary.
	// 按模型的 API 字段分发，同时在公共边界保留提供商专用选项类型。
	const provider = resolveImagesApiProvider(model.api);
	return provider.generateImages(model, context, options);
}
