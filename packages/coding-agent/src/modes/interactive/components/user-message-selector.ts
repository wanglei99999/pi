import { type Component, Container, getKeybindings, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

interface UserMessageItem {
	id: string; // Entry ID in the session
	// 会话中的条目 ID，用于选择后创建分支。
	text: string; // The message text
	// 用户消息正文，用于单行预览。
	timestamp?: string; // Optional timestamp if available
	// 可选时间戳由上层提供，当前列表不参与渲染。
}

/**
 * Custom user message list component with selection
 */
/** 展示上层已筛选用户消息并支持循环选择的列表；本组件不维护本地搜索状态。 */
class UserMessageList implements Component {
	private messages: UserMessageItem[] = [];
	private selectedIndex: number = 0;
	public onSelect?: (entryId: string) => void;
	public onCancel?: () => void;
	private maxVisible: number = 10; // Max messages visible
	// 视口最多显示十条消息。

	constructor(messages: UserMessageItem[], initialSelectedId?: string) {
		// Store messages in chronological order (oldest to newest)
		// 输入消息保持从旧到新的时间顺序。
		this.messages = messages;
		const initialIndex = initialSelectedId ? messages.findIndex((message) => message.id === initialSelectedId) : -1;
		// Start with selected message if provided, else default to the most recent
		// 优先恢复显式选择，否则默认定位最新一条用户消息。
		this.selectedIndex = initialIndex >= 0 ? initialIndex : Math.max(0, messages.length - 1);
	}

	invalidate(): void {
		// No cached state to invalidate currently
		// 当前没有派生渲染缓存需要失效。
	}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.messages.length === 0) {
			lines.push(theme.fg("muted", "  No user messages found"));
			return lines;
		}

		// Calculate visible range with scrolling
		// 以选中项为中心计算最多十项的垂直窗口，并限制在列表边界内。
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.messages.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.messages.length);

		// Render visible messages (2 lines per message + blank line)
		// 每条可见消息占正文、历史位置和分隔空行三行。
		for (let i = startIndex; i < endIndex; i++) {
			const message = this.messages[i];
			const isSelected = i === this.selectedIndex;

			// Normalize message to single line
			// 预览将多行正文压成单行，避免单条消息占满视口。
			const normalizedMessage = message.text.replace(/\n/g, " ").trim();

			// First line: cursor + message
			// 第一行显示选择光标和按终端宽度截断的消息预览。
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
			const maxMsgWidth = width - 2; // Account for cursor (2 chars)
			// 预留两列给选择光标。
			const truncatedMsg = truncateToWidth(normalizedMessage, maxMsgWidth);
			const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);

			lines.push(messageLine);

			// Second line: metadata (position in history)
			// 第二行显示该消息在完整历史中的位置。
			const position = i + 1;
			const metadata = `  Message ${position} of ${this.messages.length}`;
			const metadataLine = theme.fg("muted", metadata);
			lines.push(metadataLine);
			lines.push(""); // Blank line between messages
			// 消息之间增加空行以提高可读性。
		}

		// Add scroll indicator if needed
		// 窗口未覆盖全部消息时追加当前索引/总数提示。
		if (startIndex > 0 || endIndex < this.messages.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.messages.length})`);
			lines.push(scrollInfo);
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Up arrow - go to previous (older) message, wrap to bottom when at top
		// 向上选择更旧消息，到顶部后循环到最新消息。
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.messages.length - 1 : this.selectedIndex - 1;
		}
		// Down arrow - go to next (newer) message, wrap to top when at bottom
		// 向下选择更新消息，到底部后循环到最旧消息。
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.messages.length - 1 ? 0 : this.selectedIndex + 1;
		}
		// Enter - select message and branch
		// 确认后把所选 entry ID 交给上层创建分支。
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.messages[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.id);
			}
		}
		// Escape - cancel
		// 取消键关闭选择器且不创建分支。
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}
}

/**
 * Component that renders a user message selector for branching
 */
/** 为会话分支操作组合标题、说明和用户消息列表的容器组件。 */
export class UserMessageSelectorComponent extends Container {
	private messageList: UserMessageList;

	constructor(
		messages: UserMessageItem[],
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		initialSelectedId?: string,
	) {
		super();

		// Add header
		// 标题区说明选择将复制到该消息为止的活动路径。
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Fork from Message"), 1, 0));
		this.addChild(
			new Text(
				theme.fg("muted", "Select a user message to copy the active path up to that point into a new session"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Create message list
		// 创建消息列表并连接选择与取消回调。
		this.messageList = new UserMessageList(messages, initialSelectedId);
		this.messageList.onSelect = onSelect;
		this.messageList.onCancel = onCancel;

		this.addChild(this.messageList);

		// Add bottom border
		// 底部边框结束选择器布局。
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		// Auto-cancel if no messages
		// 无可选用户消息时短暂延迟后自动关闭，允许初始空状态先完成挂载。
		if (messages.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	getMessageList(): UserMessageList {
		return this.messageList;
	}
}
