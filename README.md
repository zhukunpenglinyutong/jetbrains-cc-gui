<div align="center">

# Claude GUI

IntelliJ IDEA Plugin for Claude Code

![][github-contributors-shield] ![][github-forks-shield] ![][github-stars-shield] ![][github-issues-shield]

</div>

A powerful IntelliJ IDEA plugin that provides a visual interface for **Claude Code**, making AI-assisted programming more efficient and intuitive.

> Originally forked from [idea-claude-code-gui](https://github.com/zhukunpenglinyutong/idea-claude-code-gui) by zhukunpenglinyutong — rewritten for English-only, Claude-only use.

---

## Key Features

### Claude Code Support
- **Claude Code** - Anthropic's official AI programming assistant, supporting Opus 4.6, Sonnet 4.6, and Haiku 4.5

### Intelligent Conversation
- Context-aware AI coding assistant
- @file reference support for precise code context
- Image sending support for visual requirement description
- Conversation rewind feature for flexible history adjustment
- Enhanced prompts for better AI understanding

### Agent System
- Built-in Agent system for automated complex tasks
- Skills slash command system (/init, /review, etc.)
- MCP server support to extend AI capabilities

### Developer Experience
- Comprehensive permission management and security controls
- Code DIFF comparison feature
- File navigation and code jumping
- Dark/Light theme switching
- Font scaling and IDE font synchronization

### Session Management
- History session records and search
- Session favorites
- Message export support
- Provider management (cc-switch compatible)
- Usage statistics analysis

---

## Installation

[Claude GUI on JetBrains Marketplace](https://plugins.jetbrains.com/plugin/29599-claude-gui)

---

## Local Development

### 1. Install Frontend Dependencies

```bash
cd webview
npm install
```

### 2. Install ai-bridge Dependencies

```bash
cd ai-bridge
npm install
```

### 3. Debug Plugin

Run in IDEA:
```bash
./gradlew clean runIde
```

### 4. Build Plugin

```sh
./gradlew clean buildPlugin

# The generated plugin package will be in the build/distributions/ directory
```

---

## Contributing

For contributing guidelines, please read [CONTRIBUTING.md](CONTRIBUTING.md)

---

## License

AGPL-3.0

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=LaCreArthur/idea-claude-gui&type=Date)](https://star-history.com/#LaCreArthur/idea-claude-gui&Date)

<!-- LINK GROUP -->

[github-contributors-shield]: https://img.shields.io/github/contributors/LaCreArthur/idea-claude-gui?color=c4f042&labelColor=black&style=flat-square
[github-forks-shield]: https://img.shields.io/github/forks/LaCreArthur/idea-claude-gui?color=8ae8ff&labelColor=black&style=flat-square
[github-issues-link]: https://github.com/LaCreArthur/idea-claude-gui/issues
[github-issues-shield]: https://img.shields.io/github/issues/LaCreArthur/idea-claude-gui?color=ff80eb&labelColor=black&style=flat-square
[github-license-link]: https://github.com/LaCreArthur/idea-claude-gui/blob/main/LICENSE
[github-stars-shield]: https://img.shields.io/github/stars/LaCreArthur/idea-claude-gui?color=ffcb47&labelColor=black&style=flat-square
