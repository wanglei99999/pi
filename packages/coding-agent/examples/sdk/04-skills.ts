/**
 * Skills Configuration
 *
 * Skills provide specialized instructions loaded into the system prompt.
 * Discover, filter, merge, or replace them.
 *
 * Skills 配置:skill 是注入系统提示词的专项指令(SKILL.md 目录)。
 * 本例演示三个动作:自动发现、按名过滤、注入纯内存构造的自定义 skill。
 * 套路和 03 篇一样:DefaultResourceLoader 的 xxxOverride 钩子
 * 拿到自动发现结果(current),加工后返回。
 */

import {
	createAgentSession,
	createSyntheticSourceInfo,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";

// Or define custom skills inline
// 纯内存构造的"虚拟" skill:filePath/baseDir 不必真实存在,
// createSyntheticSourceInfo 把来源标记为 sdk(而非磁盘发现)
const customSkill: Skill = {
	name: "my-skill",
	description: "Custom project instructions",
	filePath: "/virtual/SKILL.md",
	baseDir: "/virtual",
	sourceInfo: createSyntheticSourceInfo("/virtual/SKILL.md", { source: "sdk" }),
	disableModelInvocation: false,
};

const loader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	// 覆盖钩子:过滤自动发现的 skills,再拼上自定义 skill
	skillsOverride: (current) => {
		const filteredSkills = current.skills.filter((s) => s.name.includes("browser") || s.name.includes("search"));
		return {
			skills: [...filteredSkills, customSkill],
			diagnostics: current.diagnostics,
		};
	},
});
await loader.reload();

// Discover all skills from cwd/.pi/skills, ~/.pi/agent/skills, etc.
// reload() 之后才能读到最终清单;diagnostics 是发现过程中的告警(如格式错误的 SKILL.md)
const { skills: allSkills, diagnostics } = loader.getSkills();
console.log(
	"Discovered skills:",
	allSkills.map((s) => s.name),
);
if (diagnostics.length > 0) {
	console.log("Warnings:", diagnostics);
}

const { session } = await createAgentSession({
	resourceLoader: loader,
	sessionManager: SessionManager.inMemory(),
});
console.log("Session created with filtered skills");
session.dispose();
