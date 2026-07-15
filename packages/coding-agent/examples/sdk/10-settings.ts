/**
 * Settings Configuration
 *
 * Override settings using SettingsManager.
 *
 * 设置管理:SettingsManager 的三种用法 —— 从磁盘读合并配置(全局 + 项目)、
 * applyOverrides 做运行时覆盖(不落盘)、inMemory 纯内存(测试/嵌入)。
 * 注意它的写入模型:setter 立即改内存 + 异步排队落盘,flush() 是持久化屏障,
 * drainErrors() 把 I/O 错误交回应用层 —— pi 不静默吞错误。
 */

import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();

// Load current settings (merged global + project)
// 读取当前设置:全局(~/.pi)与项目(<cwd>/.pi)合并后的结果
const settingsManagerFromDisk = SettingsManager.create(cwd);
console.log("Current settings:", JSON.stringify(settingsManagerFromDisk.getGlobalSettings(), null, 2));

// Override specific settings
// 运行时覆盖:只影响本进程,不写回 settings.json
const settingsManager = SettingsManager.create(cwd);
settingsManager.applyOverrides({
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
});

const { session: customSettingsSession } = await createAgentSession({
	settingsManager,
	sessionManager: SessionManager.inMemory(),
});
console.log("Session created with custom settings");
customSettingsSession.dispose();

// Setters update memory immediately and queue persistence writes.
// Call flush() when you need a durability boundary.
// setter 是"内存立即生效 + 落盘异步排队";需要确保写完时调 flush()
settingsManager.setDefaultThinkingLevel("low");
await settingsManager.flush();

// Surface settings I/O errors at the app layer.
// 设置读写的 I/O 错误不抛出、而是攒着,由应用层 drainErrors() 取走处理
const settingsErrors = settingsManager.drainErrors();
if (settingsErrors.length > 0) {
	for (const { scope, error } of settingsErrors) {
		console.warn(`Warning (${scope} settings): ${error.message}`);
	}
}

// For testing without file I/O:
// 纯内存模式:完全不碰文件系统,测试和嵌入场景用
const inMemorySettings = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: false },
});

const { session: testSession } = await createAgentSession({
	settingsManager: inMemorySettings,
	sessionManager: SessionManager.inMemory(),
});
console.log("Test session created with in-memory settings");
testSession.dispose();
