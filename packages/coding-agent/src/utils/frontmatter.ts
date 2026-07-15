import { parse } from "yaml";

type ParsedFrontmatter<T extends Record<string, unknown>> = {
	frontmatter: T;
	body: string;
};

const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const extractFrontmatter = (content: string): { yamlString: string | null; body: string } => {
	// Normalize line endings before locating delimiters so YAML boundaries behave consistently across platforms.
	// 定位分隔符前先统一换行符，使 YAML 边界在不同平台上具有一致行为。
	const normalized = normalizeNewlines(content);

	// Missing or unterminated frontmatter is treated as ordinary document content rather than a partial metadata block.
	// 缺少起始或结束分隔符时，将内容视为普通文档，而不是不完整的元数据块。
	if (!normalized.startsWith("---")) {
		return { yamlString: null, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { yamlString: null, body: normalized };
	}

	return {
		yamlString: normalized.slice(4, endIndex),
		// Only documents with a complete boundary have surrounding body whitespace removed.
		// 仅当文档具有完整边界时，才移除正文首尾空白。
		body: normalized.slice(endIndex + 4).trim(),
	};
};

export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> => {
	const { yamlString, body } = extractFrontmatter(content);
	if (!yamlString) {
		return { frontmatter: {} as T, body };
	}
	// YAML syntax errors intentionally propagate to the caller; a null parse result maps to an empty metadata object.
	// YAML 语法错误会原样抛给调用方；解析结果为 null 时则映射为空元数据对象。
	const parsed = parse(yamlString);
	return { frontmatter: (parsed ?? {}) as T, body };
};

// Stripping shares the exact parsing and normalization semantics above, returning only the resulting document body.
// 移除 frontmatter 时复用上述解析和换行规范化语义，仅返回最终正文。
export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body;
