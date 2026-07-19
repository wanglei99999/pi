/**
 * Full Control
 *
 * Replace everything - no discovery, explicit configuration.
 *
 * 完全接管:关闭一切自动发现,所有依赖显式构造。这是 SDK 定制的上界 ——
 * 手写的 ResourceLoader 空实现就是"资源发现层"的完整契约(九个方法),
 * 全部返回空即彻底裸机。做嵌入式领域 agent(如数据 agent)且不想
 * 继承 pi 的磁盘约定时,以这个示例为模板。
 */

import { getModel } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create({
	authPath: "/tmp/my-agent/auth.json",
	modelsPath: "/tmp/my-agent/models.json",
});
if (process.env.MY_ANTHROPIC_KEY) {
	modelRuntime.setRuntimeApiKey("anthropic", process.env.MY_ANTHROPIC_KEY);
}

const model = getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Model not found");

// In-memory settings with overrides
// 纯内存设置:不读写 settings.json
const settingsManager = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 2 },
});

const cwd = process.cwd();

// 手写 ResourceLoader:这九个方法就是资源层的全部契约。
// 各资源返回空 = 不加载任何扩展/skill/模板/主题/AGENTS.md;
// 系统提示词也在这里给出(对比 03 篇:那边是 override 钩子,这边是直接实现接口)
const resourceLoader: ResourceLoader = {
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => `You are a minimal assistant.
Available: read, bash. Be concise.`,
	getAppendSystemPrompt: () => [],
	extendResources: () => {},
	reload: async () => {},
};

const { session } = await createAgentSession({
	cwd,
	agentDir: "/tmp/my-agent",
	model,
	thinkingLevel: "off",
	modelRuntime,
	resourceLoader,
	tools: ["read", "bash"],
	sessionManager: SessionManager.inMemory(cwd),
	settingsManager,
});

try {
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await session.prompt("List files in the current directory.");
	console.log();
} finally {
	session.dispose();
}
