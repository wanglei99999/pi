<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> 新贡献者提交的 issue 和 PR 默认会被自动关闭。维护者每天会审阅被自动关闭的 issue。参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

# Pi Agent Harness

这里是 Pi agent harness 项目的主仓库，包含我们的可自我扩展（self extensible）的 coding agent。

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**：交互式 coding agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**：带有 tool calling 和状态管理的 agent 运行时
* **[@earendil-works/pi-ai](packages/ai)**：统一的多 provider LLM API（OpenAI、Anthropic、Google 等）

进一步了解 Pi：

* [访问 pi.dev](https://pi.dev)，项目官网，包含演示
* [阅读文档](https://pi.dev/docs/latest)，你也可以直接让 agent 解释它自己

## 所有包

| 包 | 描述 |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | 统一的多 provider LLM API（OpenAI、Anthropic、Google 等） |
| **[@earendil-works/pi-agent-core](packages/agent)** | 带有 tool calling 和状态管理的 agent 运行时 |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | 交互式 coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | 基于差分渲染（differential rendering）的终端 UI 库 |

Slack/聊天自动化与工作流请参见 [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat)。

## 权限与容器化

Pi 没有内置用于限制文件系统、进程、网络或凭据访问的权限系统。默认情况下，它以启动它的用户和进程的权限运行。

如果你需要更强的隔离边界，请将 Pi 容器化或放入沙箱。参见 [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) 中的三种模式：

- **Gondolin extension**：将 `pi` 和 provider 认证保留在宿主机上，同时把内置工具和 `!` 命令路由到本地 Linux micro-VM 中执行。
- **纯 Docker**：将整个 `pi` 进程运行在本地容器中，实现简单隔离。
- **OpenShell**：将整个 `pi` 进程运行在受策略控制的沙箱中。

## 贡献

贡献指南参见 [CONTRIBUTING.md](CONTRIBUTING.md)，项目特定规则（对人类和 agent 都适用）参见 [AGENTS.md](AGENTS.md)。Pi 的长期规划可以在 [RFCs](https://rfc.earendil.com/keyword/pi/) 中找到。

## 开发

```bash
npm install --ignore-scripts  # 安装所有依赖，不运行 lifecycle scripts
npm run build        # 构建所有包
npm run check        # Lint、格式化和类型检查
./test.sh            # 运行测试（没有 API key 时跳过依赖 LLM 的测试）
./pi-test.sh         # 从源码运行 pi（可在任意目录下运行）
```

## 供应链加固

我们把 npm 依赖变更当作需要审查的代码变更来对待。

- 直接外部依赖锁定为精确版本（pinned exact versions）。内部 workspace 包仍使用版本范围。
- `.npmrc` 设置了 `save-exact=true` 和 `min-release-age=2`，以避免 npm 解析时使用当天刚发布的依赖版本。
- `package-lock.json` 是依赖的事实来源（ground truth）。Pre-commit 钩子会阻止意外提交 lockfile，除非设置了 `PI_ALLOW_LOCKFILE_CHANGE=1`。
- `npm run check` 会校验直接依赖是否锁定精确版本、原生 TypeScript import 兼容性，以及生成的 coding-agent shrinkwrap。
- 发布的 CLI 包中包含 `packages/coding-agent/npm-shrinkwrap.json`（由根 lockfile 生成），用于为 npm 用户锁定传递依赖。
- 发布冒烟测试使用 `npm run release:local`，在打 tag 之前于仓库之外构建、打包并创建隔离的 npm 和 Bun 安装环境。
- 本地发布安装、文档中的 npm 安装方式以及 `pi update --self` 在支持的情况下都会使用 `--ignore-scripts`。
- CI 使用 `npm ci --ignore-scripts` 安装依赖，并有一个定时 GitHub workflow 运行 `npm audit --omit=dev` 和 `npm audit signatures --omit=dev`。
- Shrinkwrap 生成过程对依赖的 lifecycle scripts 有显式的 allowlist；新增带 lifecycle script 的依赖在审查之前会导致检查失败。

## 分享你的 OSS coding agent 会话

如果你在开源工作中使用 Pi 或其他 coding agent，请分享你的会话数据。

公开的 OSS 会话数据能帮助 coding agent 从真实世界的任务、工具使用、失败和修复中改进，而不是依赖玩具级基准测试。

完整说明参见 [这篇 X 上的帖子](https://x.com/badlogicgames/status/2037811643774652911)。

要发布会话，请使用 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf)。阅读它的 README.md 了解设置步骤。你只需要一个 Hugging Face 账号、Hugging Face CLI 和 `pi-share-hf`。

你也可以观看 [这个视频](https://x.com/badlogicgames/status/2041151967695634619)，其中展示了作者如何发布自己的 `pi-mono` 会话。

作者定期在这里发布自己的 `pi-mono` 工作会话：

- [Hugging Face 上的 badlogicgames/pi-mono](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> 域名由以下机构慷慨捐赠
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
