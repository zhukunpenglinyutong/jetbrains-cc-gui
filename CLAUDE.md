⚠️ **重要**：后续涉及到多模态消息处理逻辑的时候，请阅读这个文档，避免产生BUG /docs/multimodal-permission-bug.md

⚠️ **重要**：通过 ProcessBuilder 调用 Node.js 脚本时，**禁止**将用户输入作为命令行参数传递！
必须使用 stdin + JSON 方式传递用户消息和其他可能包含特殊字符的数据。
详见 /docs/cmdline-argument-escaping-bug.md

⚠️ **重要**claude sdk 文档在  /docs/claude-agent-sdk.md
