/**
 * API Keys and OAuth
 *
 * Configure API key resolution via AuthStorage and ModelRegistry.
 *
 * 密钥与 OAuth:密钥解析链是 AuthStorage(auth.json 落盘 + 运行时覆盖)
 * → ModelRegistry(内置模型 + models.json 自定义模型)。
 * 四个片段依次演示:默认位置 / 自定义位置 / 运行时注入 / 纯内置模型。
 * 嵌入自己的应用时,通常用"运行时注入 + inMemory"组合,完全不碰磁盘。
 */

import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";

// Default: AuthStorage uses ~/.pi/agent/auth.json
// ModelRegistry loads built-in + custom models from ~/.pi/agent/models.json
// 默认位置:auth.json 存密钥(含 OAuth 令牌),models.json 存自定义模型
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session: defaultAuthSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
console.log("Session with default auth storage and model registry");
defaultAuthSession.dispose();

// Custom auth storage location
// 自定义存储位置:嵌入宿主应用时避免与用户的 ~/.pi 互相污染
const customAuthStorage = AuthStorage.create("/tmp/my-app/auth.json");
const customModelRegistry = ModelRegistry.create(customAuthStorage, "/tmp/my-app/models.json");

const { session: customAuthSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage: customAuthStorage,
	modelRegistry: customModelRegistry,
});
console.log("Session with custom auth storage location");
customAuthSession.dispose();

// Runtime API key override (not persisted to disk)
// 运行时密钥:只在内存、不落盘,适合从环境变量或密钥管理器注入
authStorage.setRuntimeApiKey("anthropic", "sk-my-temp-key");
const { session: runtimeKeySession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
console.log("Session with runtime API key override");
runtimeKeySession.dispose();

// No models.json - only built-in models
// 纯内存注册表:不读 models.json,只认内置模型
const simpleRegistry = ModelRegistry.inMemory(authStorage);
const { session: builtInModelsSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry: simpleRegistry,
});
console.log("Session with only built-in models");
builtInModelsSession.dispose();
