# Coding agent suite 测试

围绕 `AgentSession` 和 `AgentSessionRuntime` 的新的基于 harness 的测试套件，请使用 `test/suite/` 目录。

规则：
- 使用 `test/suite/harness.ts`
- 使用 `packages/ai/src/providers/faux.ts` 中的 faux provider
- 不要使用真实的 provider API、真实的 API key、网络调用或付费 token
- 保持这些测试对 CI 安全且确定性（deterministic）
- 不要使用或扩展旧的 `test/test-harness.ts` 路径，除非缺失的能力迫使你这样做

组织方式：
- 宽泛的生命周期测试和特征化（characterization）测试直接放在 `test/suite/` 下
- 针对特定 issue 的回归测试放在 `test/suite/regressions/` 下
- 回归测试命名为 `<issue-number>-<short-slug>.test.ts`
- 示例：`test/suite/regressions/2023-queued-slash-command-followup.test.ts`
