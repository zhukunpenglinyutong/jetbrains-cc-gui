# IDEA版 Claude Code GUI 插件

本项目主要解决在IDEA中使用Claude Code 没有 GUI操作窗口的场景

目前在实验阶段，成品尚未完成，代码会按天更新进度

### 目前进度

2025年11月19日 实现历史记录读取功能

安装包：[idea-claude-code-gui-0.0.1.zip](https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.1/idea-claude-code-gui-0.0.1.zip)

<img width="400" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.1/1.png" />

2025年11月20日 攻关JAVA 与 @anthropic-ai/claude-agent-sdk 交互问题



### 构建插件

```sh
 ./gradlew build

# 生成的插件包会在 build/distributions/ 目录下
```

### 开发环境

```
IntelliJ IDEA 2025.2.4 (Ultimate Edition)
Build #IU-252.27397.103, built on October 23, 2025
Source revision: 9b31ba2c05b47
Runtime version: 21.0.8+9-b1038.73 aarch64 (JCEF 122.1.9)
VM: OpenJDK 64-Bit Server VM by JetBrains s.r.o.
Toolkit: sun.lwawt.macosx.LWCToolkit
macOS 15.3.1
GC: G1 Young Generation, G1 Concurrent GC, G1 Old Generation
Memory: 2048M
Cores: 12
Metal Rendering is ON
Registry:
  ide.experimental.ui=true
  llm.selector.config.refresh.interval=10
  llm.rules.refresh.interval=10
Non-Bundled Plugins:
  com.luomacode.ChatMoss (7.1.2)
  com.anthropic.code.plugin (0.1.12-beta)
  com.intellij.ml.llm (252.27397.144)
  com.example.claudeagent (1.0-SNAPSHOT)
Kotlin: 252.27397.103-IJ
```
