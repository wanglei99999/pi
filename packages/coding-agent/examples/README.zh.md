# 示例

pi-coding-agent SDK 和 extensions 的示例代码。

## 目录

### [sdk/](sdk/)
通过 `createAgentSession()` 进行编程式使用。展示如何自定义模型、prompt、工具、extensions 和会话管理。

### [extensions/](extensions/)
示例 extensions，演示：
- 生命周期事件处理器（工具拦截、安全门控、上下文修改）
- 自定义工具（todo 列表、提问、subagent、输出截断）
- 命令和键盘快捷键
- 自定义 UI（footer、header、编辑器、overlay）
- Git 集成（checkpoint、自动提交）
- System prompt 修改和自定义 compaction
- 外部集成（SSH、文件监听、系统主题同步）
- 自定义 provider（带自定义 streaming 的 Anthropic、GitLab Duo）

## 文档

- [SDK 参考](sdk/README.md)
- [Extensions 文档](../docs/extensions.md)
- [Skills 文档](../docs/skills.md)
