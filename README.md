# IDEA版 Claude Code GUI 插件

本项目主要解决在IDEA中使用Claude Code 没有 GUI操作窗口的场景

目前在实验阶段，成品尚未完成，代码会按天更新进度

> AI声明：本项目绝大部分代码由：Claude Code，Codex，Gemini，GLM生成

## 功能特性

### 1. 历史会话查看器
- 查看本地 Claude Code 历史会话
- 按项目分组显示
- 实时加载历史数据

### 2. Claude Code GUI - 实时对话 ⭐ 新功能
- 🤖 实时与 Claude 对话
- ⚡ 异步流式响应
- 💬 支持多轮对话
- 🎨 现代化聊天界面
- 🔧 自动读取配置

## 快速开始

### 1. 安装依赖

```bash
cd claude-bridge
npm install
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

或安装构建好的插件包：`build/distributions/idea-claude-code-gui-0.0.1.zip`

## claude-bridge 目录与配置

- **默认位置**：将完整的 `claude-bridge/`（包含 `node_modules/`）放在插件工程根目录 `idea-claude-code-gui/claude-bridge`。
- **构建打包**：运行 `./gradlew runIde` 或 `./gradlew buildPlugin` 时，Gradle 会自动把该目录拷贝到 sandbox 及插件 zip 内（含所有 JS 依赖），请先执行 `cd claude-bridge && npm install`。
- **可配置路径**：若目录放在其他位置，可通过系统属性 `-Dclaude.bridge.path=/absolute/path/to/claude-bridge` 或环境变量 `CLAUDE_BRIDGE_PATH` 指定，优先级最高。
- **自动探测**：运行时会尝试插件安装目录、sandbox 目录、类路径附近目录以及当前项目/父目录，日志会列出所有候选路径以便排查。
- **发布策略**：如需缩小安装包，可在构建前清理 `claude-bridge` 或要求用户配置 `CLAUDE_BRIDGE_PATH`；默认构建会内置整套依赖，体积约 100MB+。

## 使用方法

1. 打开 IDEA
2. 在右侧工具栏找到 **Claude Code GUI** 窗口
3. 输入消息并发送
4. 等待 Claude 的回复

详细文档：[SDK 集成指南](docs/SDK-Integration-Guide.md)

### 目前进度

**2025年11月19日** - 实现历史记录读取功能

安装包：[idea-claude-code-gui-0.0.1.zip](https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.1/idea-claude-code-gui-0.0.1.zip)

<img width="400" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.1/1.png" />

**2025年11月20日** - ✅ 完成 Java 与 Claude Agent SDK 集成

新增功能：
- ✅ Claude SDK 集成完成
- ✅ 实时聊天界面
- ✅ 支持多轮对话
- ✅ 流式响应显示
- ✅ 异步消息处理
- ✅ 自动读取 `~/.claude/settings.json` 配置
- ✅ 支持自定义代理服务器



### 构建插件

```sh
./gradlew buildPlugin

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
