// Core TUI interfaces and classes
// 本文件是 TUI 包的公共入口；消费者应从这里使用稳定组件、终端抽象和渲染工具。

// Autocomplete support
export {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "./autocomplete.ts";
// Components
export { Box } from "./components/box.ts";
export { CancellableLoader } from "./components/cancellable-loader.ts";
export { Editor, type EditorOptions, type EditorTheme } from "./components/editor.ts";
export { Image, type ImageOptions, type ImageTheme } from "./components/image.ts";
export { Input } from "./components/input.ts";
export { Loader, type LoaderIndicatorOptions } from "./components/loader.ts";
export { type DefaultTextStyle, Markdown, type MarkdownOptions, type MarkdownTheme } from "./components/markdown.ts";
export {
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	type SelectListTruncatePrimaryContext,
} from "./components/select-list.ts";
export { type SettingItem, SettingsList, type SettingsListTheme } from "./components/settings-list.ts";
export { Spacer } from "./components/spacer.ts";
export { Text } from "./components/text.ts";
export { TruncatedText } from "./components/truncated-text.ts";
// Editor component interface (for custom editors)
// 自定义编辑器只需实现该接口，即可接入与内置 Editor 相同的渲染、输入和提交流程。
export type { EditorComponent } from "./editor-component.ts";
// Fuzzy matching
export { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "./fuzzy.ts";
// Keybindings
// 同时公开声明、冲突检测和全局 get/set 入口，使应用可替换默认键位而不硬编码按键判断。
export {
	getKeybindings,
	type Keybinding,
	type KeybindingConflict,
	type KeybindingDefinition,
	type KeybindingDefinitions,
	type Keybindings,
	type KeybindingsConfig,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "./keybindings.ts";
// Keyboard input handling
// 键盘层统一解析传统终端序列与 Kitty protocol，并显式区分 press/repeat/release 事件。
export {
	decodeKittyPrintable,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	Key,
	type KeyEventType,
	type KeyId,
	matchesKey,
	parseKey,
	setKittyProtocolActive,
} from "./keys.ts";
// Input buffering for batch splitting
// StdinBuffer 把一次读取中的粘贴/批量输入与独立按键拆分，避免上层组件自行处理字节边界。
export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "./stdin-buffer.ts";
// Terminal interface and implementations
// Terminal 接口隔离 TUI 调度与 process I/O，ProcessTerminal 提供默认真实终端实现。
export { ProcessTerminal, type Terminal } from "./terminal.ts";
// Terminal colors
export {
	parseOsc11BackgroundColor,
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
} from "./terminal-colors.ts";
// Terminal image support
// 图片入口涵盖能力探测、协议编码、尺寸读取和缓存控制；调用方可在不支持时统一降级。
export {
	allocateImageId,
	type CellDimensions,
	calculateImageRows,
	deleteAllKittyImages,
	deleteKittyImage,
	detectCapabilities,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getPngDimensions,
	getWebpDimensions,
	hyperlink,
	type ImageDimensions,
	type ImageProtocol,
	type ImageRenderOptions,
	imageFallback,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
	type TerminalCapabilities,
} from "./terminal-image.ts";
export {
	type Component,
	Container,
	CURSOR_MARKER,
	type Focusable,
	isFocusable,
	type OverlayAnchor,
	type OverlayHandle,
	type OverlayMargin,
	type OverlayOptions,
	type OverlayUnfocusOptions,
	type SizeValue,
	TUI,
} from "./tui.ts";
// Utilities
// 这些工具按终端可见列处理 ANSI 文本，避免使用字符串长度造成截断和换行偏差。
export { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./utils.ts";
