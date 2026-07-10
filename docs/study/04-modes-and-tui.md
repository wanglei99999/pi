# 04 — modes 与 TUI：同一事件流的三个消费者

> 学习系列第 4 篇（全景第 0 篇、agent 第 1 篇、ai 第 2 篇、core 第 3 篇）。第 3 篇止步于 `session.subscribe(listener)` 交出的 AgentSessionEvent 流；本篇讲它的三个消费者——InteractiveMode（TUI）、print-mode（一次性）、RPC（JSON 协议）——以及承载第一个消费者的 `packages/tui` 差分渲染库。读完你应该能回答：终端里一行字是怎么"只重画变化部分"的、一个工具调用从 SSE 增量到屏幕组件走了哪条路、RPC 宿主如何替扩展弹对话框。
>
> 所有 `文件:行号` 基于 commit `3f9aa5d1`。tui 包路径相对 `packages/tui/src/`，modes 路径相对 `packages/coding-agent/src/modes/`。

## 目录

- 第 1 章 地形图：一个 6000 行的巨类和一个 2300 行的编辑器
- 第 2 章 pi-tui 组件模型：`render(width): string[]`，没有别的
- 第 3 章 差分渲染引擎：doRender 走读
- 第 4 章 输入通道：焦点单播、overlay 栈与 IME 光标
- 第 5 章 键绑定：declaration merging 注册表
- 第 6 章 编辑器一瞥：grapheme、paste marker 与 kill ring
- 第 7 章 InteractiveMode 装配：九层组件栈
- 第 8 章 事件→组件管线：handleEvent 走读
- 第 9 章 输入侧：submit 分发与 Escape 语义栈
- 第 10 章 print-mode：159 行的最小消费者
- 第 11 章 RPC 模式：JSONL 协议与扩展 UI 桥
- 第 12 章 不变量、判断与坑

---

## 第 1 章 地形图：一个 6000 行的巨类和一个 2300 行的编辑器

```
─ modes/（18,500 行）
  interactive/interactive-mode.ts   6025  ★ 主类：装配 + 事件管线 + 全部 /命令
  interactive/components/*         ~7600  30 个组件（selector 们占大头）
  interactive/theme/*              ~1470  主题系统
  rpc/{rpc-mode,rpc-client,rpc-types,jsonl}.ts  1726  ★ RPC 协议
  print-mode.ts                      159  ★ 一次性模式

─ packages/tui（12,100 行）
  components/editor.ts              2333  ★ 多行编辑器
  tui.ts                            1714  ★ 差分渲染引擎 + overlay
  keys.ts                           1400  按键解析（legacy + Kitty 协议）
  utils.ts                          1188  ANSI 感知的宽度/切片工具
  components/markdown.ts             858  终端 Markdown 渲染
  autocomplete.ts                    786  自动补全
  terminal.ts / terminal-image.ts   1019  终端抽象 / Kitty 图片协议
  keybindings.ts                     244  ★ 键绑定注册表
  其余组件（text/box/select-list/…）~1500
```

**判断**：第 0 篇"复杂度在边缘"的最后一块拼图。interactive-mode.ts 的 6,025 行里没有难懂的算法——难在它是**所有交互杂事的汇聚点**：30 个 `/命令`、十几个选择器、登录流程、快捷键、剪贴板、信号处理。而 tui 包用一个激进简化的模型（第 2 章）把"终端 UI 框架"压到了 12,000 行——作为对比，成熟的 TUI 框架通常是它的数倍。

---

## 第 2 章 pi-tui 组件模型：`render(width): string[]`，没有别的

整个 UI 框架建立在一个四成员接口上（tui.ts:64-88）：

```typescript
export interface Component {
    render(width: number): string[];   // 给定宽度，返回若干行
    handleInput?(data: string): void;  // 有焦点时收键盘输入
    wantsKeyRelease?: boolean;         // 是否要 Kitty 的按键释放事件
    invalidate(): void;                // 清渲染缓存（换主题时）
}
```

