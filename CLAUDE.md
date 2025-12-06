⚠️ **重要**：后续涉及到多模态消息处理逻辑的时候，请阅读这个文档，避免产生BUG /docs/multimodal-permission-bug.md

⚠️ **重要**：通过 ProcessBuilder 调用 Node.js 脚本时，**禁止**将用户输入作为命令行参数传递！
必须使用 stdin + JSON 方式传递用户消息和其他可能包含特殊字符的数据。
详见 /docs/cmdline-argument-escaping-bug.md

⚠️ **重要**：Claude SDK 文档在 /docs/claude-agent-sdk.md

⚠️ **重要**：**禁止**尝试查找系统安装的 Claude CLI 路径！
必须使用 SDK 内置的 cli.js（不传递 `pathToClaudeCodeExecutable` 选项）。
在 Windows 上 `where claude` 返回的路径可能无法直接 spawn，会导致 ENOENT 错误。
详见 /docs/windows-cli-path-bug.md

⚠️ **重要**：使用 Tailwind CSS 来修改代码，并且尽量别把代码写到app.css中，因为app.css文件太长了
