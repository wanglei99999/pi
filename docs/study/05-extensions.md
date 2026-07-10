# 05 — 扩展系统：ExtensionRunner、loader 与两个官方案例

> 学习系列第 5 篇（全景 00、agent 01、ai 02、core 03、modes/tui 04）。前四篇反复撞到扩展系统的边界：sdk.ts 的 extensionRunnerRef（03 篇 2.3 节）、Agent 钩子转发（03 篇 3.1 节）、ExtensionUIContext 三态实现（04 篇 11 章）、`session_before_compact/tree` 改写核心行为的钩子（03 篇 6/5.4 节）。本篇进入本体：扩展怎么被加载、事件怎么分发、注册协议长什么样，最后用 plan-mode 和 gondolin 两个官方示例走一遍全生命周期。
>
> 所有 `文件:行号` 基于 commit `3f9aa5d1`。除特别注明外，路径相对 `packages/coding-agent/src/core/extensions/`；案例相对 `packages/coding-agent/examples/extensions/`。

## 目录

- 第 1 章 地形图与设计动机
- 第 2 章 扩展的形态：工厂函数与两阶段 API
- 第 3 章 loader：jiti、虚拟模块与发现规则
- 第 4 章 运行时对象与 stale 保护
- 第 5 章 ExtensionRunner 的分发语义学
- 第 6 章 事件目录：三十来种钩子的分类地图
- 第 7 章 上下文对象：懒 getter 的防御术
- 第 8 章 快捷键：保留键与冲突仲裁
- 第 9 章 案例一 plan-mode：状态机、拦截与持久化
- 第 10 章 案例二 gondolin：Operations 注入的全景应用
- 第 11 章 不变量、判断与坑

---

## 第 1 章 地形图与设计动机

扩展系统本体只有四个文件：

```
types.ts    1666   事件/API/ToolDefinition 的全部契约（一半是文档注释）
runner.ts   1179   ★ ExtensionRunner：事件分发 + 上下文构造
loader.ts    699   ★ jiti 加载、发现规则、ExtensionAPI 构造
wrapper.ts    30   注册工具 → AgentTool 的薄适配
```

设计动机写在 CONTRIBUTING.md 里：**"pi's core stays minimal——能放扩展里的功能就该是扩展"**。前几篇看到的可扩展点由此串成一条完整的插件面：事件钩子（本篇主角）、自定义工具（03 篇 8.1 节的 ToolDefinition）、斜杠命令、快捷键、CLI flag、消息/条目渲染器、自定义 provider（02 篇的注册表）、资源注入（skills/prompts/themes）。examples/extensions/ 下有 50+ 个示例，从 30 行的 hello.ts 到 1000 行的 subagent。

---

## 第 2 章 扩展的形态：工厂函数与两阶段 API

一个扩展 = **默认导出一个工厂函数**：

```typescript
export default function myExtension(pi: ExtensionAPI): void {
    pi.registerCommand("hello", { handler: async (_args, ctx) => ctx.ui.notify("hi") });
    pi.on("tool_call", async (event, ctx) => { /* ... */ });
}
```

关键设计：`ExtensionAPI`（loader.ts:213-371）的方法分两类，**生效时机不同**——

- **注册类**（`on`/`registerTool`/`registerCommand`/`registerShortcut`/`registerFlag`/`register*Renderer`）：写入 Extension 对象的各个 Map（loader.ts:221-277），在工厂函数执行期（加载期）调用；
- **动作类**（`sendMessage`/`setActiveTools`/`setModel`/`appendEntry`…）：委托给共享的 `ExtensionRuntime`（loader.ts:287-355），而加载期的 runtime 全是 **throwing stubs**（"Extension runtime not initialized"，loader.ts:160-206）——真实现要等 AgentSession 的 `bindCore` 注入（03 篇 3.1 节看到的绑定点，agent-session.ts:2304-2394）。

