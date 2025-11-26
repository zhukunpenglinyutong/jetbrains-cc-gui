# IDEA版 Claude Code GUI 插件

本项目主要解决在IDEA中使用Claude Code 没有 GUI操作窗口的场景

目前在实验阶段，成品尚未完成，代码会按天更新进度，预计发布10个版本，才能达到稳定使用程度，目前版本为v0.0.4-beta

> AI声明：本项目绝大部分代码由：Claude Code，Codex，Gemini，GLM生成；本人还在学习中，非佬

<img width="600" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.3/2.png" />

---

插件使用方式
```sh
# 1.下载 idea-claude-code-gui-0.0.5-beta 文件

# 2.IDEA - 设置 - 插件 - 从磁盘安装插件 - 选择下载的idea-claude-code-gui-0.0.5-beta 即可
```

插件下载：[idea-claude-code-gui-0.0.5-beta.zip](https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.5/idea-claude-code-gui-0.0.5-beta.zip)

---

### 目前进度

##### **11月26日（v0.0.5）**

- [x] 增加使用统计
- [x] 解决Window下新建问题按钮失效问题
- [x] 优化一些细节样式

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.5/1.png" />


##### **11月24日（v0.0.4）**

- [x] 实现简易版本cc-switch功能
- [x] 解决一些小的交互问题

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.4/1.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.4/2.png" />


##### **11月23日（v0.0.3）**

- [x] 解决一些核心交互阻塞流程
- [x] 重构交互页面UI展示

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.3/1.png" />


##### **11月22日**

- [x] 改进临时目录与权限逻辑
- [x] 拆分纯html，采用 Vite + React + TS 开发
- [x] 将前端资源CDN下载本地打包，加快首屏速度


##### **11月21日（v0.0.2）**

完成简易的，GUI对话 权限控制功能

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/5.png" />

文件写入功能展示

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/6.png" />


##### 11月20日

完成简易的，GUI对话基础页面

<img width="300" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/2.png" />

完成简易的，GUI对话页面，历史消息渲染功能

<img width="300" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/3.png" />

完成简易的，GUI页面，对话 + 回复 功能（**完成 claude-bridge 核心**）

<img width="300" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/4.png" />


##### 11月19日（v0.0.1） - 实现历史记录读取功能

<img width="400" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/1.png" />

---


## 本地开发调试

### 0. Webview 前端（Vite + React）

插件内嵌的聊天界面已经迁移到 `webview/` 目录，使用 Vite + React + TypeScript 进行组件化开发。

```bash
cd webview
npm install          # 首次安装依赖
npm run dev          # 本地开发预览（会启动 Vite Dev Server）
npm run build        # 生成 dist/index.html 并自动同步到 src/main/resources/html/claude-chat.html
```

> `npm run build` 会自动执行 `scripts/copy-dist.mjs`，将打包结果复制到插件资源目录，IDEA 中的 JCEF 会直接加载这份纯静态 HTML。

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
