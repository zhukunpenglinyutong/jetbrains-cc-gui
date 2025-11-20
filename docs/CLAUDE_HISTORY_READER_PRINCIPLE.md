# Claude Code 本地历史消息记录读取原理

---

## 概述

Claude Code 是 Cursor 编辑器内置的 AI 助手，它会将所有的对话历史记录以 **JSONL 格式**（JSON Lines）存储在本地文件系统中。通过直接读取这些文件，我们可以实现历史记录的查看、搜索和统计功能。

### 核心特点

- **本地存储**：所有数据存储在用户主目录的 `.claude` 文件夹
- **JSONL 格式**：每行一个 JSON 对象，易于追加和解析
- **项目隔离**：每个项目的会话独立存储
- **无需 API**：直接读取文件系统，无需网络请求

---

## 数据存储位置

### 1. 主目录结构

```
~/.claude/
├── history.jsonl              # 全局历史记录索引（已废弃，主要用旧版）
└── projects/                  # 项目会话目录
    ├── {sanitized-path-1}/    # 项目1的目录（路径被转义）
    │   ├── {session-id-1}.jsonl   # 会话1
    │   ├── {session-id-2}.jsonl   # 会话2
    │   └── ...
    ├── {sanitized-path-2}/    # 项目2的目录
    │   └── ...
    └── ...
```

### 2. 路径转义规则

项目路径会被转义为文件系统安全的名称：

```java
// 将所有非字母数字字符替换为 -
String sanitizedPath = projectPath.replaceAll("[^a-zA-Z0-9]", "-");
```

**示例：**
```
原始路径: /Users/john/Desktop/my-project
转义后:   -Users-john-Desktop-my-project
```

---

## 数据结构分析

### 1. history.jsonl（历史索引文件）

每行是一个 JSON 对象，记录了单条历史消息：

```json
{
  "display": "用户的消息内容",
  "pastedContents": {},
  "timestamp": 1700000000000,
  "project": "/path/to/project",
  "sessionId": "session-uuid-xxxx"
}
```

**字段说明：**
- `display`: 显示的消息内容
- `pastedContents`: 粘贴的内容（如代码片段）
- `timestamp`: Unix 时间戳（毫秒）
- `project`: 项目路径
- `sessionId`: 会话ID

### 2. 会话文件 (.jsonl)

每个会话文件包含该会话的所有消息，每行一个消息对象：

```json
{
  "uuid": "msg-uuid-xxxx",
  "sessionId": "session-uuid-xxxx",
  "parentUuid": "parent-msg-uuid",
  "timestamp": "2025-11-18T20:16:42.310Z",
  "type": "user",
  "message": {
    "role": "user",
    "content": "这是用户的消息"
  },
  "isMeta": false,
  "isSidechain": false,
  "cwd": "/path/to/project"
}
```

**字段说明：**
- `uuid`: 消息唯一标识
- `sessionId`: 所属会话ID
- `parentUuid`: 父消息ID（用于构建对话树）
- `timestamp`: ISO 8601 格式时间戳
- `type`: 消息类型（`user`、`assistant`）
- `message.content`: 消息内容（可能是字符串或数组）
- `isMeta`: 是否为元消息（系统消息）
- `isSidechain`: 是否为侧链消息

---

## 读取原理

### 核心流程图

```
┌─────────────────┐
│  获取项目路径    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  路径转义处理    │ projectPath.replaceAll("[^a-zA-Z0-9]", "-")
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 定位项目目录     │ ~/.claude/projects/{sanitized-path}/
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 遍历.jsonl文件   │ 读取目录下所有 *.jsonl 文件
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 解析JSONL格式    │ 逐行读取，每行解析为JSON对象
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 提取会话信息     │ 生成会话摘要、统计消息数
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 过滤无效会话     │ 排除 Warmup、agent-xxx 等
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 按时间排序       │ 最新的会话在前
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 返回结果数据     │ JSON格式返回给前端
└─────────────────┘
```

---

## 技术实现细节

### 1. JSONL 文件读取

```java
// 使用 BufferedReader 逐行读取
try (BufferedReader reader = Files.newBufferedReader(path)) {
    String line;
    while ((line = reader.readLine()) != null) {
        if (line.trim().isEmpty()) continue;
        
        try {
            // 使用 Gson 解析每一行
            ConversationMessage msg = gson.fromJson(line, ConversationMessage.class);
            if (msg != null) {
                messages.add(msg);
            }
        } catch (Exception e) {
            // 跳过解析失败的行
        }
    }
}
```

**关键点：**
- JSONL 格式每行是独立的 JSON，便于流式处理
- 使用 Gson 库进行 JSON 解析
- 错误容忍：单行解析失败不影响整体

### 2. 会话摘要生成

从会话消息中提取第一条用户消息作为摘要：