没有布局引擎、没有盒模型、没有 flex——**UI 就是组件从上到下产出的字符串行的拼接**。`Container`（tui.ts:256-290）的 render 只是 concat 子组件的行；`TUI` 类本身 extends Container，根组件树就是一个垂直列表。横向排版是组件自己的事（用 utils.ts 的 ANSI 感知工具：`visibleWidth` 算可见宽度、`truncateToWidth` 截断）。

这个模型有一条**死规矩**：任何组件产出的行的可见宽度不得超过传入的 width。违反会怎样？doRender 里直接 crash——写崩溃日志到 `~/.pi/agent/pi-crash.log`、恢复终端状态、throw 一条指名道姓的错误（tui.ts:1520-1546："This is likely caused by a custom TUI component not truncating its output"）。**判断**：对库作者这是勇敢的选择——宽度溢出若容忍，症状是隔行错位这种极难排查的渲染鬼影；fail-fast 加自述性报错，把调试成本从"几小时盯屏幕"降到"读一行错误信息"。

---

## 第 3 章 差分渲染引擎：doRender 走读

TUI 不用 alternate screen、不用滚动区域，就在正常终端缓冲区里工作（所以聊天历史留在 scrollback 里，可以往上滚）。代价是重画必须自己算。`doRender`（tui.ts:1254-1620）每帧做的事：

1. **全量渲染到内存**：`this.render(width)` 拿到新的完整行数组（组件树每帧都全量执行——便宜，因为只是字符串拼接）；有 overlay 则合成进去（1274-1276）。
2. **与上一帧逐行 diff**（1367-1393）：找 `firstChanged`/`lastChanged`。
3. **无变化** → 只更新 IME 光标位置（1397-1402）。
4. **有变化** → 光标移到首个变化行，`\x1b[2K` 逐行清除重写到最后变化行，整个批次包在**同步输出**协议里（`\x1b[?2026h/l`，1463/1570——支持的终端会把整批更新原子呈现，消灭撕裂）。
5. 行数变少时清掉多余行（1555-1568）；新增行超出视口底部时用 `\r\n` 滚动（1467-1478）。

### 3.1 什么时候放弃差分、全量重绘

差分有个硬边界：**只能触碰还在视口内的行**。滚出屏幕的内容终端已经放进 scrollback，无法回头改。所以 `firstChanged < prevViewportTop` 时只能全量重绘（清屏+清 scrollback+重写一切，1453-1458）。全部触发条件：首帧、宽度变化（换行全变）、高度变化（Termux 例外——软键盘弹出会改高度，全量重绘会把历史重放一遍，1349-1356）、内容收缩且开了 clearOnShrink、变化行在视口上方、Kitty 图片区域越界。`fullRedraws` 计数器（336-338）暴露给测试断言"这个操作不该引起全量重绘"。

### 3.2 节流与强制

`requestRender()`（712-739）合并同帧的多次请求（`renderRequested` 标志 + `process.nextTick`），两帧间隔压到 16ms（MIN_RENDER_INTERVAL_MS，约 60fps）；`requestRender(force)` 清空全部缓存状态强制下一帧全量。第 8 章会看到 handleEvent 里几乎每个分支结尾都是一句 `this.ui.requestRender()`——便宜到可以无脑调。

**判断**：这套引擎的聪明之处在于选对了"不做什么"：不做局部行内 diff（整行重写）、不做组件级脏标记（每帧全量 render）、不做滚动区域优化。字符串拼接和数组比较在 2026 年的机器上快到不值得优化，复杂度全部留给了真正的难点——视口边界和终端方言（Kitty 图片、同步输出、Termux）。

---

## 第 4 章 输入通道：焦点单播、overlay 栈与 IME 光标

