<div align="center">

# IDEA Claude Code GUI 插件

<img width="120" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/idea-claude-code-gui-logo.png" />

**简体中文** · [English](./README.md)

![][github-contributors-shield] ![][github-forks-shield] ![][github-stars-shield] ![][github-issues-shield]

</div>

一个功能强大的 IntelliJ IDEA 插件，为开发者提供 **Claude Code** 和 **OpenAI Codex** 双 AI 工具的可视化操作界面，让 AI 辅助编程变得更加高效和直观。

> AI 声明：本项目绝大部分代码由 Claude Code、Codex、Gemini、GLM 生成；本人还在学习中，非佬

<img width="850" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.1.0/2.png" />

---

## 核心特性

### 双 AI 引擎支持
- **Claude Code** - Anthropic 官方 AI 编程助手，支持 Opus 4.5 等多模型
- **OpenAI Codex** - OpenAI 强大的代码生成引擎

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

当前版本：**v0.1.5**（2026年1月18日更新）

本次为最大的一次版本更新：113个文件改动，30次commit，新增代码13.6k，删除代码4.7k

本次修改内容如下：

- [x] P0（feat）Claude 计划模式 开放
- [x] P0（fix）修复了 AskUserQuestion 弹窗异常问题
- [x] P0（perf）优化了历史记录过多时候，输入框输入卡顿以及发送卡顿问题
- [x] P0（fix）彻底解决了 Codex window下无法写入的问题
- [x] P0（feat）支持了 Codex MCP功能
- [x] P0（feat）支持了 Codex的AGENTS.md指令集合
- [x] P1（feat）支持了 Codex自动注入当前活动文件内容
- [x] P1（feat）按当前项目路径过滤Codex会话历史（之前是全都展示）
- [x] P1（feat）实现todolist新UI交互
- [x] P1（feat）实现 批量写入 和 批量读取 新交互
- [x] P1（feat）流式输出时自动展开最新的思考块
- [x] P1（refactor）拆分重构了输入框和对话过程的代码，使其后续更易维护
- [x] P2（chore）预留了OpenCode支持
- [x] P2（style）修改其他细节交互舒适性

接下来将进行v0.1.6版本的开发

v0.1.6版本，将带来更多功能，更好的性能 和 大家心心念念的 vscode端 和 客户端；

项目处于活跃开发阶段，代码持续更新中。更多迭代进度请阅读 [CHANGELOG.md](CHANGELOG.md)

---

## 插件下载

