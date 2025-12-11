<div align="center">

# IDEA Claude Code GUI 插件

<img width="120" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/idea-claude-code-gui-logo.png" />

**简体中文** · [English](./README.md) 

![][github-contributors-shield] ![][github-forks-shield] ![][github-stars-shield] ![][github-issues-shield]

</div>

这是一个IDEA插件项目，目的是为了在IDEA中可以可视化的操作Claude Code

目前在实验阶段，成品尚未完成，代码会按天更新进度，预计发布10个版本，才能达到稳定使用程度，目前版本为v0.1.0（2025年12月11日更新）

> AI声明：本项目绝大部分代码由：Claude Code，Codex，Gemini，GLM生成；本人还在学习中，非佬

<img width="300" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.1.0/1.png" />

<img width="850" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.1.0/2.png" />
---


插件下载地址：[idea-claude-code-gui-0.1.0.zip](https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.1.0/idea-claude-code-gui-0.1.0.zip)

插件使用方式

```sh
# 1.下载 idea-claude-code-gui-0.1.0.zip 文件

# 2.IDEA - 设置 - 插件 - 从磁盘安装插件 - 选择下载的idea-claude-code-gui-0.1.0.zip 即可
```

---

### 目前进度

##### **12月11日（v0.1.0）**

- [x] P0（feat）实现当前打开的文件路径（将当前打开的文件信息默认发送给AI）
- [x] P0（feat）实现国际化功能
- [x] P0（feat）重构供应商管理列表，支持导入cc-switch配置
- [x] P0（bug）解决一个困扰很久的，配置信息报错阻塞问题
- [x] P1（feat）实现文件支持拖拽入输入框的功能（#gadfly3173 PR）
- [x] P1（feat）增加删除历史会话功能（由群友 PR）
- [x] P1（feat）增加Skills功能（由群友 PR）
- [x] P1（feat）增加右键选中代码，发送到插件的功能（#lxm1007 PR）
- [x] P1（fix）完善和重构 @文件功能，使@文件功能变得好用
- [x] P2（fix）解决输入框部分快捷操作失效的问题

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

## Contributing

感谢所有帮助 IDEA-Claude-Code-GUI 变得更好的贡献者！

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/claude">
        <img src="https://avatars.githubusercontent.com/u/81847?size=100" width="100" height="100" alt="bhaktatejas922" style="border-radius: 50%;" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/openai/codex">
        <img src="https://avatars.githubusercontent.com/u/14957082?size=100" width="100" height="100" alt="bhaktatejas922" style="border-radius: 50%;" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/zhukunpenglinyutong">
        <img src="https://avatars.githubusercontent.com/u/31264015?size=100" width="100" height="100" alt="mcowger" style="border-radius: 50%;" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/M1sury">
        <img src="https://avatars.githubusercontent.com/u/64764195?size=100" width="100" height="100" alt="bhaktatejas922" style="border-radius: 50%;" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/gadfly3173">
        <img src="https://avatars.githubusercontent.com/u/28685179?size=100" width="100" height="100" alt="bhaktatejas922" style="border-radius: 50%;" />
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