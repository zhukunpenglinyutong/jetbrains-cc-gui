# Commit 生成进度增强功能设计文档

**版本**: v0.4.1
**日期**: 2026-05-02
**状态**: 设计中

## 1. 概述

### 1.1 背景

在 `feature/v0.4.1-commit-progress` 分支中，新增了 commit message 生成进度显示功能，包括：
- 进度对话框 `CommitGenerationProgressDialog`
- 系统通知取消功能
- 输入框内进度显示

但当前实现缺少对**当前使用模型**的显示，用户无法知道生成时使用的是哪个 AI 模型。

### 1.2 目标

在 commit message 生成过程中，**同时显示**模型信息：
1. **Commit 输入框进度文本**：显示计时器和详细格式模型信息
2. **进度对话框**：显示模型名称、计时器、进度条和取消按钮

### 1.3 范围

- 修改 `GitCommitMessageService`：添加获取模型信息的方法
- 修改 `GenerateCommitMessageAction`：在两处显示模型信息
- 启用 `CommitGenerationProgressDialog`（已存在但未使用）
- 添加国际化支持

## 2. 架构设计

### 2.1 组件关系图

```
┌─────────────────────────────────────────────────────────┐
│                   GenerateCommitMessageAction            │
│  (用户点击生成按钮的入口)                                  │
├─────────────────────────────────────────────────────────┤
│  1. 获取模型信息 (provider + model name)                 │
│  2. 启动 CommitGenerationProgressDialog (非阻塞显示)     │
│  3. 更新 commit 输入框进度文本                           │
│  4. 保留系统通知取消功能                                 │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│              GitCommitMessageService                     │
│  (负责生成 commit message)                               │
├─────────────────────────────────────────────────────────┤
│  • getFormattedModelInfo(): 返回 "model (Provider)"     │
│  • getModelDisplayText(): 返回带图标的完整显示文本        │
│  • CommitMessageCallback.onGenerationStart()            │
└─────────────────────────────────────────────────────────┘
                            │
          ┌─────────────────┴─────────────────┐
          ▼                                   ▼
┌──────────────────────┐         ┌──────────────────────┐
│ CommitGeneration     │         │  Commit 输入框        │
│ ProgressDialog       │         │  (进度文本显示)       │
│  - 模型名称           │         │  - 模型信息 + 计时    │
│  - 计时器             │         │  - 实时更新           │
│  - 进度条             │         │                      │
│  - 取消按钮           │         │                      │
└──────────────────────┘         └──────────────────────┘
```

### 2.2 数据流

```
用户点击 "Generate Commit Message" 按钮
                  │
                  ▼
    ┌─────────────────────────────┐
    │ 1. 读取 AI 配置              │
    │    - effectiveProvider       │
    │    - models.{provider}       │
    └─────────────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────┐
    │ 2. 格式化模型信息            │
    │    "claude-sonnet-4.5 (Claude)" │
    └─────────────────────────────┘
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
┌───────────────┐   ┌───────────────┐
│ 显示进度对话框 │   │ 更新输入框文本 │
│ 显示模型信息   │   │ 显示模型+计时  │
└───────────────┘   └───────────────┘
        │                   │
        └─────────┬─────────┘
                  ▼
    ┌─────────────────────────────┐
    │ 3. 调用 AI API 生成         │
    │    - onProgress() 回调      │
    └─────────────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────┐
    │ 4. 完成或取消               │
    │    - 关闭进度对话框         │
    │    - 显示生成结果           │
    │    - 或显示重试通知         │
    └─────────────────────────────┘
```

## 3. 组件设计

### 3.1 GitCommitMessageService

**职责**: 提供获取模型信息的方法

#### 新增方法

```java
/**
 * 获取格式化的模型信息（不含图标）
 * @return 格式如 "claude-sonnet-4.5 (Claude)"
 * @throws IOException 如果读取配置失败
 */
public @NotNull String getFormattedModelInfo() throws IOException

/**
 * 获取用于显示的模型信息（含图标）
 * @return 格式如 "🤖 使用模型: claude-sonnet-4.5 (Claude)"
 * @throws IOException 如果读取配置失败
 */
public @NotNull String getModelDisplayText() throws IOException

/**
 * 获取 Provider 的显示名称
 * @param provider 内部 provider 标识 (claude/codex)
 * @return 显示名称 (Claude/Codex)
 */
public @NotNull String getProviderDisplayName(@NotNull String provider)
```

#### 修改回调接口

```java
public interface CommitMessageCallback {
    /**
     * 生成开始时调用，传递模型信息
     * @param modelInfo 格式化的模型信息，如 "claude-sonnet-4.5 (Claude)"
     */
    default void onGenerationStart(@NotNull String modelInfo) {
        // 默认空实现，保持向后兼容
    }

    /**
     * 生成过程中调用（已存在）
     */
    default void onProgress(@NotNull String partialMessage) {
        // 默认空实现
    }

    void onSuccess(@NotNull String commitMessage);
    void onError(@NotNull String error);
}
```