**判断**：这个两阶段结构把"声明"与"行动"在时间上强制分离——工厂函数只能注册不能行动，行动只能发生在事件处理器里（那时 runtime 已绑定）。它不是文档约定而是运行时强制，扩展作者想在加载期发消息会立刻收到明确报错。唯一的豁免是 `registerProvider`：加载期调用进 `pendingProviderRegistrations` 队列，bindCore 时统一 flush（loader.ts:196-202）——因为自定义 provider 必须在首次模型解析前就位。

---

## 第 3 章 loader：jiti、虚拟模块与发现规则

### 3.1 jiti 双轨加载（loader.ts:381-406）

扩展是用户机器上的 TS/JS 文件，pi 用 [jiti] 在运行时直接加载 TypeScript（`moduleCache: false`——`/reload` 能拿到新代码）。难点是扩展会 `import "@earendil-works/pi-tui"` 这类包，而 pi 有两种发行形态：

- **Bun 单文件二进制**：文件系统里没有 node_modules。解法是 `virtualModules`（loader.ts:46-68）：loader 顶部**静态 import** 全部可被扩展依赖的包（:10-25，注释强调 MUST be static 才能被 Bun 打进二进制），加载扩展时把这些模块对象按名字直接喂给 jiti。
- **npm/源码运行**：用 `alias` 把包名映射到 workspace 的 dist 或 node_modules 实际路径（:78-128）。

两条轨都保留 `@mariozechner/*` 旧包名别名（改名前的历史兼容），且把 `@earendil-works/pi-ai` 根入口指向 **compat**（:55-59 注释点名：compat 是核心入口的严格超集，旧扩展的全局 API 继续工作直到 compat 删除）——第 2 篇双世界故事在扩展面的延伸。

### 3.2 发现规则（loader.ts:604-698）

三个来源按序去重合并：项目 `<cwd>/.pi/extensions/` → 全局 `~/.pi/agent/extensions/` → settings/CLI 显式路径。目录内的识别规则刻意简单（:604-613 注释）：顶层 `*.ts|*.js` 直接算；子目录看 `index.ts` 或 `package.json` 的 `pi.extensions` 清单字段；**不做深递归**——复杂包必须用 manifest 声明。加载失败不炸启动，进 errors 数组由 UI 展示（loader.ts:495-512）。

---

## 第 4 章 运行时对象与 stale 保护

第 3 篇 3.1 节留了个伏笔：`dispose()` 会调 `extensionRunner.invalidate(...)` 并附一大段错误文案。机制在这里闭环：

- Runtime 与 Runner 各有一个 `staleMessage`/`assertActive`（loader.ts:164-169、runner.ts:513-526）；
- 会话被替换（`/new`、fork、switchSession）或 `/reload` 后，旧 runner 被 invalidate；
- ExtensionAPI 的**每个**方法、ExtensionContext 的**每个** getter 都先 `assertActive()`——扩展若捕获了旧 ctx 并在替换后使用，会收到一段指导性极强的报错（"move post-replacement work into withSession…"）。

**判断**：这是对"插件作者最常犯的错"的运行时教学。会话替换后旧闭包里的 sessionManager/ui 指向已死对象，静默使用会产生极诡异的 bug（写进旧会话文件、渲染到已卸载的组件）；用带迁移指南的 throw 把事故变成教程，是扩展系统里性价比最高的 50 行。

---

## 第 5 章 ExtensionRunner 的分发语义学

Runner 的分发不是一个 emit 打天下，而是**按事件的合成语义分成五种**，这是本篇最值得精读的部分：

| 语义 | 方法 | 规则 |
|---|---|---|
| 广播 + cancel 短路 | `emit`（runner.ts:749-781） | 顺序调用全部 handler，错误隔离（emitError 不中断）；仅 `session_before_*` 四事件的返回值有意义：`cancel` 立即短路返回 |
| 链式改写 | `emitMessageEnd`（:783-823）、`emitToolResult`（:825-873）、`emitInput`（:1139-1178）、`emitBeforeProviderRequest/Headers`、`emitContext` | 每个 handler 收到**上一个 handler 改写后**的值，输出继续往下传；message_end 有角色守卫（:798-805，换 role 直接拒收） |
| 累积 + 链式混合 | `emitBeforeAgentStart`（:1024-1088） | 注入消息是**累积**的（每个扩展都能加），系统提示词是**链式**的（后者收到前者改写的版本，ctx.getSystemPrompt 动态反映当前值 :1035-1038） |
| 阻断优先 | `emitToolCall`（:875-896） | 任何 handler 返回 `block: true` 立即短路；**没有 try/catch** |
| 首个决定胜出 | `emitProjectTrustEvent`（:200-230） | 返回 `undecided` 落空继续问下一个，首个 yes/no 定案 |

