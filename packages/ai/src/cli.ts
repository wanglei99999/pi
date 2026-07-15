#!/usr/bin/env node

import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { getOAuthProvider, getOAuthProviders } from "./utils/oauth/index.ts";
import type { OAuthCredentials, OAuthProviderId } from "./utils/oauth/types.ts";

const AUTH_FILE = "auth.json";
const PROVIDERS = getOAuthProviders();

// Keep readline prompting behind a Promise so every OAuth callback can share one sequential input channel.
// 将 readline 提示封装为 Promise，使所有 OAuth 回调复用同一个顺序输入通道。
function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
	return new Promise((resolve) => rl.question(question, resolve));
}

function loadAuth(): Record<string, { type: "oauth" } & OAuthCredentials> {
	// Treat a missing or malformed local file as an empty store; login can recreate it without a migration step.
	// 缺失或损坏的本地文件按空存储处理，登录流程可直接重建而无需迁移步骤。
	if (!existsSync(AUTH_FILE)) return {};
	try {
		return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
	} catch {
		return {};
	}
}

function saveAuth(auth: Record<string, { type: "oauth" } & OAuthCredentials>): void {
	// This standalone CLI owns a simple local JSON store; embedding applications should use their credential store.
	// 此独立 CLI 使用简单本地 JSON 存储；嵌入式应用应使用自身的凭据存储实现。
	writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), "utf-8");
}

async function login(providerId: OAuthProviderId): Promise<void> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		console.error(`Unknown provider: ${providerId}`);
		process.exit(1);
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	// One readline instance spans browser, device-code, prompt, and selector callbacks for the whole flow.
	// 单个 readline 实例贯穿浏览器、device code、prompt 和 selector 回调的完整流程。
	const promptFn = (msg: string) => prompt(rl, `${msg} `);

	try {
		const credentials = await provider.login({
			onAuth: (info) => {
				console.log(`\nOpen this URL in your browser:\n${info.url}`);
				if (info.instructions) console.log(info.instructions);
				console.log();
			},
			onDeviceCode: (info) => {
				console.log(`\nOpen this URL in your browser:\n${info.verificationUri}`);
				console.log(`Enter code: ${info.userCode}`);
				console.log();
			},
			onPrompt: async (p) => {
				return await promptFn(`${p.message}${p.placeholder ? ` (${p.placeholder})` : ""}:`);
			},
			onSelect: async (p) => {
				console.log(`\n${p.message}`);
				for (let i = 0; i < p.options.length; i++) {
					console.log(`  ${i + 1}. ${p.options[i].label}`);
				}
				const choice = await promptFn(`Enter number (1-${p.options.length}):`);
				const index = parseInt(choice, 10) - 1;
				return p.options[index]?.id;
			},
			onProgress: (msg) => console.log(msg),
		});

		const auth = loadAuth();
		// Replace only the selected provider entry so credentials for other providers remain intact.
		// 仅替换当前提供商条目，保留其他提供商的已有凭据。
		auth[providerId] = { type: "oauth", ...credentials };
		saveAuth(auth);

		console.log(`\nCredentials saved to ${AUTH_FILE}`);
	} finally {
		rl.close();
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];

	if (!command || command === "help" || command === "--help" || command === "-h") {
		const providerList = PROVIDERS.map((p) => `  ${p.id.padEnd(20)} ${p.name}`).join("\n");
		console.log(`Usage: npx @earendil-works/pi-ai <command> [provider]

Commands:
  login [provider]  Login to an OAuth provider
  list              List available providers

Providers:
${providerList}

Examples:
  npx @earendil-works/pi-ai login              # interactive provider selection
  npx @earendil-works/pi-ai login anthropic    # login to specific provider
  npx @earendil-works/pi-ai list               # list providers
`);
		return;
	}

	if (command === "list") {
		console.log("Available OAuth providers:\n");
		for (const p of PROVIDERS) {
			console.log(`  ${p.id.padEnd(20)} ${p.name}`);
		}
		return;
	}

	if (command === "login") {
		let provider = args[1] as OAuthProviderId | undefined;

		if (!provider) {
			// Interactive selection is only a fallback; an explicit provider ID remains script-friendly.
			// 交互选择仅作为回退；显式 provider ID 仍便于脚本调用。
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			console.log("Select a provider:\n");
			for (let i = 0; i < PROVIDERS.length; i++) {
				console.log(`  ${i + 1}. ${PROVIDERS[i].name}`);
			}
			console.log();

			const choice = await prompt(rl, `Enter number (1-${PROVIDERS.length}): `);
			rl.close();

			const index = parseInt(choice, 10) - 1;
			if (index < 0 || index >= PROVIDERS.length) {
				console.error("Invalid selection");
				process.exit(1);
			}
			provider = PROVIDERS[index].id;
		}

		if (!PROVIDERS.some((p) => p.id === provider)) {
			console.error(`Unknown provider: ${provider}`);
			console.error(`Use 'npx @earendil-works/pi-ai list' to see available providers`);
			process.exit(1);
		}

		console.log(`Logging in to ${provider}...`);
		await login(provider);
		return;
	}

	console.error(`Unknown command: ${command}`);
	console.error(`Use 'npx @earendil-works/pi-ai --help' for usage`);
	process.exit(1);
}

main().catch((err) => {
	// Convert uncaught flow failures into a stable CLI exit status without changing provider error text.
	// 将未捕获的流程失败转换为稳定的 CLI 退出状态，同时不改写提供商错误文本。
	console.error("Error:", err.message);
	process.exit(1);
});
