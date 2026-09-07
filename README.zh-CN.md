<div align="center">

# CC GUI（Claude, Codex and More）

> 原名：Claude Code GUI

<img width="120" alt="Image" src="./docs/images/idea-claude-code-gui-logo.png" />

**简体中文** · [English](./README.md)

<a href="https://trendshift.io/repositories/24968" target="_blank"><img src="https://trendshift.io/api/badge/repositories/24968" alt="zhukunpenglinyutong%2Fjetbrains-cc-gui | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>

![][github-contributors-shield] ![][github-forks-shield] ![][github-stars-shield] ![][github-issues-shield] ![][github-mit]

</div>

> 为规避Claude商标风险，本项目名称修改为CC GUI（原名：Claude Code GUI）；并更换LOGO减少中国元素；对于安全方面，后续每个小版本发版前都进行 /security-review 审查，每隔10个小版本进行一次整体的 claude-code-security 审查

一个功能强大的 IntelliJ IDEA 插件，为开发者提供 **Claude Code**、**OpenAI Codex** 以及更多 AI 编程 CLI的可视化操作界面，让 AI 辅助编程变得更加高效和直观。

<img width="850" alt="Image" src="/docs/img/banner.png" />

---

## 插件下载

[CC GUI（Claude, Codex and More） 下载](https://plugins.jetbrains.com/plugin/29342-cc-gui-claude-or-codex-)

---

## 核心特性

### 多 AI 引擎支持
- **Claude Code** - Anthropic 官方 AI 编程助手，支持 Opus 4.5 等多模型
- **OpenAI Codex** - OpenAI 强大的代码生成引擎
- **Grok CLI**（Beta）- xAI 的命令行 AI 编程助手
- **Kimi CLI**（Beta）- 月之暗面（Moonshot AI）的命令行 AI 编程助手
- **OpenCode**（Beta）- 开源终端 AI 编程 Agent
- **PI CLI**（Beta）- PI 命令行 AI 编程助手
- **OMP CLI**（Beta）- OMP 命令行 AI 编程助手
- **DeepSeek Harness**（Beta）- DeepSeek 的命令行编程 Harness

### 智能对话功能
- 上下文感知的 AI 编程助手
- 支持 @文件引用，精准指定代码上下文
- 图片发送支持，可视化描述需求
- 对话回退功能，灵活调整对话历史
- 强化提示词，优化 AI 理解能力

### Agent 智能体
- 内置 Agent 系统，自动化执行复杂任务
- Skills 斜杠命令系统（/init, /review 等）
- MCP 服务器支持，扩展 AI 能力边界

### 开发者体验
- 完善的权限管理和安全控制
- 代码 DIFF 对比功能
- 文件跳转和代码导航
- 深色/浅色主题切换
- 字体缩放和 IDE 字体同步
- 国际化支持（中/英文自动切换）

### 会话管理
- 历史会话记录和搜索
- 会话收藏功能
- 消息导出支持
- 供应商管理（兼容 cc-switch）
- 使用统计分析

---

## 项目状态

项目处于活跃开发阶段，代码持续更新中。版本历史和迭代进度请阅读 [CHANGELOG.md](CHANGELOG.md)

---

### 贡献代码

贡献代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)

---


## 本地开发调试

### 1.安装前端依赖

```bash
cd webview
npm install
```

### 2.安装ai-bridge依赖

```bash
cd ai-bridge
npm install
```

### 3.调试插件

在 IDEA 中运行：
```bash
./gradlew clean runIde
```

### 4.构建插件

```sh
./gradlew clean buildPlugin

# 生成的插件包会在 build/distributions/ 目录下（包体大约40MB）
```

---

## License

MIT

---

## 贡献者列表

感谢所有帮助 IDEA-Claude-Code-GUI 变得更好的贡献者！

<a href="https://github.com/zhukunpenglinyutong/jetbrains-cc-gui/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=zhukunpenglinyutong/jetbrains-cc-gui" alt="Contributors" />
</a>

---

## 赞助支持

如果这个项目对你有帮助，想请作者吃顿肯德基（KFC）或者喝杯咖啡，都是可以的~

[查看赞助者列表 →](./SPONSORS.md)

---

## AtomGit

https://atomgit.com/zhukunpenglinyutong/idea-claude-code-gui

---

## 友链

感谢 [LINUX DO](https://linux.do/) 用户的支持与反馈

感谢[AtomGit](https://atomgit.com/zhukunpenglinyutong/idea-claude-code-gui)平台G-Star认证

---

## 致谢

最近有很多博主自发推荐本项目，心中十分感激，再次感谢《沉默的王二》《macrozheng》《JavaGuide》《Java知音》《鲲鹏talk 公众号》《程序员青戈》等博主推荐本项目，我会继续努力迭代，让大家用起来更舒适。

---

## Star History

[![Star History](https://star-history.dera.page/svg?repos=zhukunpenglinyutong/jetbrains-cc-gui&type=date&legend=top-left)](https://star-history.dera.page/#zhukunpenglinyutong/jetbrains-cc-gui&type=date&legend=top-left)

<!-- LINK GROUP -->

[github-contributors-shield]: https://img.shields.io/github/contributors/zhukunpenglinyutong/idea-claude-code-gui?color=c4f042&labelColor=black&style=flat-square
[github-forks-shield]: https://img.shields.io/github/forks/zhukunpenglinyutong/idea-claude-code-gui?color=8ae8ff&labelColor=black&style=flat-square
[github-issues-link]: https://github.com/zhukunpenglinyutong/idea-claude-code-gui/issues
[github-issues-shield]: https://img.shields.io/github/issues/zhukunpenglinyutong/idea-claude-code-gui?color=ff80eb&labelColor=black&style=flat-square
[github-license-link]: https://github.com/zhukunpenglinyutong/idea-claude-code-gui/blob/main/LICENSE
[github-stars-shield]: https://img.shields.io/github/stars/zhukunpenglinyutong/idea-claude-code-gui?color=ffcb47&labelColor=black&style=flat-square
[github-mit]: https://img.shields.io/badge/github-MIT-blue?logo=github