emitToolCall 不吞异常是刻意的：调用方 agent-session.ts:430-442 捕获后重新 throw 成 "Extension failed, blocking execution"——**安全钩子必须 fail-closed**。一个 confirm-destructive 类扩展如果自己崩了，工具调用被阻断而不是放行。对比其余事件的 fail-open（handler 崩了记错误、流程继续）：观察类钩子的故障不应该拖垮会话。**判断**：同一个系统里按钩子性质选择 fail-open/fail-closed，比一刀切的"插件异常全部隔离"成熟得多。

顺序细节：handler 按**扩展加载顺序 × 注册顺序**执行，没有优先级机制。链式改写因此对顺序敏感——文档没有承诺顺序稳定性，写互相冲突的改写扩展要自己协调（`pi.events` 事件总线，loader.ts:367，是官方给的跨扩展通信通道）。

---

## 第 6 章 事件目录：三十来种钩子的分类地图

types.ts:505-830 定义了全部事件，按类别记忆比背列表有效：

- **生命周期**：`session_start`（reason: startup/reload）、`session_shutdown`、`project_trust`（11 章的信任决策代答点）、`resources_discover`（动态注入 skills/prompts/themes 路径，结果被 resource-loader 合并，03 篇 agent-session.ts:2201-2224）；
- **会话操作的 before/after 对**：`session_before_switch/fork/compact/tree` + `session_compact/tree/info_changed`——before 系可 cancel 或**接管实现**（自定义压缩：返回 compaction 对象顶替内置算法，03 篇 6 章）；
- **agent 循环转发**（03 篇 3.1 节的映射产物）：`agent_start/end/settled`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end`；
- **改写点**：`input`（用户输入拦截/改写）、`before_agent_start`（注入上下文消息 + 改系统提示词）、`context`（每次 LLM 调用前的消息数组裁剪——挂在 Agent 的 transformContext 上）、`tool_call`/`tool_result`（工具前后拦截）、`user_bash`（! 命令换执行后端）；
- **provider 面**：`before_provider_request`（改请求体 payload——02 篇 onPayload 的来源）、`before_provider_headers`、`after_provider_response`；
- **选择器**：`model_select`、`thinking_level_select`。

`tool_call` 还有按工具名细分的类型（BashToolCallEvent/EditToolCallEvent…，types.ts:844+），handler 里可以类型安全地窄化 input。

---

## 第 7 章 上下文对象：懒 getter 的防御术

每次分发都新建 `ExtensionContext`（createContext，runner.ts:630-699）：`ui`/`mode`/`cwd`/`sessionManager`/`model` 全是 **getter**，取值时才读 runner 的当前字段——bindCore/setUIContext 后来改了绑定，已发出的 ctx 自动反映新值。`createCommandContext`（:701-738）在其上加会话控制方法（newSession/fork/navigateTree/switchSession/reload/waitForIdle），扩展命令因此能做"接管会话"级别的事（04 篇 RPC/print 模式的 commandContextActions 就是这些方法的模式侧实现）。

一个精细的 JS 技巧值得记：扩展 ctx 用 `Object.defineProperties(({}), Object.getOwnPropertyDescriptors(this.createContext()))` 复制（:705-708 注释），而不是 `{...ctx}`——**spread 会立刻执行所有 getter**，把当时的值冻结成普通属性，stale 检查和动态绑定就全失效了；复制属性描述符才能保住 getter 的惰性。（JS 新手注：见第 0 篇 A.3/A.7；这是"getter 不是值"的典型陷阱。）

---

## 第 8 章 快捷键：保留键与冲突仲裁

扩展可 `registerShortcut(Key.ctrlAlt("p"), …)`。冲突仲裁在 `getShortcuts`（runner.ts:464-509）：先用**解析后的**键绑定配置（用户改绑过的算改绑后的键）建内置键表（buildBuiltinKeybindings :91-110），`RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS`（:69-87，escape/ctrl+c/ctrl+d/submit 等 17 个编辑器全局动作）标记为不可覆盖——扩展抢保留键会被拒绝并生成诊断（`/reload` 后 UI 可见）；非保留的内置键允许覆盖。同键多动作时保留动作优先胜出（:99-102 注释）。

---

## 第 9 章 案例一 plan-mode：状态机、拦截与持久化

plan-mode/index.ts（390 行）是"纯钩子扩展"的教科书——不换执行后端，只用事件编排出一个双态工作流（计划态 ⇄ 执行态）：

1. **入口三件套**：`/plan` 命令 + Ctrl+Alt+P 快捷键 + `--plan` CLI flag（:53-57、141-161），三者共享同一个 toggle；
2. **工具开关**：进入计划态时保存当前工具集、切换到只读集（read/bash/grep/find/ls + questionnaire，禁 edit/write，:104-114）——用的是 03 篇 8.1 节的 `setActiveTools`，系统提示词的工具清单下一轮自动跟随（03 篇 9 章的每轮重建）；
3. **bash 深度防御**：光禁 write 工具挡不住 `bash rm -rf`，所以 `tool_call` 钩子对 bash 命令过白名单（isSafeCommand，:164-174），非白名单返回 `{block: true, reason}`——reason 会作为工具错误结果回给模型，模型能理解并改道；
4. **上下文注入与清理**：计划态每轮 `before_agent_start` 注入 `[PLAN MODE ACTIVE]` 指令消息（display: false，UI 不可见但进 LLM 上下文，:201-228）；退出后用 `context` 钩子**把历史里的注入消息过滤掉**（:177-198）——不清理的话模型会被过期的"你在计划模式"指令误导。注入/清理成对，是有状态注入类扩展的必修模式；
5. **状态持久化**：每次状态变化 `pi.appendEntry("plan-mode", {...})`（custom entry，不进 LLM 上下文，03 篇 5.1 节）；`session_start` 时扫描 entries 恢复，执行态还会**重扫最后一个 execute 标记之后的** assistant 消息重建完成度（:340-389）——resume 后进度条不丢；
6. **交互编排**：agent_end 时若提取到编号计划，弹 `ctx.ui.select` 三选一（执行/留在计划/改计划，:301-336）；执行选项通过 `pi.sendMessage(..., {triggerTurn: true, deliverAs: "followUp"})` 直接驱动下一轮。

**判断**：这 390 行覆盖了扩展 API 的 80% 表面积，且每个用法都是"正确姿势"（注入配清理、持久化配恢复、block 带 reason）。给 pi 写扩展前把它抄一遍胜过读全部文档。

---

## 第 10 章 案例二 gondolin：Operations 注入的全景应用

gondolin/index.ts（531 行）回答另一个问题：**不改一行核心代码，把 pi 的全部工具搬进 micro-VM 沙箱**。机制正是 03 篇 8.2 节的 Operations 接缝：

1. **同名工具覆盖**：`pi.registerTool({...localRead, execute: ...})`（:443-515）——展开本地工具定义保留 schema/描述/渲染，只换 execute：每次执行 `ensureVm()` 拿 VM（并发去重的懒启动，:400-408），再用 `createReadTool(GUEST_WORKSPACE, { operations: createGondolinReadOps(vm, localCwd) })` 造一个"guest 后端"的工具实例转调。read/write/edit/bash/ls/find 六个工具全靠换 Operations 复用核心逻辑（BOM 处理、diff 生成、截断——全部白拿）；
2. **grep 是例外**（:239-313）：guest 里没有 rg，整个重实现成"遍历 + 正则"，但输出格式（`path:line: text`、截断通知）刻意对齐内置工具——模型看不出差别；
3. **路径双向映射**（:68-82）：host cwd ↔ guest `/workspace`，工具参数进 VM 前翻译；
4. **`user_bash` 钩子**（:517-520）：用户的 `!` 命令也进 VM——返回 `{operations}` 即可，executeBash 的注入点（03 篇 agent-session.ts:2691）接住它；
5. **系统提示词修正**（:522-530）：把 "Current working directory: /host/path" 替换成 guest 视角——否则模型会用 host 路径调工具；
6. **生命周期**：VM 挂 `session_start` 预热、`session_shutdown` 关闭（:410-425），状态用 `ctx.ui.setStatus` 报进 footer。

**判断**：531 行实现"全工具沙箱化"是对分层设计的极限压力测试，通过的原因可以精确归因：工具逻辑与 I/O 分离（Operations）、工具定义可展开复用（ToolDefinition 是纯数据+函数）、系统提示词可改写（before_agent_start）、用户 bash 有注入点（user_bash）。四个接缝少任何一个，这个扩展都得 fork 核心代码。

---

## 第 11 章 不变量、判断与坑

### 11.1 系统不变量

1. **加载期只注册、事件期才行动**（第 2 章）：runtime stubs 强制执行。
2. **stale ctx 必炸**（第 4 章）：会话替换/reload 后旧 ctx 的一切访问都 throw；跨替换的工作放 `withSession` 回调。
3. **tool_call 钩子 fail-closed，其余 fail-open**（第 5 章）。
4. **message_end 改写不得换 role**；context 钩子返回的消息数组整体替换原数组。
5. **保留快捷键不可被扩展覆盖**（第 8 章）。

### 11.2 值得抄走的设计

- **按钩子性质分五种分发语义**（第 5 章）：广播/链式/累积/阻断/首胜，比统一中间件模型表达力强。
- **throwing stubs + 带迁移指南的 stale 报错**（第 2/4 章）：把插件系统最隐蔽的两类事故变成即时教学。
- **virtualModules 双轨加载**（第 3 章）：单文件二进制里跑用户 TS 插件的完整解法。
- **plan-mode 的注入配清理、gondolin 的定义展开复用**（第 9/10 章）：两个可直接套用的扩展写作范式。

### 11.3 坑（扩展作者视角）

- **handler 无优先级**：链式改写的顺序 = 加载顺序，跨扩展协调用 `pi.events` 总线，别依赖隐式顺序。
- **before_agent_start 每轮都触发**：注入消息不做去重/条件判断会话会被灌满重复指令（plan-mode 用"退出时 context 过滤"兜底）。
- **display: false 的消息进上下文但不进 UI**：调试时容易忘了它们存在，`/export` 的 HTML 或 `--mode json` 能看到全量。
- **registerTool 同名即覆盖**：gondolin 靠这个特性工作，但两个扩展抢同一个工具名时后加载的赢，没有警告。
- **扩展里 import 的 pi-ai 是 compat 入口**（第 3.1 节）：写新扩展时若用 `createModels` 新 API 要显式从子路径导入；compat 删除时旧全局 API 会断。

### 11.4 与后续篇的接口

主线五篇（引擎 → provider → core → 前端 → 扩展）至此闭环。剩下两篇可选横切：`06-testing.md` 的地基已在第 2 篇 12 章（faux provider）铺好，主角是 `test/suite/harness.ts` 如何把 faux、内存会话、扩展装配进可断言的整机测试；`07-robustness-and-cost.md` 则把 02 篇的 retry/overflow、03 篇的三通道压缩与重试预算、缓存经济学（02 篇 7.2 节的 cache_control 落点 + calculateCost 的 2 倍 1h 写价）串成"生产级 agent 的钱与命"专题。

---

*基于 commit 3f9aa5d1。ExtensionAPI 与事件类型是 pi 对第三方作者的公开承诺，向后兼容压力最大、演进最谨慎；examples/extensions/ 与 docs/extensions.md 是行为的事实规范，行号漂移时以它们为准。*
