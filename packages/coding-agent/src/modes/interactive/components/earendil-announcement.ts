import * as fs from "node:fs";
import { Container, Image, Spacer, Text } from "@earendil-works/pi-tui";
import { getBundledInteractiveAssetPath } from "../../../config.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const BLOG_URL = "https://mariozechner.at/posts/2026-04-08-ive-sold-out/";
const IMAGE_FILENAME = "clankolas.png";

let cachedImageBase64: string | undefined;
let attemptedImageLoad = false;
// Cache both success and failure at module scope so repeated component construction never repeats synchronous asset I/O.
// 在模块级缓存成功或失败结果，使重复创建组件时不会再次执行同步资源 I/O。

function loadImageBase64(): string | undefined {
	// A missing or unreadable optional image degrades to a text-only announcement without surfacing an error.
	// 可选图片缺失或不可读时静默降级为纯文本公告，不向用户暴露错误。
	if (attemptedImageLoad) {
		return cachedImageBase64;
	}

	attemptedImageLoad = true;
	try {
		cachedImageBase64 = fs.readFileSync(getBundledInteractiveAssetPath(IMAGE_FILENAME)).toString("base64");
	} catch {
		cachedImageBase64 = undefined;
	}
	return cachedImageBase64;
}

export class EarendilAnnouncementComponent extends Container {
	constructor() {
		// The component renders one static announcement; deciding whether it is shown only once belongs to the caller.
		// 组件只渲染单个静态公告；是否仅展示一次由调用方决定。
		super();

		// DynamicBorder follows the current viewport width while the injected color keeps it aligned with the announcement accent.
		// DynamicBorder 跟随当前视口宽度，注入的 color 则使其与公告 accent 保持一致。
		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		// Text styles are captured from the active theme at construction; the announcement does not manage theme switching itself.
		// 文本样式在构造时从当前 theme 获取；公告组件本身不管理主题切换。
		this.addChild(new Text(theme.bold(theme.fg("accent", "pi has joined Earendil")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "Read the blog post:"), 1, 0));
		this.addChild(new Text(theme.fg("mdLink", BLOG_URL), 1, 0));
		this.addChild(new Spacer(1));

		const imageBase64 = loadImageBase64();
		if (imageBase64) {
			// Image owns terminal-protocol detection and fallback rendering; the announcement only caps its visual width.
			// Image 负责终端协议探测和降级渲染；公告组件只限制其视觉宽度。
			this.addChild(
				new Image(
					imageBase64,
					"image/png",
					{ fallbackColor: (text) => theme.fg("muted", text) },
					{ maxWidthCells: 56, filename: IMAGE_FILENAME },
				),
			);
			this.addChild(new Spacer(1));
		}

		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		// No mutable display state is retained after construction; recreate the component to change its content or text theme snapshot.
		// 构造完成后不保留可变显示状态；如需改变内容或文本主题快照，应重新创建组件。
	}
}
