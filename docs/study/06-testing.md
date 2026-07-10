# 06 — 测试体系：faux、harness 与回归测试制度（横切篇）

> 学习系列第 6 篇，第一篇横切主题（不按包切分）。前五篇多次预告的测试地基在这里合拢：第 2 篇 12 章的 faux provider 是砖，本篇讲怎么用它盖房——`test/suite/harness.ts` 的整机装配、按 issue 号归档的回归测试制度、TUI 渲染断言、e2e 的环境变量门控。目标是读完后你能为 pi 写一个合格的回归测试，并理解 CLAUDE.md 里那几条测试戒律（"别跑 npm test"、"必须用 faux"）背后的原因。
>
> 所有 `文件:行号` 基于 commit `3f9aa5d1`。

## 目录

- 第 1 章 地形图：四个包的测试分布与两类测试
- 第 2 章 e2e 门控：环境变量即开关，test.sh 即钥匙回收
- 第 3 章 faux 的两侧注册：同一个假厂商，两条进入路径
- 第 4 章 test/suite/harness.ts 走读：整机的最小内存版
- 第 5 章 回归测试制度：issue 号即文件名
- 第 6 章 TUI 层测试：FakeTerminal 与重绘计数断言
- 第 7 章 agent 包的测试：Models 集合路径与响应工厂
- 第 8 章 tmux：最后一公里的人肉替身
- 第 9 章 判断与坑

---

## 第 1 章 地形图：四个包的测试分布与两类测试

```
packages/coding-agent/test/   ~39,500 行，最重
  ├── *.test.ts                    传统单元/集成测试（package-manager 2499、model-registry 1846…）
  ├── suite/                       ★ 新制度：harness 整机测试
  │   ├── harness.ts               219 行的装配器（第 4 章）
  │   ├── README.md                规则的权威文本
  │   └── regressions/             30+ 个按 issue 号命名的回归测试
  └── utilities.ts                 旧工具（含真实 key 的读取，e2e 用）
packages/ai/test/               每 provider 一组：纯逻辑测试 + skipIf 门控的 e2e
packages/agent/test/            agent-loop/harness 测试（用 Models 集合 + fauxProvider）
packages/tui/test/              组件与渲染测试
```

全仓测试分两个物种，识别标志是**是否需要密钥**：

- **确定性测试**：faux provider / 内存存储 / 假终端，CI 安全，永远运行；
- **e2e 测试**：打真实 provider API，按环境变量存在与否自动激活（第 2 章）——文件名常带 `-e2e` 或用 `describe.skipIf`。

**判断**：这个二分不是按"单元/集成"的教科书轴切的，而是按**成本与确定性**切——一个跨 AgentSession+会话树+扩展的整机测试只要跑在 faux 上就算"便宜侧"。这解释了为什么 suite/ 里的测试普遍又大又深（动辄断言完整事件序列）却仍是 CI 默认集。

## 第 2 章 e2e 门控：环境变量即开关，test.sh 即钥匙回收

e2e 的激活机制简单到没有配置文件：测试头部 `describe.skipIf(!process.env.OPENAI_API_KEY)(...)`（如 ai/test/abort.test.ts:101-192，八个 provider 一字排开）。有钥匙就跑真 API，没钥匙静默跳过。

这带来一个反直觉的危险：**开发者机器上跑 `npm test` 会烧真钱**——你 shell 里的 ANTHROPIC_API_KEY 会激活全部 Anthropic e2e。这就是根目录 `test.sh` 的存在理由：备份走 `~/.pi/agent/auth.json`（防 AuthStorage 的 env 兜底捞到凭据）、**逐个 unset 三十多个密钥环境变量**（test.sh 里那一长串 unset，覆盖第 2 篇 env-api-keys.ts 的整张映射表外加 AWS/GCP 全家）、设 `PI_NO_LOCAL_LLM=1` 跳过 ollama/lmstudio，然后才 `npm test`，退出时 trap 恢复 auth.json。

**判断**：用"环境里有没有钥匙"做测试开关，好处是零配置、CI 加 secret 即开新覆盖；坏处是开关是**隐式**的，所以需要 test.sh 这种"钥匙回收"仪式来保证默认安全。CLAUDE.md 那条"Never run npm test unless the user asks"是这个设计的直接推论，不是洁癖。

## 第 3 章 faux 的两侧注册：同一个假厂商，两条进入路径

第 2 篇 12 章讲过 faux 的内核（响应队列、全保真流式、缓存模拟）。用的时候要选注册路径，正好对应第 2 篇第 2 章的双世界：

