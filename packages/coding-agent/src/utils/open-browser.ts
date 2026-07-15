import { spawn } from "node:child_process";

/**
 * Open a URL or file in the platform browser/default handler.
 * 使用平台浏览器或默认处理程序打开 URL 或文件。
 *
 * This intentionally never invokes a shell. On Windows, do not use
 * `cmd /c start`: cmd.exe re-parses metacharacters (&, |, ^, ...) before
 * `start` runs, which would make attacker-controlled URLs injectable.
 * 此处刻意不启动 shell。Windows 上不要改用 `cmd /c start`：cmd.exe 会在
 * `start` 执行前重新解析元字符 (&, |, ^, ...)，使外部提供的 URL 产生命令注入风险。
 */
export function openBrowser(target: string): void {
	// 每个平台都直接调用系统默认处理器，并把 target 作为独立 argv 传递，避免 shell 字符串拼接。
	const [cmd, args]: [string, string[]] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", target]]
				: ["xdg-open", [target]];

	// spawn reports launcher failures (for example, missing xdg-open) via an
	// error event. Browser launch is best-effort: callers still present the target
	// to the user, so keep the launcher failure from becoming a process crash.
	// spawn 通过 error 事件报告启动器缺失等失败。打开操作属于尽力而为，调用方仍会向用户展示 target，
	// 因此这里吞掉启动失败，避免未处理的子进程错误导致主进程崩溃。
	// detached 配合 unref 使调用方无需等待默认处理器退出，也不会阻止 CLI 正常结束。
	spawn(cmd, args, { stdio: "ignore", detached: true })
		.on("error", () => {})
		.unref();
}
