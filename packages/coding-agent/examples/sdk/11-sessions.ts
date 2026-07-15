/**
 * Session Management
 *
 * Control session persistence: in-memory, new file, continue, or open specific.
 *
 * 会话管理:SessionManager 的四种打开方式 —— inMemory(不持久化)/
 * create(新建 JSONL 文件)/ continueRecent(续最近一个)/ open(按路径打开)。
 * 会话文件是树形结构的 JSONL(支持分支),默认按 cwd 编码存放目录。
 */

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

// In-memory (no persistence)
// 纯内存:不写任何文件,sessionFile 为 undefined
const { session: inMemory } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
});
console.log("In-memory session:", inMemory.sessionFile ?? "(none)");
inMemory.dispose();

// New persistent session
// 新建持久化会话:会话文件按 cwd 编码放在默认目录下
const { session: newSession } = await createAgentSession({
	sessionManager: SessionManager.create(process.cwd()),
});
console.log("New session file:", newSession.sessionFile);
newSession.dispose();

// Continue most recent session (or create new if none)
// 续最近会话(没有就新建);modelFallbackMessage:原会话的模型现在不可用时的降级提示
const { session: continued, modelFallbackMessage } = await createAgentSession({
	sessionManager: SessionManager.continueRecent(process.cwd()),
});
if (modelFallbackMessage) console.log("Note:", modelFallbackMessage);
console.log("Continued session:", continued.sessionFile);
continued.dispose();

// List and open specific session
// 枚举本项目的历史会话,再按路径精确打开某一个
const sessions = await SessionManager.list(process.cwd());
console.log(`\nFound ${sessions.length} sessions:`);
for (const info of sessions.slice(0, 3)) {
	console.log(`  ${info.id.slice(0, 8)}... - "${info.firstMessage.slice(0, 30)}..."`);
}

if (sessions.length > 0) {
	const { session: opened } = await createAgentSession({
		sessionManager: SessionManager.open(sessions[0].path),
	});
	console.log(`\nOpened: ${opened.sessionId}`);
	opened.dispose();
}

// Custom session directory (no cwd encoding)
// 自定义会话目录:绕开默认的 cwd 编码规则,list/continueRecent 也要传同一个目录
// const customDir = "/path/to/my-sessions";
// const { session } = await createAgentSession({
//   sessionManager: SessionManager.create(process.cwd(), customDir),
// });
// SessionManager.list(process.cwd(), customDir);
// SessionManager.continueRecent(process.cwd(), customDir);
