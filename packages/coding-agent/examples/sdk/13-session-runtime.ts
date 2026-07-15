/**
 * Session runtime
 *
 * Use AgentSessionRuntime when you need to replace the active AgentSession,
 * for example for new-session, resume, fork, or import flows.
 *
 * The important pattern is: after the runtime replaces the active session,
 * rebind any session-local subscriptions and extension bindings to `runtime.session`.
 *
 * 会话运行时:AgentSession 一旦创建就绑定单个会话文件;宿主要支持
 * "换会话"(新建/恢复/fork/导入)就需要 AgentSessionRuntime 这层包装 ——
 * 它负责销毁旧 session、装配新 session。
 * 关键模式:每次替换后,所有 session 级的订阅和扩展绑定都必须
 * 重新绑到新的 runtime.session 上(旧引用已失效)。pi 的 TUI 就是这么做的。
 */

import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

// 工厂函数:runtime 每次换会话都调用它重建 session。
// 两步装配:createAgentSessionServices(重资源,可复用)→ createAgentSessionFromServices(轻装配)
const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({ cwd });
	return {
		...(await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
		})),
		services,
		diagnostics: services.diagnostics,
	};
};
const runtime = await createAgentSessionRuntime(createRuntime, {
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	sessionManager: SessionManager.create(process.cwd()),
});

let unsubscribe: (() => void) | undefined;

// 重绑函数:先退掉旧订阅,再对新 session 绑扩展 + 订阅事件
async function bindSession() {
	unsubscribe?.();
	const session = runtime.session;
	await session.bindExtensions({});
	unsubscribe = session.subscribe((event) => {
		if (event.type === "queue_update") {
			console.log("Queued:", event.steering.length + event.followUp.length);
		}
	});
	return session;
}

let session = await bindSession();
const originalSessionFile = session.sessionFile;
console.log("Initial session:", originalSessionFile);

// 换到新会话:runtime.session 被整体替换,必须重新 bindSession()
await runtime.newSession();
session = await bindSession();
console.log("After newSession():", session.sessionFile);

// 切回旧会话文件:同样要重绑
if (originalSessionFile) {
	await runtime.switchSession(originalSessionFile);
	session = await bindSession();
	console.log("After switchSession():", session.sessionFile);
}

unsubscribe?.();
await runtime.dispose();
