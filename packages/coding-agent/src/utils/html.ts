export interface DecodedHtmlEntity {
	text: string;
	length: number;
}

function decodeCodePoint(codePoint: number): string | undefined {
	// Reject non-scalar numeric references before passing them to String.fromCodePoint.
	// 在交给 String.fromCodePoint 前拒绝无效的数字引用范围。
	if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
		return undefined;
	}
	return String.fromCodePoint(codePoint);
}

export function decodeHtmlEntity(entity: string): string | undefined {
	// Support the small named set needed by renderers plus decimal and hexadecimal numeric entities.
	// 支持渲染器所需的少量命名实体，以及十进制和十六进制数字实体。
	switch (entity) {
		case "amp":
			return "&";
		case "lt":
			return "<";
		case "gt":
			return ">";
		case "quot":
			return '"';
		case "apos":
			return "'";
	}

	if (entity.startsWith("#x") || entity.startsWith("#X")) {
		return decodeCodePoint(Number.parseInt(entity.slice(2), 16));
	}

	if (entity.startsWith("#")) {
		return decodeCodePoint(Number.parseInt(entity.slice(1), 10));
	}

	return undefined;
}

export function decodeHtmlEntityAt(html: string, index: number): DecodedHtmlEntity | undefined {
	// Bound the semicolon search so malformed input cannot consume an arbitrarily long suffix as one entity.
	// 限制分号搜索长度，避免把格式错误输入的超长后缀当作单个实体。
	const semicolonIndex = html.indexOf(";", index + 1);
	if (semicolonIndex === -1 || semicolonIndex - index > 16) {
		return undefined;
	}

	const entity = html.slice(index + 1, semicolonIndex);
	// Return both decoded text and source width so callers can advance without reparsing the input.
	// 同时返回解码文本和源码宽度，使调用方无需重新解析即可推进索引。
	const decoded = decodeHtmlEntity(entity);
	if (decoded === undefined) {
		return undefined;
	}

	return { text: decoded, length: semicolonIndex - index + 1 };
}
