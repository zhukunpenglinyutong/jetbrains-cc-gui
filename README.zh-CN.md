<div align="center">

# IDEA Claude Code GUI 插件

<img width="120" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/idea-claude-code-gui-logo.png" />

**简体中文** · [English](./README.md) 

![][github-contributors-shield] ![][github-forks-shield] ![][github-stars-shield] ![][github-issues-shield]

</div>

这是一个IDEA插件项目，目的是为了在IDEA中可以可视化的操作Claude Code

目前在实验阶段，成品尚未完成，代码会按天更新进度，预计发布10个版本，才能达到稳定使用程度，目前版本为v0.1.0（2025年12月11日更新）

> AI声明：本项目绝大部分代码由：Claude Code，Codex，Gemini，GLM生成；本人还在学习中，非佬

<img width="850" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.1.0/2.png" />

---

## 插件下载

[IDEA Claude Code GUI 下载](https://plugins.jetbrains.com/plugin/29342-claude-code-gui)

---

### 目前进度

##### **12月21日（v0.1.1）**

- [x] 增加字体缩放功能
- [x] 增加DIFF对比功能
- [x] 增加收藏功能
- [x] 增加修改标题功能
- [x] 增加根据标题搜索历史记录功能
- [x] 修复 alwaysThinkingEnabled 失效问题

---

更多迭代进度请阅读 [CHANGELOG.md](CHANGELOG.md)

---


## 本地开发调试

### 1.安装前端依赖

```bash
cd webview
npm install
```

### 2.安装claude-bridge依赖

```bash
cd claude-bridge
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
        <div style="font-size: 20px; margin-top: 5px;">🔥🔥🔥</div>
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/M1sury">
        <img src="https://avatars.githubusercontent.com/u/64764195?size=100" width="100" height="100" alt="M1sury" style="border-radius: 50%;" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/gadfly3173">
        <img src="https://avatars.githubusercontent.com/u/28685179?size=100" width="100" height="100" alt="gadfly3173" style="border-radius: 50%; border: 3px solid #ff6b35; box-shadow: 0 0 15px rgba(255, 107, 53, 0.6);" />
        <div style="font-size: 20px; margin-top: 5px;">🔥</div>
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/song782360037">
        <img src="https://avatars.githubusercontent.com/u/66980578?size=100" width="100" height="100" alt="song782360037" style="border-radius: 50%;" />
      </a>
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
        <img src="https://avatars.githubusercontent.com/u/30894657?size=100" width="100" height="100" alt="changshunxu520" style="border-radius: 50%;" />
      </a>
    </td>
  </tr>
</table>

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