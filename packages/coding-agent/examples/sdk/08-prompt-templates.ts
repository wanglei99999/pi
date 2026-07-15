/**
 * Prompt Templates
 *
 * File-based templates that inject content when invoked with /templatename.
 *
 * 提示词模板:文件形式的 /命令,用户输入 /deploy 时把模板 content
 * 作为提示词注入。与 skill 的区别:skill 是模型可自主取用的能力说明,
 * 模板是用户显式触发的一段固定提示词。
 */

import {
	createAgentSession,
	createSyntheticSourceInfo,
	DefaultResourceLoader,
	getAgentDir,
	type PromptTemplate,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

// Define custom templates
// 纯内存构造模板(套路同 04 篇的虚拟 skill):路径是虚拟的,来源标记为 sdk
const deployTemplate: PromptTemplate = {
	name: "deploy",
	description: "Deploy the application",
	filePath: "/virtual/prompts/deploy.md",
	sourceInfo: createSyntheticSourceInfo("/virtual/prompts/deploy.md", { source: "sdk" }),
	content: `# Deploy Instructions

1. Build: npm run build
2. Test: npm test
3. Deploy: npm run deploy`,
};

const loader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	// 覆盖钩子:自动发现的模板 + 自定义模板
	promptsOverride: (current) => ({
		prompts: [...current.prompts, deployTemplate],
		diagnostics: current.diagnostics,
	}),
});
await loader.reload();

// Discover templates from cwd/.pi/prompts/ and ~/.pi/agent/prompts/
const discovered = loader.getPrompts().prompts;
console.log("Discovered prompt templates:");
for (const template of discovered) {
	console.log(`  /${template.name}: ${template.description}`);
}

const { session } = await createAgentSession({
	resourceLoader: loader,
	sessionManager: SessionManager.inMemory(),
});
console.log(`Session created with ${discovered.length + 1} prompt templates`);
session.dispose();
