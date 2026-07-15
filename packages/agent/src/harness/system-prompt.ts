import type { Skill } from "./types.ts";

export function formatSkillsForSystemPrompt(skills: Skill[]): string {
	// Only model-invocable skills enter this fragment; hidden skills remain outside the model-visible prompt.
	// 只有允许模型调用的 skills 会进入此片段；隐藏 skills 不会出现在模型可见提示中。
	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
	// Return an empty fragment so the caller can omit the entire skills section without extra separators.
	// 没有可见 skill 时返回空片段，使调用方可省略整个 skills section 而不引入额外分隔符。
	if (visibleSkills.length === 0) return "";

	// Fixed usage guidance precedes structured metadata, keeping interpretation rules before the skill catalog.
	// 固定使用说明位于结构化 metadata 之前，使解释规则先于 skill catalog 出现。
	const lines = [
		"The following skills provide specialized instructions for specific tasks.",
		"Read the full skill file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		// Preserve caller order and duplicates; this formatter does not impose ranking or deduplication policy.
		// 保留调用方顺序及重复项；此 formatter 不负责排序或去重策略。
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");
	// This function emits only the skills fragment; tool schemas and runtime context are composed elsewhere.
	// 此函数仅生成 skills 片段；tool schemas 与 runtime context 由其他组合层注入。
	return lines.join("\n");
}

function escapeXml(value: string): string {
	// Escape every dynamic field so skill metadata cannot terminate or reshape the trusted XML-like structure.
	// 转义所有动态字段，避免 skill metadata 终止或重塑受信任的 XML-like 结构。
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
