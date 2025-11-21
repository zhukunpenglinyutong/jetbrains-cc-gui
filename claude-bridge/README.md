# Claude Bridge - Claude Agent SDK Java 集成

这个目录包含用于 Java 与 Claude Agent SDK 交互的桥接代码。

## 文件说明

- `package.json` - Node.js 项目配置文件
- `simple-query.js` - 简单的 SDK 测试脚本
- `README.md` - 本说明文件

## 快速开始

### 1. 安装依赖

```bash
cd claude-bridge
npm install
```

这会安装 `@anthropic-ai/claude-agent-sdk` 包。

### 2. 配置 API Key

确保你的系统已经配置了 Anthropic API Key。有以下几种方式：

**方式 1: 通过 Claude Code CLI 登录**
```bash
claude login
```

**方式 2: 设置环境变量**
```bash
export ANTHROPIC_API_KEY=your_api_key_here
```

**方式 3: 在项目目录创建 `.claude/settings.json`**
```json
{
  "apiKey": "your_api_key_here"
}
```

### 3. 测试 Node.js 脚本

```bash
# 使用默认提示词
node simple-query.js

# 使用自定义提示词
node simple-query.js "计算 2+2 等于多少？"
```

### 4. 从 Java 运行测试

在 IDEA 中运行 `ClaudeSDKTest.java`：

```bash
# 或使用命令行编译运行
cd ..
javac -cp ".:lib/gson-2.10.1.jar" src/main/java/com/github/claudecodegui/ClaudeSDKTest.java
java -cp ".:lib/gson-2.10.1.jar:src/main/java" com.github.claudecodegui.ClaudeSDKTest
```

## 工作原理

1. **Node.js 脚本** (`simple-query.js`)
   - 使用 `@anthropic-ai/claude-agent-sdk` 的 `query()` 函数
   - 接收命令行参数作为提示词
   - 实时输出 SDK 返回的消息
   - 最后输出 JSON 格式的完整结果（方便 Java 解析）

2. **Java 测试类** (`ClaudeSDKTest.java`)
   - 使用 `ProcessBuilder` 启动 Node.js 进程
   - 执行 `simple-query.js` 脚本
   - 捕获标准输出并解析结果
   - 提取 JSON 格式的结果数据

## SDK 配置说明

在 `simple-query.js` 中，我们使用了以下配置：

```javascript
{
  permissionMode: 'bypassPermissions',  // 绕过权限检查
  model: 'sonnet',                       // 使用 Sonnet 模型
  maxTurns: 1,                          // 限制为 1 轮对话
  settingSources: []                    // 不加载文件系统设置
}
```

这是最简单的配置，适合快速测试。你可以根据需要调整这些参数。

## 常见问题

### Q: 出现 "Node.js 未安装" 错误
A: 请安装 Node.js (推荐 v18 或更高版本): https://nodejs.org/

### Q: 出现 "node_modules 不存在" 错误
A: 请先在 claude-bridge 目录运行 `npm install`

### Q: 出现 API Key 相关错误
A: 确保已通过以下方式之一配置 API Key：
   - 运行 `claude login`
   - 设置 `ANTHROPIC_API_KEY` 环境变量
   - 创建 `.claude/settings.json` 文件

### Q: 如何查看详细日志？
A: Node.js 脚本会输出详细的执行日志，包括每条消息的类型和内容

## 下一步

测试成功后，你可以：

1. 在 Java 中封装更完整的 SDK 调用类
2. 添加异步处理和流式响应支持
3. 实现更复杂的对话管理功能
4. 集成到 IDEA 插件的 GUI 中

## 参考文档

- [Claude Agent SDK 文档](../docs/claude-agent-sdk.md)
- [Claude Code 官方文档](https://docs.claude.com/en/docs/claude-code)
