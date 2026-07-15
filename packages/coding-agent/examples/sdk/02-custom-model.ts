/**
 * Custom Model Selection
 *
 * Shows how to select a specific model and thinking level.
 *
 * 模型选择:演示三种拿到 Model 对象的方式,以及 thinkingLevel 的设置。
 * 注意两条查找路径的区别:getModel() 只查 pi-ai 的内置模型表,
 * ModelRegistry 还叠加了 ~/.pi/agent/models.json 里的自定义模型。
 */

import { getModel } from "@earendil-works/pi-ai/compat";
import { AuthStorage, createAgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";

// Set up auth storage and model registry
// 装配密钥存储和模型注册表:AuthStorage 管密钥(默认 ~/.pi/agent/auth.json),
// ModelRegistry 依赖它来判断"哪些模型有密钥可用"
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// Option 1: Find a specific built-in model by provider/id
// 方式 1:按 provider/id 直接查内置模型表(models.generated.ts,不含自定义模型)
const opus = getModel("anthropic", "claude-opus-4-5");
if (opus) {
	console.log(`Found model: ${opus.provider}/${opus.id}`);
}

// Option 2: Find model via registry (includes custom models from models.json)
// 方式 2:走 ModelRegistry,内置 + models.json 自定义模型都能查到
const customModel = modelRegistry.find("my-provider", "my-model");
if (customModel) {
	console.log(`Found custom model: ${customModel.provider}/${customModel.id}`);
}

// Option 3: Pick from available models (have valid API keys)
// 方式 3:列出"当前有有效密钥"的模型,适合运行时自动选型
const available = await modelRegistry.getAvailable();
console.log(
	"Available models:",
	available.map((m) => `${m.provider}/${m.id}`),
);

if (available.length > 0) {
	const { session } = await createAgentSession({
		model: available[0],
		thinkingLevel: "medium", // off, low, medium, high
		// thinkingLevel:推理力度档位,映射到各 provider 的思考预算参数
		authStorage,
		modelRegistry,
	});

	try {
		session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				process.stdout.write(event.assistantMessageEvent.delta);
			}
		});

		await session.prompt("Say hello in one sentence.");
		console.log();
	} finally {
		session.dispose();
	}
}