- **`registerFauxProvider()`**（compat.ts:154-170）→ 进全局 api 注册表。coding-agent 的测试用这个，因为 pi CLI 走 compat 入口；api 名随机生成（`faux:时间戳:随机`）防并行测试串台，`unregister()` 在 cleanup 里必调。
- **`fauxProvider()`**（providers/faux.ts:520-538）→ 造一个 Provider 对象放进显式 `Models` 集合。agent 包的 harness 测试用这个（agent/test/harness/agent-harness-stream.test.ts:20-25：每个测试造 `faux-${++fauxCount}` 唯一 id 的 provider 塞进共享集合）。

选错路径的症状是"响应队列排了但没人消费"——被测代码从另一个世界解析模型。**测试代码是判断'某段生产代码走哪个世界'的最快证据**：看它的测试用哪种注册。

## 第 4 章 test/suite/harness.ts 走读：整机的最小内存版

`createHarness`（harness.ts:100-219）是第 3 篇 sdk.ts `createAgentSession` 的**平行装配器**——同样的零件，全部换成内存实现：

| 生产（sdk.ts） | 测试（harness.ts） |
|---|---|
| `SessionManager.create(cwd, dir)`（JSONL 落盘） | `SessionManager.inMemory()`（:111） |
| `SettingsManager.create(cwd, agentDir)`（双层文件） | `SettingsManager.inMemory(options.settings)`（:112，测试直接注入任意设置） |
| `AuthStorage.create(auth.json)`（文件锁） | `AuthStorage.inMemory()` + `setRuntimeApiKey("faux-key")`（:114-117） |
| `ModelRegistry.create(...)`（models.json） | `ModelRegistry.inMemory()` + `registerProvider` 注册 faux 模型（:118-136） |
| streamFn 闭包（ModelRegistry 解析密钥） | 省略——Agent 默认 streamSimple 会命中 api 注册表里的 faux（:138-169） |
| createAllToolDefinitions（真实文件工具） | `baseToolsOverride: toolMap`（:183，测试自带假工具） |

三个对测试作者最重要的出口：

1. **`setResponses([...])` / `appendResponses`**：排 faux 响应队列，元素可以是静态 `fauxAssistantMessage(...)` 或**工厂函数**（拿到 context/options/callCount，按轮次动态生成——多轮工具循环、"第二次调用才成功"的重试场景全靠它）；
2. **`events` + `eventsOfType(type)`**（:190-209）：订阅从构造起的全部 AgentSessionEvent，断言事件序列的类型安全过滤器;
3. **`faux.state.callCount`**：LLM 被调了几次——重试/压缩类测试的核心断言。

`withConfiguredAuth: false`（:108）是个隐藏开关：模拟"没配密钥"的环境，测鉴权失败路径。`extensionFactories` 接受内联扩展工厂（:170-174）——第 5 篇的整个扩展系统在测试里用一个匿名函数就能装配，不需要写文件。

**判断**：这 219 行的价值在于它把第 3 篇的判断"AgentSession 是三模式共享的总机"变成了可执行事实——测试不启动任何模式（无 TUI、无 stdin），直接对总机 prompt 并断言事件，覆盖到的却是三个模式共享的全部行为。每个 in-memory 静态工厂（SessionManager.inMemory 等）都是为此存在的接缝，生产代码里几乎不用。

## 第 5 章 回归测试制度：issue 号即文件名

suite/README.md 是制度的权威文本，规则浓缩为：整机生命周期测试放 `test/suite/` 顶层，issue 回归放 `test/suite/regressions/<issue-number>-<short-slug>.test.ts`，只用 harness + faux，禁真 API/网络/付费 token，禁扩展旧的 test-harness.ts。

看一个标本——`6019-explicit-provider-retry-message.test.ts`（第 2 篇 11.2 节 retry.ts 里 #6019 模式的来源）：

```typescript
const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
harness.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage }),   // OpenAI 真实错误文案
    fauxAssistantMessage("recovered"),
]);
await harness.session.prompt("test");
expect(harness.faux.state.callCount).toBe(2);
expect(harness.eventsOfType("auto_retry_start").map(e => e.errorMessage)).toEqual([errorMessage]);
```

五个值得抄的手法：**真实错误文案原样入库**（provider 的措辞就是协议，第 2 篇 9.3 节"错误字符串是跨层协议"的测试侧）；`baseDelayMs: 1` 把指数退避压到毫秒级；`it.each` 一次覆盖两家 provider；断言打在**事件流**而非内部状态上（事件是对外契约，重构不碎）；`finally { harness.cleanup() }` 无条件清理。

**判断**：`regressions/` 目录 + retry.ts/overflow.ts 里的 issue 号注释，构成了一个双向索引的"事故博物馆"——从 issue 找到防复发测试，从正则模式找到当年的事故。这比任何 changelog 都可靠，因为它是可执行的。第 1 篇到第 5 篇里那些"从生产 bug 长出来的守卫"（压缩时间戳守卫、duplicate-header 防御…），几乎都能在这里找到对应测试。

## 第 6 章 TUI 层测试：FakeTerminal 与重绘计数断言

