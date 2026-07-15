#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 * 重构后 coding agent 的 CLI 入口，使用 main.ts、AgentSession 和新的模式模块。
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 * 可使用上述命令测试此入口。
 */
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
// CLI 统一接管诊断展示，因此关闭 Node 默认 warning 输出，避免干扰终端界面和机器可读模式。
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Configure undici's global dispatcher before provider SDKs issue requests.
// Runtime settings are applied once SettingsManager has loaded global/project settings.
// 在 provider SDK 发起请求前配置 undici 全局 dispatcher；待 SettingsManager 加载全局/项目设置后，
// 再应用运行时配置。
configureHttpDispatcher();

main(process.argv.slice(2));
