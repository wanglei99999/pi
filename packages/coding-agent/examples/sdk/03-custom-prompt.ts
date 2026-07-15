/**
 * Custom System Prompt
 *
 * Shows how to replace or modify the default system prompt.
 *
 * 自定义系统提示词:两种方式 —— 整体替换 vs 在默认提示词后追加。
 * 关键机制是 DefaultResourceLoader 的 override 钩子:先自动发现,
 * 再由钩子覆盖/加工发现结果。这是把 pi 改造成其他领域 agent
 * (如数据 agent)的第一入口。
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();
const agentDir = getAgentDir();

// Option 1: Replace prompt entirely
// 方式 1:整体替换系统提示词(内置的编码 agent 人设完全不用)
const loader1 = new DefaultResourceLoader({
	cwd,
	agentDir,
	systemPromptOverride: () => `You are a helpful assistant that speaks like a pirate.
Always end responses with "Arrr!"`,
	// Needed to avoid DefaultResourceLoader appending APPEND_SYSTEM.md from ~/.pi/agent or <cwd>/.pi.
	// 必须同时置空追加段,否则 loader 还会拼上 ~/.pi/agent 或 <cwd>/.pi 里的 APPEND_SYSTEM.md
	appendSystemPromptOverride: () => [],
});
// override 只是注册;reload() 才真正执行"发现 + 覆盖"流程
await loader1.reload();

const { session: session1 } = await createAgentSession({
	resourceLoader: loader1,
	sessionManager: SessionManager.inMemory(),
});

try {
	session1.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	console.log("=== Replace prompt ===");
	await session1.prompt("What is 2 + 2?");
	console.log("\n");
} finally {
	session1.dispose();
}

// Option 2: Append instructions to the default prompt
// 方式 2:保留默认提示词,只在后面追加自定义段落(base 是已有的追加段数组)
const loader2 = new DefaultResourceLoader({
	cwd,
	agentDir,
	appendSystemPromptOverride: (base) => [
		...base,
		"## Additional Instructions\n- Always be concise\n- Use bullet points when listing things",
	],
});
await loader2.reload();

const { session: session2 } = await createAgentSession({
	resourceLoader: loader2,
	sessionManager: SessionManager.inMemory(),
});

try {
	session2.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	console.log("=== Modify prompt ===");
	await session2.prompt("List 3 benefits of TypeScript.");
	console.log();
} finally {
	session2.dispose();
}
