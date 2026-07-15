# Plan Mode Extension

用于安全代码分析的只读探索模式。

## 特性

- **禁用内置写入工具**：禁用 edit/write，同时保留其他已启用的工具
- **Bash allowlist**：只允许只读的 bash 命令
- **计划提取**：从 `Plan:` 段落中提取带编号的步骤
- **进度跟踪**：执行期间由 widget 显示完成状态
- **[DONE:n] 标记**：显式的步骤完成跟踪
- **会话持久化**：状态在会话恢复后依然保留

## 命令

- `/plan` —— 切换 plan mode
- `/todos` —— 显示当前计划进度
- `Ctrl+Alt+P` —— 切换 plan mode（快捷键）

## 用法

1. 使用 `/plan` 或 `--plan` 标志启用 plan mode
2. 让 agent 分析代码并创建计划
3. agent 应在 `Plan:` 标题下输出带编号的计划：

```
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. 在提示时选择 "Execute the plan"
5. 执行期间，agent 用 `[DONE:n]` 标签标记完成的步骤
6. 进度 widget 显示完成状态

## 工作原理

### Plan Mode（只读）
- 禁用内置的 edit/write 工具
- 其他已启用的工具保持可用
- Bash 命令经过 allowlist 过滤
- agent 创建计划而不做任何更改

### 执行模式
- 恢复完整的工具访问
- agent 按顺序执行步骤
- `[DONE:n]` 标记跟踪完成情况
- widget 显示进度

### 命令 Allowlist

安全命令（允许）：
- 文件查看：`cat`、`head`、`tail`、`less`、`more`
- 搜索：`grep`、`find`、`rg`、`fd`
- 目录：`ls`、`pwd`、`tree`
- Git 读取：`git status`、`git log`、`git diff`、`git branch`
- 包信息：`npm list`、`npm outdated`、`yarn info`
- 系统信息：`uname`、`whoami`、`date`、`uptime`

阻止的命令：
- 文件修改：`rm`、`mv`、`cp`、`mkdir`、`touch`
- Git 写入：`git add`、`git commit`、`git push`
- 包安装：`npm install`、`yarn add`、`pip install`
- 系统：`sudo`、`kill`、`reboot`
- 编辑器：`vim`、`nano`、`code`