输入分发（handleInput，tui.ts:761-835）是一条过滤链：OSC 响应吸收（背景色查询、配色方案上报、单元格尺寸）→ inputListeners（可消费或改写数据，扩展的 `onTerminalInput` 挂在这）→ 全局调试键 shift+ctrl+d → overlay 焦点校正 → **焦点组件独收**。没有事件冒泡：任何时刻恰好一个组件拿输入，Ctrl+C 也交给焦点组件自己决定（825-827 注释）。

overlay（模态弹层）是一个带焦点恢复状态机的栈（324-326）：`showOverlay` 压栈并可选夺焦，关闭时焦点还给之前的组件；overlay 因终端缩小而隐藏时输入自动重定向到最上层可见 overlay（797-808）。各种 selector（模型/会话/树）都是 overlay。

**IME 光标是个值得记的技巧**：终端 UI 通常隐藏硬件光标自己画假光标，但中文输入法的候选窗需要真实光标位置。pi 的方案（tui.ts:98-120）：聚焦组件在渲染输出里嵌一个零宽 APC 转义序列 `CURSOR_MARKER`（`\x1b_pi:c\x07`，终端会忽略它），TUI 在 diff 前扫描并剥离标记、把硬件光标移到标记位置（extractCursorPosition:1234 + positionHardwareCursor:1627）。**组件用"带内信号"声明光标位置，不需要专门的坐标协议**——对 CJK 用户这是刚需功能。

---

## 第 5 章 键绑定：declaration merging 注册表

CLAUDE.md 有条硬规则"永远不要硬编码 `matchesKey(keyData, "ctrl+x")`"，机制在这里：

- tui 包定义 `interface Keybindings`（keybindings.ts:7-42）列出全部**动作 id**（`tui.editor.cursorUp`…），`TUI_KEYBINDINGS`（:54-134）给默认键。
- coding-agent 用 declaration merging 扩展它（core/keybindings.ts:59-61 `declare module "@earendil-works/pi-tui" { interface Keybindings extends AppKeybindings {} }`），注入 `app.*` 动作（escape 中断、ctrl+p 换模型、shift+tab 换思考等级、ctrl+o 展开工具输出……core/keybindings.ts:63+）。
- `KeybindingsManager`（keybindings.ts:155-231）合并用户配置（`~/.pi/agent/keybindings.json`）与默认值，检测冲突；组件代码只写 `keybindings.matches(data, "app.model.select")`。

好处链：动作与键解耦 → 用户可重绑 → `/hotkeys` 帮助和启动提示能从注册表**自动生成**（interactive-mode.ts:757-777 的 keyHint 全部引用动作 id，改了绑定提示自动跟着变）。keys.ts（1,400 行）在底下同时解析 legacy 转义序列和 Kitty 键盘协议——按键释放事件、`ctrl+shift+x` 这类 legacy 协议表达不了的组合，都是 Kitty 协议带来的。

---

## 第 6 章 编辑器一瞥：grapheme、paste marker 与 kill ring

components/editor.ts（2,333 行）是 tui 包最大的文件，值得记三个点：

1. **文本单位是 grapheme 不是 char**：光标移动/删除基于 `Intl.Segmenter` 的字素分段（editor.ts:18-19），emoji、组合字符、CJK 都当一个单位；词导航用 word 粒度分段器。宽度计算全走 `visibleWidth`（CJK 占 2 列）。
2. **大段粘贴折叠成原子标记**：粘贴内容不直接进编辑器，显示为 `[paste #1 +123 lines]` 占位符；`segmentWithMarkers`（:39-91）把标记整体当一个"字素"——光标跳过它、backspace 一次删掉整个、提交时再展开回原文。防止一次粘贴 500 行把编辑器和渲染拖死。
3. **Emacs 血统**：kill ring（ctrl+k/ctrl+y/alt+y）、undo stack、ctrl+a/e、alt+f/b 词移动——默认键位表（第 5 章）基本就是 readline。

---

## 第 7 章 InteractiveMode 装配：九层组件栈

