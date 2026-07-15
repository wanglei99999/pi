/**
 * Minimal SDK Usage
 *
 * Uses all defaults: discovers skills, extensions, tools, context files
 * from cwd and ~/.pi/agent. Model chosen from settings or first available.
 *
 * 最小可用示例:全部走默认值 —— 自动从 cwd 和 ~/.pi/agent 发现
 * skills、extensions、tools、AGENTS.md;模型取 settings 的默认值,
 * 否则选第一个有可用 API 密钥的模型。
 *
 * 核心三步:createAgentSession() 建会话 → subscribe() 订阅事件流 →
 * prompt() 跑一轮对话。这是后面 12 个示例共同的骨架。
 */

import { createAgentSession } from "@earendil-works/pi-coding-agent";

// ESM 支持顶层 await;返回对象里除 session 外还有 modelFallbackMessage 等字段,这里解构只取 session
const { session } = await createAgentSession();

try {
	// 订阅事件流:message_update + text_delta 就是流式输出的文本增量(打字机效果)
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	// 发起一轮对话;await 返回时 agent 已完全停止(含中间所有工具调用循环)
	await session.prompt("What files are in the current directory?");
	// session.state 是内存态,messages 为完整消息历史(AgentMessage[],含工具调用/结果)
	session.state.messages.forEach((msg) => {
		console.log(msg);
	});
	console.log();
} finally {
	// 必须 dispose:释放扩展运行时、文件监听等资源,否则进程可能不退出
	session.dispose();
}