### 3.2 GenerateCommitMessageAction

**职责**: 协调进度显示和生成流程

#### 修改 startGeneration() 方法

```java
private void startGeneration(
        @NotNull Project project,
        @NotNull CommitMessageI commitMessagePanel,
        @NotNull Collection<Change> changes,
        @NotNull Notification[] notificationHolder) {

    // 1. 获取模型信息
    final String[] modelInfo = {""};
    try {
        GitCommitMessageService tempService = new GitCommitMessageService(project);
        modelInfo[0] = tempService.getModelDisplayText();
    } catch (Exception e) {
        LOG.warn("Failed to get model info", e);
        modelInfo[0] = ClaudeCodeGuiBundle.message("commit.progress.unknownModel");
    }

    // 2. 启动进度对话框（非阻塞）
    final CommitGenerationProgressDialog[] dialogHolder = {null};
    ApplicationManager.getApplication().invokeLater(() -> {
        // 提取纯模型名称（去掉图标和前缀）
        String pureModelName = extractPureModelName(modelInfo[0]);
        dialogHolder[0] = new CommitGenerationProgressDialog(project, pureModelName);
        // 在后台线程显示对话框，避免阻塞
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            dialogHolder[0].start();
        });
    });

    // 3. 设置初始状态（输入框）
    final String[] lastProgressMessage = {""};
    final boolean[] hasValidCommit = {false};
    final boolean[] isCancelled = {false};

    ApplicationManager.getApplication().invokeLater(() -> {
        String initialStatus = modelInfo[0] + "\n\n" +
                               ClaudeCodeGuiBundle.message("commit.progress.initializing") + "...";
        lastProgressMessage[0] = initialStatus;
        commitMessagePanel.setCommitMessage(initialStatus);
    });

    // ... 其余生成逻辑保持不变，但在进度更新时添加模型信息
}
```

#### 进度更新格式

输入框中的进度文本格式：
```
🤖 使用模型: claude-sonnet-4.5 (Claude)

正在初始化...

请稍候，通常需要 10-30 秒
⏱ 00:05
```

### 3.3 CommitGenerationProgressDialog

**职责**: 显示进度对话框（已存在，无需修改）

当前实现已包含：
- 模型名称显示（第一行）
- 状态消息
- 进度条
- 计时器
- 取消按钮

### 3.4 国际化

**新增翻译 key**（在所有语言文件中）：

```properties
# ClaudeCodeGuiBundle_zh.properties
commit.progress.unknownModel=未知模型
commit.progress.modelInfo=🤖 使用模型: {0} ({1})
commit.progress.provider.claude=Claude
commit.progress.provider.codex=Codex
```

```properties
# ClaudeCodeGuiBundle_en.properties
commit.progress.unknownModel=Unknown Model
commit.progress.modelInfo=🤖 Model: {0} ({1})
commit.progress.provider.claude=Claude
commit.progress.provider.codex=Codex
```

## 4. 错误处理

### 4.1 获取模型信息失败

| 场景 | 处理方式 |
|------|----------|
| 配置读取异常 | 显示 "未知模型" |
| Provider 为空 | 显示 "未知模型" |
| Model 为空 | 显示 Provider 名称 |

### 4.2 对话框显示失败

| 场景 | 处理方式 |
|------|----------|
| 创建对话框失败 | 降级为仅显示输入框进度 |
| 显示线程异常 | 记录日志，不影响生成流程 |

### 4.3 用户取消

1. 停止计时器
2. 关闭进度对话框
3. 显示重试通知（已存在功能）

## 5. 测试要点

### 5.1 功能测试

- [ ] 模型信息正确显示在输入框中
- [ ] 模型信息正确显示在进度对话框中
- [ ] 计时器正常工作
- [ ] 取消功能正常
- [ ] 重试功能正常
- [ ] Claude 和 Codex 两种 provider 都能正确显示

### 5.2 边界测试

- [ ] 无法获取模型配置时的降级显示
- [ ] 对话框创建失败时的降级行为
- [ ] 快速连续点击生成按钮的处理

### 5.3 国际化测试

- [ ] 所有语言的翻译正确显示
- [ ] 模型名称包含特殊字符时正确转义

## 6. 性能考虑

- 模型信息读取使用缓存（配置不变时）
- 对话框在后台线程显示，不阻塞主线程
- 进度更新限制为每秒一次，避免过度刷新

## 7. 未来扩展

- 支持用户选择显示方式（仅对话框 / 仅输入框 / 两者都显示）
- 支持自定义模型信息显示格式
- 记录生成历史（模型 + 时间）