构造函数（interactive-mode.ts:467-514）建组件，`init()`（:698-832）把它们按固定顺序挂上 TUI：

```mermaid
flowchart TD
    subgraph TUI 根容器（从上到下）
        H[headerContainer<br/>logo + 快捷键提示，可折叠]
        LR[loadedResourcesContainer<br/>扩展/skills 加载清单]
        CHAT["chatContainer ★<br/>消息历史（只增）"]
        PM[pendingMessagesContainer<br/>排队中的 steering/followUp]
        ST[statusContainer<br/>Working/Retry/Compaction 指示器]
        WA[widgetContainerAbove<br/>扩展 widget]
        ED["editorContainer ★<br/>输入编辑器（默认持焦点）"]
        WB[widgetContainerBelow<br/>扩展 widget]
        F[footer<br/>模型/token/成本/git 分支]
    end
```

init 的顺序有讲究：先 `ui.start()` 再初始化扩展（:744-746 注释——session_start 处理器可能要弹对话框）；资源清单先于历史消息渲染（:812-816）。启动时还会确保 `fd`/`rg` 二进制可用（缺则下载，:708）。主循环朴素到一行：`while(true) { await session.prompt(await this.getUserInput()) }`（:915-923）——所有复杂性都在事件回调里，主循环只是泵。

chatContainer 是**只增**容器：每条消息一个组件 append 进去，配合第 3 章的差分渲染，"底部追加"恰好是差分最擅长的场景（历史行不变，只画新行）。唯一的整体重建发生在压缩后（`rebuildChatFromMessages`，第 8 章）。

---

## 第 8 章 事件→组件管线：handleEvent 走读

`subscribeToAgent`（:2820-2824）把 AgentSessionEvent 流接进 `handleEvent`（:2826-3123）——这是第 1 篇事件协议 + 第 3 篇会话事件在 UI 侧的完整消费者。核心对象两个：

- `streamingComponent`：当前流式中的 `AssistantMessageComponent`；
- `pendingTools: Map<toolCallId, ToolExecutionComponent>`：执行中的工具组件。

管线按事件走：

| 事件 | 动作 |
|---|---|
| `message_start`(assistant) | 建 AssistantMessageComponent 挂进 chat（:2890-2902） |
| `message_update` | `updateContent(partial)` 整体重灌内容（markdown 重渲染）；发现新 toolCall 块就**提前**建 ToolExecutionComponent（:2905-2937）——此时参数还在流式，靠第 2 篇 9.2 节的 parseStreamingJson 已能渲染部分参数 |
| `message_end` | 定稿内容；stopReason 异常时把所有 pendingTools 标成错误结果；正常时对工具组件调 `setArgsComplete()`（:2967-2970）——edit 工具的 diff 预览（第 3 篇 8.1 节）就是这一刻触发的 |
| `tool_execution_start/update/end` | 找到（或补建）组件 → markExecutionStarted / 流式部分结果 / 最终结果并从 map 移除（:2980-3021） |
| `agent_end` | 清 working 指示器；异常残留的 streamingComponent 从 chat 移除（:3028-3032） |
| `compaction_start/end` | 换 Escape 手柄为"取消压缩"，结束后还原；成功则 **chatContainer.clear() + rebuildChatFromMessages()**（:3072-3073，唯一的全量重建点）再挂压缩摘要组件 |
| `auto_retry_start/end` | 换 Escape 手柄为"取消重试"，状态条显示第几次/退避多久；只有最终失败才报错（:3115-3118，中途错误不打扰——第 3 篇 willRetry 标志的用武之地） |

**判断**：这条管线的健壮性来自"组件按 toolCallId 寻址、找不到就补建"（:2981-2998）——事件乱序或丢失（比如恢复会话时没有 message_update 阶段）不会崩，最多晚建组件。与第 1 篇 11.1 节"事件序列永远完整合法"的引擎侧保证互为攻守。