```java
private String generateSummary(List<ConversationMessage> messages) {
    for (ConversationMessage msg : messages) {
        if ("user".equals(msg.type) && 
            (msg.isMeta == null || !msg.isMeta) &&
            msg.message != null && 
            msg.message.content != null) {
            
            String text = extractTextFromContent(msg.message.content);
            if (text != null && !text.isEmpty()) {
                // 去除换行符并截断
                text = text.replace("\n", " ").trim();
                if (text.length() > 45) {
                    text = text.substring(0, 45) + "...";
                }
                return text;
            }
        }
    }
    return null;
}
```

**策略：**
- 查找第一条非 meta 的用户消息
- 提取文本内容（content 可能是字符串或数组）
- 截断到 45 字符，添加省略号

### 3. 时间戳处理

支持多种时间戳格式：

```java
private long parseTimestamp(String timestamp) {
    try {
        // ISO 8601 格式: "2025-11-18T20:16:42.310Z"
        java.time.Instant instant = java.time.Instant.parse(timestamp);
        return instant.toEpochMilli();
    } catch (Exception e) {
        return 0;
    }
}
```

---

## 会话过滤机制

为了提供更好的用户体验，需要过滤掉无效会话：

### 过滤规则

```java
private boolean isValidSession(String sessionId, String summary, int messageCount) {
    // 1. 过滤 agent-xxx 格式的会话（都是 Warmup）
    if (sessionId != null && sessionId.startsWith("agent-")) {
        return false;
    }
    
    // 2. 过滤摘要为空的会话
    if (summary == null || summary.isEmpty()) {
        return false;
    }
    
    // 3. 过滤 "Warmup" 或 "No prompt" 会话
    String lowerSummary = summary.toLowerCase();
    if (lowerSummary.equals("warmup") || 
        lowerSummary.equals("no prompt") ||
        lowerSummary.startsWith("warmup") ||
        lowerSummary.startsWith("no prompt")) {
        return false;
    }
    
    // 4. 过滤消息数太少的会话（少于2条）
    if (messageCount < 2) {
        return false;
    }
    
    return true;
}
```

### 过滤原因

| 类型 | 原因 | 示例 |
|------|------|------|
| `agent-xxx` | 系统内部会话 | `agent-warmup-12345` |
| 空摘要 | 无实际内容 | 只有系统消息 |
| "Warmup" | 预热会话 | 系统启动时的测试 |
| "No prompt" | 空提示 | 用户未输入内容 |
| 消息数 < 2 | 不完整对话 | 只有一条消息 |

---

## 实际应用场景

### 1. IntelliJ IDEA 插件集成

**实现类：** `VueHelloToolWindowFactorySimple.java`

```java
public VueHelloToolWindow(String projectPath) {
    this.projectPath = projectPath;
    this.historyReader = new ClaudeHistoryReader();
    
    // 获取当前项目的历史数据
    String jsonData = historyReader.getProjectDataAsJson(projectPath);
    
    // 使用 JCEF 浏览器组件渲染 HTML
    JBCefBrowser browser = new JBCefBrowser();
    String htmlContent = generateHtmlWithData(jsonData);
    browser.loadHTML(htmlContent);
}
```

**功能：**
- 在 IDE 侧边栏显示当前项目的 Claude 历史
- 实时加载，无需刷新
- Vue.js 渲染，交互流畅

### 2. Web 端历史查看器

**文件：** `claude-real-history.html`

**特点：**
- 完整的 Web UI，使用 Vue 3
- 支持搜索、过滤、导出
- 需要后端 API（Node.js 服务）

### 3. 命令行工具

```java
public static void main(String[] args) {
    ClaudeHistoryReader reader = new ClaudeHistoryReader();
    
    // 读取历史
    List<HistoryEntry> history = reader.readHistory();
    System.out.println("历史记录条数: " + history.size());
    
    // 获取项目列表
    List<ProjectInfo> projects = reader.getProjects(history);
    System.out.println("项目数: " + projects.size());
    
    // 输出 JSON
    System.out.println(reader.getAllDataAsJson());
}
```

---

## 注意事项

### ⚠️ 安全性

1. **隐私保护**：历史记录可能包含敏感信息（代码、密钥等）
2. **权限控制**：确保只有授权用户能访问
3. **数据加密**：考虑对敏感数据进行加密存储

### ⚠️ 兼容性

