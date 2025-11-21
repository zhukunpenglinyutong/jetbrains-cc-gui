# IDEA版 Claude Code GUI 插件

本项目主要解决在IDEA中使用Claude Code 没有 GUI操作窗口的场景

目前在实验阶段，成品尚未完成，代码会按天更新进度，目前版本为v0.0.2

> AI声明：本项目绝大部分代码由：Claude Code，Codex，Gemini，GLM生成；本人还在学习中，非佬

---

插件使用方式
```sh
# 1.下载 idea-claude-code-gui-0.0.2.zip 文件

# 2.IDEA - 设置 - 插件 - 从磁盘安装插件 - 选择下载的idea-claude-code-gui-0.0.2.zip 即可
```

插件下载：[idea-claude-code-gui-0.0.2.zip](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/blob/main/idea-claude-code-gui-0.0.2.zip)

---

### 目前进度

**11月21日（v0.0.2）**

> 安装包：[idea-claude-code-gui-0.0.2.zip](https://github.com/zhukunpenglinyutong/idea-claude-code-gui/blob/main/idea-claude-code-gui-0.0.2.zip)

完成简易的，GUI对话 权限控制功能
<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/5.png" />

文件写入功能展示
<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/6.png" />


**11月20日**

完成简易的，GUI对话基础页面
<img width="300" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/2.png" />

完成简易的，GUI对话页面，历史消息渲染功能
<img width="300" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/3.png" />

完成简易的，GUI页面，对话 + 回复 功能（**完成 claude-bridge 核心**）
<img width="300" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/4.png" />


**11月19日（v0.0.1）** - 实现历史记录读取功能

> 安装包：[idea-claude-code-gui-0.0.1.zip](https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.1/idea-claude-code-gui-0.0.1.zip)

<img width="400" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/1.png" />

---


## 本地开发调试

### 1. 安装Node依赖

```bash
cd claude-bridge
pnpm install
```

### 2. 构建插件

```bash
./gradlew build
```

### 3. 运行测试

```bash
cd claude-bridge
./test-integration.sh
```

### 4. 启动插件

在 IDEA 中运行：
```bash
./gradlew runIde
```

### 5.构建插件

```sh
./gradlew buildPlugin

# 生成的插件包会在 build/distributions/ 目录下（包体大约40MB）
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