UI 测不了"看起来对不对"，但测得了**写进终端的字节**。模式见 `edit-tool-no-full-redraw.test.ts`：

- **FakeTerminal**（实现 tui 的 Terminal 接口，把 `write(data)` 收进数组）+ 派生断言器 `fullClearCount`（数 `\x1b[2J\x1b[H\x1b[3J` 清屏序列出现次数）；
- 配合第 4 篇 3.1 节埋的 `tui.fullRedraws` 计数器，断言"edit 工具的大 diff 预览落定时**不触发全量重绘**"——这是对差分引擎行为的直接回归保护；
- `waitForRenderedText`（轮询 render 输出直到包含期望文本，带超时和最后一帧 dump）处理渲染的异步性——16ms 节流意味着断言必须等帧。

组件级测试则直接调 `component.render(width)` 拿行数组断言内容——第 4 篇的极简组件契约（`render(width): string[]`）在这里兑现第二重红利：**组件天然可测，不需要浏览器或快照基建**。

## 第 7 章 agent 包的测试：Models 集合路径与响应工厂

agent 包的 harness 测试展示 faux 的另一侧用法（第 3 章的第二条路径），并示范响应工厂的高级形态（agent-harness-stream.test.ts:41-48）：

```typescript
registration.setResponses([
    (_context, options) => {          // 工厂函数：捕获 streamFn 收到的 options
        capturedOptions = options;
        return fauxAssistantMessage("ok");
    },
]);
```

用响应工厂**反向探测**调用方传了什么参数——headers 快照、cacheRetention、sessionId 这些"穿过多少层后到底长什么样"的问题，一个捕获变量就答了。配合 `fauxToolCall(...)` 排出"assistant 带工具调用 → 工具结果 → 最终回复"的多步剧本，第 1 篇的整个双层循环可以在无网络环境下逐事件验证。

## 第 8 章 tmux：最后一公里的人肉替身

faux 测不到的只剩一样：真实终端里的交互手感（键序、渲染时序、真实 shell）。AGENTS.md 给的流程（"Testing pi Interactive Mode with tmux"节）：`tmux new-session -d -s pi-test -x 80 -y 24` 固定尺寸开会话 → `send-keys` 喂 `./pi-test.sh` 和提示词 → `capture-pane -p` 抓屏断言 → 特殊键用 tmux 键名（Escape、C-o）。发布前的 smoke test 也走这条路（Node 和 Bun 双形态各跑一次真 prompt）。这是体系里唯一无法 CI 化的环节，制度化的手工步骤——脚本在文档里，执行靠人（或靠会用 tmux 的 agent）。

## 第 9 章 判断与坑

### 9.1 这套体系的三个支柱（值得移植）

1. **假厂商保真到流式时序**（第 2 篇 12 章 + 本篇第 4 章）：多数 LLM 应用 mock 掉的恰恰是 bug 最多的流式/abort/多轮路径；
2. **整机装配器 + 事件流断言**：断言对外契约（事件）而非内部状态，重构存活率高；
3. **issue 号命名的回归目录**：可执行的事故博物馆，与代码注释里的 issue 号互为索引。

### 9.2 坑（写测试的人视角）

- **跑单个测试的正确姿势**：包根目录下 `node ../../node_modules/vitest/dist/cli.js --run test/xxx.test.ts`（CLAUDE.md 明文）；直接 `npm test` 或裸 vitest 会捎上 e2e。
- **faux 队列耗尽不是 throw**：返回 `stopReason: "error"` 的消息（第 2 篇 12 章）——测试少排了响应，症状是"断言 auto_retry 事件却等来 error 消息"，先查 `getPendingResponseCount()`。
- **cleanup 必须无条件**：`registerFauxProvider` 写的是**模块级**全局注册表，泄漏会污染同进程后续测试（api 名随机化只是缓解）。
- **事件断言等帧**：TUI 侧有 16ms 节流，AgentSession 侧 `prompt()` resolve 即事件完整（`agent_settled` 已发）——两侧的"等待完成"语义不同。
- **suite/ 的纪律是硬的**：给上游提回归测试 PR 时用错 harness（旧 test-harness.ts）或碰真 API 会被打回，README.md 就是验收标准。

### 9.3 与下一篇的接口

本篇的事故博物馆（retry/overflow 的 issue 号正则、regressions/ 目录）从**验证**侧看健壮性；最后一篇 `07-robustness-and-cost.md` 从**设计**侧收官：把散在前六篇的防御机制（三层错误兜底、重试预算、压缩三通道、溢出方言）和成本机制（cache_control 落点、1h 缓存的 2 倍写价、字符÷4 估算的系统性影响）串成一张"生产级 agent 的钱与命"总图。

---

*基于 commit 3f9aa5d1。test/suite/ 的制度（README.md）和 harness API 是给贡献者的稳定契约；具体测试文件随 issue 增长，读法是按 issue 号检索而非通读。*