另一个细节：AssistantMessageComponent 会在纯文本消息的首尾行嵌 OSC 133 语义区标记（assistant-message.ts:5-7、74-80）——支持的终端（WezTerm/Kitty）可以按"提示符/输出"语义跳转、选取整段回复。

---

## 第 9 章 输入侧：submit 分发与 Escape 语义栈

### 9.1 onSubmit 的分发顺序（:2631-2818）

约 30 个内置 `/命令`（/settings、/model、/tree、/login、/resume……）在这里逐个 `if` 匹配——**内置命令住在 UI 层，不在 core**。然后依次：`!`/`!!` bash 命令（执行中则警告）；**压缩中** → 非扩展命令进 `compactionQueuedMessages` 队列（压缩完 flush，:4005）；**流式中** → `session.prompt(text, {streamingBehavior:"steer"})` 走第 3 篇 4.1 节的六道关卡；空闲 → 交给 `getUserInput()` 的等待者（主循环）。

**判断**：内置命令在 interactive 层实现意味着 print/RPC 模式天然没有它们——RPC 的 `get_commands` 只返回扩展/模板/skill 命令（rpc-types.ts:79-88），宿主要自己实现"设置界面"这类功能。这是刻意的：这些命令本质是 TUI 选择器的入口，headless 场景语义不成立。副作用是想加"三个模式都可用的命令"时必须走扩展机制而不是这张 if 表。

### 9.2 Escape 是个语义栈

同一个 Esc 键，含义按状态分层（onEscape，:2546-2572）：流式中 → abort 并把排队消息**放回编辑器**；bash 运行中 → 杀 bash；bash 模式（编辑器以 `!` 开头）→ 清空退出；编辑器空 → 500ms 内按两下打开 /tree 或 /fork（可配置）。压缩和重试期间，onEscape 被**临时换成**"取消压缩/取消重试"，结束事件里还原（第 8 章表格）——手柄换手配对出现，agent_start 里还有一个防泄漏的补还原（:2839-2844）。

---

## 第 10 章 print-mode：159 行的最小消费者

print-mode.ts 整个文件就是"订阅事件流 + 喂 prompt + 输出"：`--mode json` 把每个 AgentSessionEvent 原样 JSON.stringify 到 stdout（:104-108，首行输出会话 header）；`-p` 文本模式只在结束后取最后一条 assistant 消息的 text 块（:129-146），stopReason 为 error/aborted 时 stderr 报错并 exit 1。它同样要 bindExtensions（:73-101）——扩展的会话控制动作（newSession/fork/navigateTree）在 headless 下照常工作，只是 UI 上下文全是空实现。**判断**：这个文件是"三模式共享 AgentSession"架构含金量的最好证明——一次性 CLI 只花 159 行，且扩展、压缩、重试全部照常。

---

## 第 11 章 RPC 模式：JSONL 协议与扩展 UI 桥

rpc-mode.ts（795 行）面向嵌入宿主（IDE 插件、其他 agent）：stdin 每行一个 JSON 命令，stdout 混流三种输出——命令响应（`type:"response"` + 可选 `id` 关联）、原样转发的 AgentSessionEvent、扩展 UI 请求。

协议面（rpc-types.ts:20-72）就是 AgentSession 公开方法的镜像：prompt/steer/follow_up/abort、get_state、set_model/cycle_model、compact、bash、get_tree/fork/switch_session……**AgentSession 有什么，RPC 就暴露什么**，这也是为什么第 3 篇说 AgentSession 的方法集是最稳定的 API。

最有意思的是**扩展 UI 桥**（rpc-mode.ts:90-130）：扩展调 `ctx.ui.select(...)` 时，RPC 模式的 ExtensionUIContext 实现不弹 TUI，而是输出一条 `extension_ui_request`（带 uuid），把 promise 挂在 `pendingExtensionRequests` 表里等宿主回一条 `extension_ui_response`；支持超时和 AbortSignal，超时/取消时以**默认值**（select→undefined、confirm→false）resolve 而不是 reject——扩展代码对"宿主没实现对话框"零感知。做不到的能力（working 动画、原始终端输入）实现为显式空操作并注释原因（:162-192）。

