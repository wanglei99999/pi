/**
 * API Keys and OAuth
 *
 * Configure provider auth through ModelRuntime.
 * 密钥与 OAuth:统一通过 ModelRuntime 配置(auth.json 落盘 + models.json 自定义模型 + 运行时覆盖)。
 * 三个片段依次演示:默认位置 / 自定义位置 / 运行时注入。
 * 嵌入自己的应用时,通常用"运行时注入 + inMemory 会话"组合,尽量不碰用户的 ~/.pi。
 */

import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const { session: defaultAuthSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	modelRuntime,
});
console.log("Session with default model runtime");
defaultAuthSession.dispose();

const customRuntime = await ModelRuntime.create({
	authPath: "/tmp/my-app/auth.json",
	modelsPath: "/tmp/my-app/models.json",
});
const { session: customAuthSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	modelRuntime: customRuntime,
});
console.log("Session with custom auth and models locations");
customAuthSession.dispose();

// 运行时密钥:只在内存、不落盘,适合从环境变量或密钥管理器注入
modelRuntime.setRuntimeApiKey("anthropic", "sk-my-temp-key");
const { session: runtimeKeySession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	modelRuntime,
});
console.log("Session with runtime API key override");
runtimeKeySession.dispose();
