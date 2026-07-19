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
import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();

// Option 1: Find a specific built-in model by provider/id
// 方式 1:按 provider/id 直接查内置模型表(models.generated.ts,不含自定义模型)
const opus = getModel("anthropic", "claude-opus-4-5");
if (opus) {
	console.log(`Found model: ${opus.provider}/${opus.id}`);
}

// Option 2: Find model via registry (includes custom models from models.json)
const customModel = modelRuntime.getModel("my-provider", "my-model");
if (customModel) {
	console.log(`Found custom model: ${customModel.provider}/${customModel.id}`);
}

// Option 3: Pick from available models (have valid API keys)
const available = await modelRuntime.getAvailable();
console.log(
	"Available models:",
	available.map((m) => `${m.provider}/${m.id}`),
);

if (available.length > 0) {
	const { session } = await createAgentSession({
		model: available[0],
		thinkingLevel: "medium", // off, low, medium, high
		modelRuntime,
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
