<div align="center">

# IDEA Claude Code GUI 插件

<img width="120" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/idea-claude-code-gui-logo.png" />

**简体中文** · [English](./README.md) 

![][github-contributors-shield] ![][github-forks-shield] ![][github-stars-shield] ![][github-issues-shield]

</div>

这是一个IDEA插件项目，目的是为了在IDEA中可以可视化的操作Claude Code

目前在实验阶段，成品尚未完成，代码会按天更新进度，预计发布10个版本，才能达到稳定使用程度，目前版本为v0.0.9-feat1（2025年12月6日更新）

> AI声明：本项目绝大部分代码由：Claude Code，Codex，Gemini，GLM生成；本人还在学习中，非佬

<img width="350" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.7/1.png" />

---

插件使用方式
```sh
# 1.下载 idea-claude-code-gui-0.0.9-beta1.zip 文件

# 2.IDEA - 设置 - 插件 - 从磁盘安装插件 - 选择下载的idea-claude-code-gui-0.0.9-beta1.zip 即可
```

插件下载：[idea-claude-code-gui-0.0.9-beta1.zip](https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.9/idea-claude-code-gui-0.0.9-beta1.zip)

---

### 目前进度

##### **12月8日（v0.0.9-beta1）**

- [x] P0（feat）实现从cc-switch导入供应商配置的功能
- [x] P0（fix）解决在某些特定情况下，异常覆盖.claude/setting.json为官方默认配置的问题
- [x] P1（feat）首次非常细化，重构 供应商页面 UI交互

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

## Star History

[![Star History](https://api.star-history.com/svg?repos=zhukunpenglinyutong/idea-claude-code-gui&type=date&legend=top-left)](https://www.star-history.com/#zhukunpenglinyutong/idea-claude-code-gui&type=date&legend=top-left)

<!-- LINK GROUP -->

[github-contributors-shield]: https://img.shields.io/github/contributors/zhukunpenglinyutong/idea-claude-code-gui?color=c4f042&labelColor=black&style=flat-square
[github-forks-shield]: https://img.shields.io/github/forks/zhukunpenglinyutong/idea-claude-code-gui?color=8ae8ff&labelColor=black&style=flat-square
[github-issues-link]: https://github.com/zhukunpenglinyutong/idea-claude-code-gui/issues
[github-issues-shield]: https://img.shields.io/github/issues/zhukunpenglinyutong/idea-claude-code-gui?color=ff80eb&labelColor=black&style=flat-square
[github-license-link]: https://github.com/zhukunpenglinyutong/idea-claude-code-gui/blob/main/LICENSE
[github-stars-shield]: https://img.shields.io/github/stars/zhukunpenglinyutong/idea-claude-code-gui?color=ffcb47&labelColor=black&style=flat-square