# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read [AGENTS.md](AGENTS.md) — it is the authoritative rulebook for this repo** (code quality, git safety, changelogs, releasing, issue/PR workflow). The notes below summarize the essentials and add architecture context; AGENTS.md wins on any conflict.

## Commands

```bash
npm install --ignore-scripts   # install deps; never run lifecycle scripts unless asked
npm run check                  # after any code change: lint (biome), typecheck (tsgo), dep/shrinkwrap checks. Fix ALL errors/warnings/infos. Read full output, no tail.
./test.sh                      # all non-e2e tests (unsets API keys so LLM e2e tests skip)
./pi-test.sh                   # run pi from source (tsx); works from any directory
```

- **Never** run `npm run build` or `npm test` unless the user asks. Never run the full vitest suite directly — it activates e2e tests when API keys/env vars are present.
- Run a single test from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`. If you create/modify a test, run it and iterate until it passes.
- Tests in `packages/coding-agent/test/suite/` must use `test/suite/harness.ts` + the faux provider (`packages/ai/src/providers/faux.ts`) — no real provider APIs or keys. Issue regressions go in `test/suite/regressions/<issue-number>-<short-slug>.test.ts`.
- Test the TUI interactively via tmux (see AGENTS.md "Testing pi Interactive Mode with tmux") using `./pi-test.sh`.

## Critical constraints (from AGENTS.md)

- **Erasable TypeScript only** in `packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`: code runs via Node type-stripping/tsx with no emit — no `enum`, `namespace`, parameter properties, `import =`/`export =`.
- **No inline imports** (`await import()`, `import("pkg").Type`) — top-level imports only. No `any` unless absolutely necessary.
- Never edit `packages/ai/src/models.generated.ts` by hand — change `packages/ai/scripts/generate-models.ts` and regenerate.
- Never hardcode key checks (`matchesKey(keyData, "ctrl+x")`) — add defaults to `DEFAULT_EDITOR_KEYBINDINGS` / `DEFAULT_APP_KEYBINDINGS`.
- Multiple agent sessions may share this worktree. Stage explicit paths only (`git add <path>`); never `git add -A`/`.`, `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `--no-verify`. Never commit unless asked.
- Commit format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <message>`.
- Deps are pinned exact; treat lockfile changes as reviewed code. Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Refresh lock metadata with `npm install --package-lock-only --ignore-scripts`.
- Changelog entries go under `## [Unreleased]` in the affected package's `packages/*/CHANGELOG.md`; released sections are immutable.
- Core philosophy (CONTRIBUTING.md): **pi's core stays minimal** — features that can live in an extension should be an extension.

## Architecture

npm-workspaces monorepo, TypeScript ESM, Node >= 22.19. Packages release in lockstep (one shared version). Dependency chain / build order:

```
pi-tui ──┐
pi-ai ───┴─→ pi-agent-core ─→ pi-coding-agent (the `pi` CLI)
```

### packages/ai — unified multi-provider LLM API

- One streaming API over OpenAI, Anthropic, Google, Bedrock, and ~30 other providers. Each provider is a pair in `src/providers/`: `<name>.ts` (implementation) + `<name>.models.ts` (model list).
- `src/models.generated.ts` is generated (see constraint above). `src/providers/faux.ts` is the fake provider used by the coding-agent test suite.
- Env-based API key resolution lives in `src/env-api-keys.ts`; OAuth flows in `src/auth/` and `oauth.ts`. There is a `.pi/skills/add-llm-provider.md` skill for adding providers.

### packages/agent — agent runtime

- `Agent` (`src/agent.ts`, `src/agent-loop.ts`): stateful agent loop with tool execution and event streaming (`agent_start` → `turn_start` → `message_start/update/end` → tool execution → repeat → `agent_end`).
- Works with `AgentMessage` (extensible via declaration merging), converted to LLM `user`/`assistant`/`toolResult` messages through `transformContext()` → `convertToLlm()` before each call.
- `src/harness/`: higher-level agent harness — sessions, compaction, skills, prompt templates, system-prompt assembly. Docs in `packages/agent/docs/`.

### packages/coding-agent — the `pi` CLI

- `src/core/`: `AgentSession` (`agent-session.ts` + runtime/services) wires the agent to tools (`core/tools/`), session persistence (`session-manager.ts`, tree-structured sessions with branching), settings (`settings-manager.ts`), model registry/resolver, compaction, project trust, and the extension system (`core/extensions/`).
- `src/modes/`: three frontends over the same core — `interactive/` (TUI), `print-mode.ts` (one-shot `-p`), `rpc/` (JSON protocol for embedding; see `docs/rpc.md`).
- Extensibility surface: **extensions** (TS/JS modules with hooks), **skills** (SKILL.md folders), **prompt templates**, **themes** — bundled/distributed as "pi packages" via npm/git (`docs/packages.md`, examples in `examples/extensions/`).
- Path resolution must go through `src/config.ts` (`getPackageDir()` etc.), never `__dirname` — the CLI runs as npm install, standalone Bun binary, or tsx-from-source.
- `npm-shrinkwrap.json` is generated from the root lockfile via `node scripts/generate-coding-agent-shrinkwrap.mjs`; new deps with lifecycle scripts need an explicit allowlist entry there.

### packages/tui — terminal UI library

Differential-rendering TUI components, editor, keybindings (`keybindings.ts` — see keybinding constraint above). Used by the interactive mode.

### packages/orchestrator

Experimental; unstable API, may change or be removed.