**判断**：`ExtensionUIContext` 接口是三模式架构真正的接缝——同一个扩展，在 interactive 下得到 TUI 弹窗（interactive-mode.ts:2132-2519 的实现）、在 RPC 下得到协议转发、在 print 下得到静默默认值。扩展作者面向一个接口写 UI，模式差异被三份实现吸收。第 5 篇讲扩展系统时这是重要背景。

---

## 第 12 章 不变量、判断与坑

### 12.1 系统不变量

1. **组件产出的行宽 ≤ 传入 width**：违反即 crash（第 2 章）。自定义组件必须用 `visibleWidth`/`truncateToWidth`。
2. **差分只能触碰视口内**：变化落到 scrollback 就全量重绘（第 3.1 节）——设计组件时避免"改历史行"（比如已完成消息不要再变内容），否则触发全量重绘闪屏。
3. **输入单播给焦点组件**，无冒泡；overlay 栈管理焦点借还。
4. **键绑定只经注册表**：新键位加进 KEYBINDINGS 表，不写 matchesKey 字面量。
5. **Escape 手柄换手必须配对还原**（9.2 节），异常路径靠 agent_start 兜底。

### 12.2 值得抄走的设计

- **`render(width): string[]` 极简组件契约**（第 2 章）：够用就好，终端 UI 不需要 DOM。
- **CURSOR_MARKER 带内光标信号**（第 4 章）：零宽转义序列做位置标记，免坐标协议。
- **动作注册表 + declaration merging**（第 5 章）：帮助文本自动生成，重绑定免费获得。
- **paste marker 原子分段**（第 6 章）：大粘贴的 UX 与性能双解。
- **扩展 UI 的三态实现**（第 11 章）：接口一份、实现按模式三份、缺能力用带默认值的空操作。

### 12.3 坑（下游开发者视角）

- **每帧全量 render 组件树**：组件 render 里别做昂贵计算（markdown 组件内部有缓存，自定义组件要自己缓存），invalidate() 才是清缓存的时机。
- **message_update 整体重灌内容**：流式期间每个 delta 都触发 markdown 重渲染，长回复的性能瓶颈在这里，不在差分引擎。
- **内置 /命令 不进 RPC**（9.1 节）：嵌入宿主别指望 `prompt("/model")` 有反应，用 `set_model` 命令。
- **Termux 高度变化不全量重绘**（3.1 节）：依赖高度触发重绘的组件在安卓上行为不同。
- **PI_DEBUG_REDRAW=1 / PI_TUI_DEBUG=1**：排查闪屏/错位的两个开关，日志在 `~/.pi/agent/pi-debug.log` 和 `/tmp/tui/`。

### 12.4 与下一篇的接口

本篇多次撞到扩展系统的边界：extensionRunnerRef 的钩子（第 3 篇 2.3 节）、ExtensionUIContext 的三态实现（第 11 章）、扩展 widget/自定义 footer/header 容器（第 7 章）、`session_before_compact`/`session_before_tree` 这类能改写核心行为的钩子。下一篇 `05-extensions.md` 进入扩展系统本体：ExtensionRunner 的事件分发（extensions/runner.ts）、loader 的模块加载（jiti）、ToolDefinition/命令/资源的注册协议，以 plan-mode 和 gondolin 两个官方扩展作案例走读。

---

*基于 commit 3f9aa5d1。Component/Focusable 接口与键绑定注册表是 tui 包的对外承诺，稳定；interactive-mode.ts 是全仓改动最频繁的文件之一（新功能大多要在这里挂 UI），行号漂移预期最快，读时以方法名定位为主。*