[IDEA Claude Code GUI 下载](https://plugins.jetbrains.com/plugin/29342-claude-code-gui)

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

AGPL-3.0

---

## 贡献者列表

感谢所有帮助 IDEA-Claude-Code-GUI 变得更好的贡献者！

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/zhukunpenglinyutong">
        <img src="https://avatars.githubusercontent.com/u/31264015?size=100" width="100" height="100" alt="zhukunpenglinyutong" style="border-radius: 50%; border: 3px solid #ff6b35; box-shadow: 0 0 15px rgba(255, 107, 53, 0.6);" />
      </a>
      <div>🔥🔥🔥</div>
    </td>
    <td align="center">
      <a href="https://github.com/M1sury">
        <img src="https://avatars.githubusercontent.com/u/64764195?size=100" width="100" height="100" alt="M1sury" style="border-radius: 50%;" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/gadfly3173">
        <img src="https://avatars.githubusercontent.com/u/28685179?size=100" width="100" height="100" alt="gadfly3173" style="border-radius: 50%; border: 3px solid #ff6b35; box-shadow: 0 0 15px rgba(255, 107, 53, 0.6);" />
      </a>
      <div">🔥🔥</div>
    </td>
    <td align="center">
      <a href="https://github.com/song782360037">
        <img src="https://avatars.githubusercontent.com/u/66980578?size=100" width="100" height="100" alt="song782360037" style="border-radius: 50%;" />
      </a>
      <div">🔥</div>
    </td>
    <td align="center">
      <a href="https://github.com/hpstream">
        <img src="https://avatars.githubusercontent.com/u/18394192?size=100" width="100" height="100" alt="hpstream" style="border-radius: 50%;" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/imblowsnow">
        <img src="https://avatars.githubusercontent.com/u/74449531?size=100" width="100" height="100" alt="imblowsnow" style="border-radius: 50%;" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/Rinimabi">
        <img src="https://avatars.githubusercontent.com/u/18625271?size=100" width="100" height="100" alt="Rinimabi" style="border-radius: 50%;" />
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/GotoFox">
        <img src="https://avatars.githubusercontent.com/u/68596145?size=100" width="100" height="100" alt="GotoFox" style="border-radius: 50%;" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/changshunxu520">
        <img src="https://avatars.githubusercontent.com/u/16171624?size=100" width="100" height="100" alt="changshunxu520" style="border-radius: 50%;" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/lie5860">
        <img src="https://avatars.githubusercontent.com/u/30894657?size=100" width="100" height="100" alt="lie5860" style="border-radius: 50%;" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/buddhist-coder">
        <img src="https://avatars.githubusercontent.com/u/61658071?size=100" width="100" height="100" alt="buddhist-coder" style="border-radius: 50%;" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/LaCreArthur">
        <img src="https://avatars.githubusercontent.com/u/14138307?size=100" width="100" height="100" alt="LaCreArthur" style="border-radius: 50%;" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/dungnguyent8">
        <img src="https://avatars.githubusercontent.com/u/39462756?size=100" width="100" height="100" alt="dungnguyent8" style="border-radius: 50%;" />
      </a>
      <div>🔥</div>
    </td>
    <td align="center">
      <a href="https://github.com/magic5295">
        <img src="https://avatars.githubusercontent.com/u/157901486?size=100" width="100" height="100" alt="magic5295" style="border-radius: 50%;" />
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/JackWPP">
        <img src="https://avatars.githubusercontent.com/u/120316122?size=100" width="100" height="100" alt="JackWPP" style="border-radius: 50%;" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/luhua-123">
        <img src="https://avatars.githubusercontent.com/u/83643600?size=100" width="100" height="100" alt="luhua-123" style="border-radius: 50%;" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/geofqiu-hub">
        <img src="https://avatars.githubusercontent.com/u/248376932?size=100" width="100" height="100" alt="geofqiu-hub" style="border-radius: 50%;" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/1lck">
        <img src="https://avatars.githubusercontent.com/u/159525154?size=100" width="100" height="100" alt="1lck" style="border-radius: 50%;" />
      </a>
    </td>
  </tr>
</table>

---

## 赞助支持

如果这个项目对你有帮助，欢迎赞助支持，你的支持是我持续维护的动力！

<table>
  <tr>
    <td align="center">
      <img src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/zfb.jpg" width="200" alt="支付宝">
      <br>
      <b>支付宝</b>
    </td>
    <td align="center">
      <img src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/wx.jpg" width="200" alt="微信">
      <br>
      <b>微信</b>
    </td>
    <td align="center">
      <img src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/paypal.png" width="200" alt="PayPal">
      <br>
      <b>PayPal</b>
    </td>
  </tr>
</table>

### 赞助者列表

感谢以下赞助者的支持 ❤️

<!-- SPONSORS:START -->
| 名称 | 金额 | 日期 |
|------|------|------|
| 虚位以待 | - | - |
<!-- SPONSORS:END -->

> 无论多少金额，我会将你添加到赞助者列表中，感谢各位的支持

---

## Star History

[![Star History](https://api.star-history.com/svg?repos=zhukunpenglinyutong/idea-claude-code-gui&type=date&legend=top-left)](https://www.star-history.com/#zhukunpenglinyutong/idea-claude-code-gui&type=date&legend=top-left)

<!-- LINK GROUP -->

[github-contributors-shield]: https://img.shields.io/github/contributors/zhukunpenglinyutong/idea-claude-code-gui?color=c4f042&labelColor=black&style=flat-square
[github-forks-shield]: https://img.shields.io/github/forks/zhukunpenglinyutong/idea-claude-code-gui?color=8ae8ff&labelColor=black&style=flat-square
[github-issues-link]: https://github.com/zhukunpenglinyutong/idea-claude-code-gui/issues
[github-issues-shield]: https://img.shields.io/github/issues/zhukunpenglinyutong/idea-claude-code-gui?color=ff80eb&labelColor=black&style=flat-square
[github-license-link]: https://github.com/zhukunpenglinyutong/idea-claude-code-gui/blob/main/LICENSE
[github-stars-shield]: https://img.shields.io/github/stars/zhukunpenglinyutong/idea-claude-code-gui?color=ffcb47&labelColor=black&style=flat-square