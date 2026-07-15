#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = `${APP_NAME}-rpc`;
process.env.PI_CODING_AGENT = "true";
// Suppress process warnings so RPC output remains reserved for the machine-readable protocol.
// 禁止进程警告，确保 RPC 输出仅用于机器可读协议。
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Configure shared HTTP transport before handing control to the RPC runtime.
// 在将控制权交给 RPC 运行时前配置共享 HTTP 传输层。
configureHttpDispatcher();

// Force the dedicated RPC mode; main owns startup validation, error reporting, and exit status.
// 强制使用专用 RPC 模式；启动校验、错误报告与退出状态由 main 统一负责。
main(["--mode", "rpc", ...process.argv.slice(2)]);
