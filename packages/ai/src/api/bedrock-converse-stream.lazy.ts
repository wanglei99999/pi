import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/**
 * Loads the bedrock implementation through a variable specifier so bundlers
 * (browser smoke, Bun compile) cannot follow the import into the Node-only
 * AWS SDK. The `.ts`/`.js` rewrite keeps the trick working from both source
 * and built output.
 * 通过变量形式的模块说明符加载 Bedrock 实现，使打包器（browser smoke、Bun compile）
 * 无法沿导入路径进入仅限 Node 的 AWS SDK。对 `.ts`/`.js` 的改写确保该机制在源码
 * 和构建产物中都能工作。
 */
const importNodeOnlyApi = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

let bedrockModuleOverride: ProviderStreams | undefined;

/**
 * Overrides the dynamically imported bedrock implementation. Used by the Bun
 * binary build, where the variable-specifier import cannot be bundled; the
 * build registers a statically imported module instead.
 * 覆盖动态导入的 Bedrock 实现。Bun 二进制构建会使用此入口，因为变量模块说明符
 * 无法被打包；构建流程会改为注册一个静态导入的模块。
 */
export function setBedrockProviderModule(module: ProviderStreams): void {
	bedrockModuleOverride = module;
}

export const bedrockConverseStreamApi = (): ProviderStreams =>
	lazyApi(
		async () =>
			// 构建时注册的覆盖模块优先，常规 Node 运行时才回退到动态导入。
			bedrockModuleOverride ?? ((await importNodeOnlyApi("./bedrock-converse-stream.ts")) as ProviderStreams),
	);
