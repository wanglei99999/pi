/**
 * Tools Configuration
 *
 * Use tool names to choose which built-in tools are enabled.
 *
 * Tool names are matched against all available tools. If you use a custom `cwd`,
 * createAgentSession() applies that cwd when it builds the actual built-in tools.
 *
 * For custom tools, see 06-extensions.ts - custom tools are registered via the
 * extensions system using pi.registerTool().
 *
 * 工具配置:用名字白名单挑选启用哪些内置工具(read/bash/edit/write/grep/find/ls...)。
 * 传了自定义 cwd 时,内置工具会以该 cwd 为根来构建。
 * 注意:这里只管"内置工具选哪些";自定义工具不走这里,
 * 而是走扩展系统的 pi.registerTool()(见 06-extensions.ts)。
 */

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

// Read-only mode (no edit/write)
// 只读模式:不给 edit/write,agent 就无法改文件 —— 工具白名单即权限边界
const { session: readOnlySession } = await createAgentSession({
	tools: ["read", "grep", "find", "ls"],
	sessionManager: SessionManager.inMemory(),
});
console.log("Read-only session created");
readOnlySession.dispose();

// Custom tool selection
// 自定义组合:留 bash 意味着 agent 仍可执行任意命令,按需取舍
const { session: customToolsSession } = await createAgentSession({
	tools: ["read", "bash", "grep"],
	sessionManager: SessionManager.inMemory(),
});
console.log("Custom tools session created");
customToolsSession.dispose();

// With custom cwd
// 自定义工作目录:工具的相对路径都以此为根;SessionManager.inMemory 也要传同一个 cwd
const customCwd = "/path/to/project";
const { session: customCwdSession } = await createAgentSession({
	cwd: customCwd,
	tools: ["read", "bash", "edit", "write"],
	sessionManager: SessionManager.inMemory(customCwd),
});
console.log("Custom cwd session created");
customCwdSession.dispose();

// Or pick specific tools for custom cwd
const { session: specificToolsSession } = await createAgentSession({
	cwd: customCwd,
	tools: ["read", "bash", "grep"],
	sessionManager: SessionManager.inMemory(customCwd),
});
console.log("Specific tools with custom cwd session created");
specificToolsSession.dispose();