1. **路径差异**：
   - macOS/Linux: `~/.claude/`
   - Windows: `%USERPROFILE%\.claude\`

2. **格式变化**：Claude Code 可能更新数据格式
   - 使用错误容忍的解析方式
   - 版本检测机制

3. **文件锁定**：
   - Claude Code 可能正在写入文件
   - 使用只读模式打开
   - 实现重试机制

### ⚠️ 性能优化

1. **大文件处理**：
   ```java
   // 限制返回的消息数量
   history.size() > 200 ? history.subList(0, 200) : history
   ```

2. **异步读取**：
   ```java
   // 使用 Java 8 Stream API 并行处理
   Files.list(projectDir)
       .parallel()
       .filter(path -> path.toString().endsWith(".jsonl"))
       .forEach(path -> processFile(path));
   ```

3. **缓存机制**：
   - 缓存已读取的数据
   - 监听文件变化，增量更新

---

## 数据流示意图

```
┌──────────────────────────────────────────────────────────┐
│                    Cursor 编辑器                          │
│                                                           │
│  ┌─────────────┐                                          │
│  │ Claude AI   │  写入历史记录                            │
│  │ Assistant   │────────┐                                 │
│  └─────────────┘        │                                 │
└─────────────────────────┼─────────────────────────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │  ~/.claude/projects/  │
              │  {project}/           │
              │  ├── session1.jsonl   │
              │  ├── session2.jsonl   │
              │  └── ...               │
              └───────────────────────┘
                          │
                          │ 读取
                          │
                          ▼
              ┌───────────────────────┐
              │ ClaudeHistoryReader   │
              │  Java 读取器          │
              │  - 解析 JSONL         │
              │  - 过滤会话           │
              │  - 生成摘要           │
              └───────────────────────┘
                          │
                          │ JSON API
                          │
              ┌───────────┴───────────┐
              │                       │
              ▼                       ▼
    ┌──────────────────┐   ┌──────────────────┐
    │  IDEA 插件       │   │  Web 界面        │
    │  (JCEF Browser)  │   │  (Vue.js)        │
    │  - 嵌入式展示    │   │  - 全功能查看器   │
    └──────────────────┘   └──────────────────┘
```

---

## 示例代码

### 完整读取流程

```java
// 1. 创建读取器
ClaudeHistoryReader reader = new ClaudeHistoryReader();

// 2. 读取指定项目的会话列表
String projectPath = "/Users/john/Desktop/my-project";
List<SessionInfo> sessions = reader.readProjectSessions(projectPath);

// 3. 输出会话信息
for (SessionInfo session : sessions) {
    System.out.println("会话ID: " + session.sessionId);
    System.out.println("标题: " + session.title);
    System.out.println("消息数: " + session.messageCount);
    System.out.println("时间: " + new Date(session.lastTimestamp));
    System.out.println("---");
}

// 4. 获取 JSON 格式数据（用于前端显示）
String jsonData = reader.getProjectDataAsJson(projectPath);
System.out.println(jsonData);
```

### 输出示例

```json
{
  "success": true,
  "sessions": [
    {
      "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "title": "实现用户登录功能",
      "messageCount": 15,
      "lastTimestamp": 1700000000000,
      "firstTimestamp": 1699999000000
    },
    {
      "sessionId": "b2c3d4e5-f6g7-8901-bcde-f12345678901",
      "title": "修复数据库连接问题",
      "messageCount": 8,
      "lastTimestamp": 1699998000000,
      "firstTimestamp": 1699997000000
    }
  ],
  "currentProject": "/Users/john/Desktop/my-project",
  "total": 23,
  "sessionCount": 2
}
```

---

## 技术栈总结

| 组件 | 技术 | 用途 |
|------|------|------|
| 数据读取 | Java NIO | 文件系统操作 |
| JSON 解析 | Gson | JSON 序列化/反序列化 |
| UI 渲染 | JCEF (Chromium) | 嵌入式浏览器 |
| 前端框架 | Vue.js 3 | 响应式 UI |
| HTTP 客户端 | Axios | API 请求（Web版） |
| 数据格式 | JSONL | 行式 JSON 存储 |

---

## 扩展功能建议

### 🚀 可实现的功能

1. **全文搜索**：基于 Apache Lucene 实现
2. **数据统计**：消息数量、使用频率、时间分布
3. **导出功能**：导出为 Markdown、PDF
4. **会话恢复**：点击历史会话，在 Cursor 中恢复
5. **智能分类**：基于内容自动分类（Bug修复、功能开发等）
6. **数据同步**：跨设备同步历史记录

---

## 参考资料

- [JSONL 格式规范](http://jsonlines.org/)
- [Gson 用户指南](https://github.com/google/gson/blob/master/UserGuide.md)
- [Java NIO 文件操作](https://docs.oracle.com/javase/tutorial/essential/io/fileio.html)
- [IntelliJ Platform SDK](https://plugins.jetbrains.com/docs/intellij/welcome.html)

---

## 版本历史

| 版本 | 日期 | 变更说明 |
|------|------|----------|
| 1.0.0 | 2025-11-19 | 初始版本 |

---

**最后更新：** 2025年11月19日
