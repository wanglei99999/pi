import type { ProviderEnv } from "../types.ts";
import { getProviderEnvValue } from "./provider-env.ts";

const DEFAULT_PROXY_PORTS: Record<string, number> = {
	ftp: 21,
	gopher: 70,
	http: 80,
	https: 443,
	ws: 80,
	wss: 443,
};

function getProxyEnv(key: string, env?: ProviderEnv): string {
	// Scoped provider environment takes precedence, while lowercase variables win over uppercase aliases.
	// 提供商作用域环境优先，并且小写变量优先于对应的大写别名。
	const lowercaseKey = key.toLowerCase();
	const uppercaseKey = key.toUpperCase();
	return (
		env?.[lowercaseKey] ||
		env?.[uppercaseKey] ||
		getProviderEnvValue(lowercaseKey) ||
		getProviderEnvValue(uppercaseKey) ||
		""
	);
}

function parseProxyTargetUrl(targetUrl: string | URL): URL | undefined {
	// Invalid target strings mean “no proxy decision” rather than a configuration failure.
	// 无效目标字符串表示“无法决定代理”，而不是代理配置错误。
	if (targetUrl instanceof URL) {
		return targetUrl;
	}

	try {
		return new URL(targetUrl);
	} catch {
		return undefined;
	}
}

function shouldProxyHostname(hostname: string, port: number, env?: ProviderEnv): boolean {
	// Apply NO_PROXY entries as exclusions; every non-matching entry keeps the target proxyable.
	// 将 NO_PROXY 条目视为排除规则；只有全部条目都不匹配时目标才使用代理。
	const noProxy = getProxyEnv("no_proxy", env).toLowerCase();
	if (!noProxy) {
		return true;
	}
	if (noProxy === "*") {
		return false;
	}

	return noProxy.split(/[,\s]/).every((proxy) => {
		if (!proxy) {
			return true;
		}

		const parsedProxy = proxy.match(/^(.+):(\d+)$/);
		let proxyHostname = parsedProxy ? parsedProxy[1] : proxy;
		const proxyPort = parsedProxy ? Number.parseInt(parsedProxy[2]!, 10) : 0;
		if (proxyPort && proxyPort !== port) {
			return true;
		}

		if (!/^[.*]/.test(proxyHostname)) {
			// Bare names match exactly, while dotted or wildcard entries match hostname suffixes.
			// 裸主机名执行精确匹配，以点或通配符开头的条目执行后缀匹配。
			return hostname !== proxyHostname;
		}

		if (proxyHostname.startsWith("*")) {
			proxyHostname = proxyHostname.slice(1);
		}
		return !hostname.endsWith(proxyHostname);
	});
}

function getProxyForUrl(targetUrl: string | URL, env?: ProviderEnv): string {
	const parsedUrl = parseProxyTargetUrl(targetUrl);
	if (!parsedUrl?.protocol || !parsedUrl.host) {
		return "";
	}

	const protocol = parsedUrl.protocol.split(":", 1)[0]!;
	const hostname = parsedUrl.host.replace(/:\d*$/, "");
	const port = Number.parseInt(parsedUrl.port, 10) || DEFAULT_PROXY_PORTS[protocol] || 0;
	if (!shouldProxyHostname(hostname, port, env)) {
		return "";
	}

	let proxy = getProxyEnv(`${protocol}_proxy`, env) || getProxyEnv("all_proxy", env);
	// Scheme-less proxy values inherit the target protocol for compatibility with common environment formats.
	// 无 scheme 的代理值继承目标协议，以兼容常见环境变量格式。
	if (proxy && !proxy.includes("://")) {
		proxy = `${protocol}://${proxy}`;
	}
	return proxy;
}

export const UNSUPPORTED_PROXY_PROTOCOL_MESSAGE =
	"Unsupported proxy protocol. SOCKS and PAC proxy URLs are not supported; use an HTTP or HTTPS proxy URL.";

export function resolveHttpProxyUrlForTarget(targetUrl: string | URL, env?: ProviderEnv): URL | undefined {
	// Absence and exclusion return undefined; malformed or unsupported configured proxies remain actionable errors.
	// 未配置或被排除时返回 undefined；格式错误或协议不支持的代理配置仍作为可操作错误抛出。
	const proxy = getProxyForUrl(targetUrl, env);
	if (!proxy) {
		return undefined;
	}

	let proxyUrl: URL;
	try {
		proxyUrl = new URL(proxy);
	} catch (error) {
		throw new Error(
			`Invalid proxy URL ${JSON.stringify(proxy)}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
		throw new Error(`${UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got ${proxyUrl.protocol}`);
	}

	return proxyUrl;
}
