# Commit 生成进度增强功能实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 commit message 生成过程中，同时显示当前使用的 AI 模型信息（输入框进度文本 + 进度对话框）

**架构：** 通过 `GitCommitMessageService` 提供模型信息获取方法，在 `GenerateCommitMessageAction` 中获取并显示模型信息，同时启用已存在的 `CommitGenerationProgressDialog`

**技术栈：** Java 17, IntelliJ Platform Plugin SDK, ResourceBundle 国际化

---

## 文件结构

### 将要创建或修改的文件：

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/main/java/com/github/claudecodegui/service/GitCommitMessageService.java` | 提供 commit 生成服务，新增获取模型信息的方法 | 修改 |
| `src/main/java/com/github/claudecodegui/action/vcs/GenerateCommitMessageAction.java` | 处理生成按钮点击，协调进度显示 | 修改 |
| `src/main/resources/messages/ClaudeCodeGuiBundle_zh.properties` | 中文翻译 | 修改 |
| `src/main/resources/messages/ClaudeCodeGuiBundle_en.properties` | 英文翻译 | 修改 |
| `src/main/resources/messages/ClaudeCodeGuiBundle_es.properties` | 西班牙语翻译 | 修改 |
| `src/main/resources/messages/ClaudeCodeGuiBundle_fr.properties` | 法语翻译 | 修改 |
| `src/main/resources/messages/ClaudeCodeGuiBundle_hi.properties` | 印地语翻译 | 修改 |
| `src/main/resources/messages/ClaudeCodeGuiBundle_ja.properties` | 日语翻译 | 修改 |
| `src/main/resources/messages/ClaudeCodeGuiBundle_ru.properties` | 俄语翻译 | 修改 |
| `src/main/resources/messages/ClaudeCodeGuiBundle_zh_TW.properties` | 繁体中文翻译 | 修改 |

---

## 任务 1：在 GitCommitMessageService 中添加获取模型信息的方法

**文件：**
- 修改：`src/main/java/com/github/claudecodegui/service/GitCommitMessageService.java`
- 测试：手动测试（无需单元测试，依赖运行时配置）

- [ ] **步骤 1：添加 getProviderDisplayName 方法**

在 `GitCommitMessageService` 类中，在 `getResolvedCommitAiModel` 方法后添加：

```java
/**
 * Get the display name for a provider.
 * @param provider The internal provider identifier (claude/codex)
 * @return The display name (Claude/Codex)
 */
@NotNull
protected String getProviderDisplayName(@NotNull String provider) {
    if (PROVIDER_CLAUDE.equals(provider)) {
        return "Claude";
    } else if (PROVIDER_CODEX.equals(provider)) {
        return "Codex";
    }
    return provider; // Fallback to original
}
```

- [ ] **步骤 2：添加 getFormattedModelInfo 方法**

在 `getProviderDisplayName` 方法后添加：

```java
/**
 * Get formatted model information (without icon).
 * @return Format like "claude-sonnet-4.5 (Claude)"
 * @throws IOException if reading config fails
 */
@NotNull
public String getFormattedModelInfo() throws IOException {
    JsonObject commitAiConfig = getCommitAiConfig();
    String effectiveProvider = getResolvedCommitAiProvider(commitAiConfig);

    if (effectiveProvider == null) {
        return "(" + ClaudeCodeGuiBundle.message("commit.progress.unknownModel") + ")";
    }

    String model = getResolvedCommitAiModel(commitAiConfig, effectiveProvider);
    String providerDisplayName = getProviderDisplayName(effectiveProvider);

    if (model == null || model.isEmpty()) {
        return providerDisplayName;
    }

    return model + " (" + providerDisplayName + ")";
}
```

- [ ] **步骤 3：添加 getModelDisplayText 方法**

在 `getFormattedModelInfo` 方法后添加：

```java
/**
 * Get model information text for display (with icon).
 * @return Format like "🤖 使用模型: claude-sonnet-4.5 (Claude)"
 * @throws IOException if reading config fails
 */
@NotNull
public String getModelDisplayText() throws IOException {
    JsonObject commitAiConfig = getCommitAiConfig();
    String effectiveProvider = getResolvedCommitAiProvider(commitAiConfig);

    if (effectiveProvider == null) {
        return "🤖 " + ClaudeCodeGuiBundle.message("commit.progress.unknownModel");
    }

    String model = getResolvedCommitAiModel(commitAiConfig, effectiveProvider);
    String providerDisplayName = getProviderDisplayName(effectiveProvider);

    if (model == null || model.isEmpty()) {
        return "🤖 " + providerDisplayName;
    }

    return "🤖 " + ClaudeCodeGuiBundle.message("commit.progress.modelInfo", model, providerDisplayName);
}
```

- [ ] **步骤 4：修改 CommitMessageCallback 接口，添加 onGenerationStart 方法**

找到 `CommitMessageCallback` 接口定义，在 `onProgress` 方法前添加：

```java
/**
 * Called when generation starts, with model information.
 * @param modelInfo Formatted model info like "claude-sonnet-4.5 (Claude)"
 */
default void onGenerationStart(@NotNull String modelInfo) {
    // Default: no-op for backward compatibility
}
```

- [ ] **步骤 5：Commit**

```bash
git add src/main/java/com/github/claudecodegui/service/GitCommitMessageService.java
git commit -m "feat(commit): 添加获取模型信息的方法到 GitCommitMessageService

- 新增 getProviderDisplayName() 获取 Provider 显示名称
- 新增 getFormattedModelInfo() 获取格式化的模型信息
- 新增 getModelDisplayText() 获取带图标的显示文本
- CommitMessageCallback 接口添加 onGenerationStart() 回调"
```

---

## 任务 2：添加国际化翻译 key

**文件：**
- 修改：所有 `ClaudeCodeGuiBundle_*.properties` 文件

- [ ] **步骤 1：修改中文翻译文件**

编辑 `src/main/resources/messages/ClaudeCodeGuiBundle_zh.properties`，在 `commit.progress` 相关条目后添加：

```properties
commit.progress.unknownModel=未知模型
commit.progress.modelInfo=使用模型: {0} ({1})
```

- [ ] **步骤 2：修改英文翻译文件**

编辑 `src/main/resources/messages/ClaudeCodeGuiBundle_en.properties`，在 `commit.progress` 相关条目后添加：

```properties
commit.progress.unknownModel=Unknown Model
commit.progress.modelInfo=Model: {0} ({1})
```

- [ ] **步骤 3：修改西班牙语翻译文件**

编辑 `src/main/resources/messages/ClaudeCodeGuiBundle_es.properties`，在 `commit.progress` 相关条目后添加：

```properties
commit.progress.unknownModel=Modelo Desconocido
commit.progress.modelInfo=Modelo: {0} ({1})
```

- [ ] **步骤 4：修改法语翻译文件**

编辑 `src/main/resources/messages/ClaudeCodeGuiBundle_fr.properties`，在 `commit.progress` 相关条目后添加：

```properties
commit.progress.unknownModel=Modèle Inconnu
commit.progress.modelInfo=Modèle: {0} ({1})
```

- [ ] **步骤 5：修改印地语翻译文件**

编辑 `src/main/resources/messages/ClaudeCodeGuiBundle_hi.properties`，在 `commit.progress` 相关条目后添加：

```properties
commit.progress.unknownModel=अज्ञात मॉडल
commit.progress.modelInfo=मॉडल: {0} ({1})
```

- [ ] **步骤 6：修改日语翻译文件**

编辑 `src/main/resources/messages/ClaudeCodeGuiBundle_ja.properties`，在 `commit.progress` 相关条目后添加：

```properties
commit.progress.unknownModel=不明なモデル
commit.progress.modelInfo=モデル: {0} ({1})
```

- [ ] **步骤 7：修改俄语翻译文件**

编辑 `src/main/resources/messages/ClaudeCodeGuiBundle_ru.properties`，在 `commit.progress` 相关条目后添加：

```properties
commit.progress.unknownModel=Неизвестная Модель
commit.progress.modelInfo=Модель: {0} ({1})
```

- [ ] **步骤 8：修改繁体中文翻译文件**

编辑 `src/main/resources/messages/ClaudeCodeGuiBundle_zh_TW.properties`，在 `commit.progress` 相关条目后添加：

```properties
commit.progress.unknownModel=未知模型
commit.progress.modelInfo=使用模型: {0} ({1})
```

- [ ] **步骤 9：Commit**

```bash
git add src/main/resources/messages/ClaudeCodeGuiBundle_*.properties
git commit -m "feat(i18n): 添加模型信息相关的国际化翻译

- 新增 commit.progress.unknownModel（未知模型）
- 新增 commit.progress.modelInfo（模型信息显示格式）
- 覆盖所有 9 种语言"
```

---

## 任务 3：修改 GenerateCommitMessageAction 以显示模型信息

**文件：**
- 修改：`src/main/java/com/github/claudecodegui/action/vcs/GenerateCommitMessageAction.java`
- 测试：手动测试（运行 IDE 并测试 commit 生成功能）

- [ ] **步骤 1：添加提取纯模型名称的辅助方法**

在 `GenerateCommitMessageAction` 类中，在 `showRetryNotification` 方法后添加：

```java
/**
 * Extract pure model name from display text (removes icon and prefix).
 * @param displayText Display text like "🤖 使用模型: claude-sonnet-4.5 (Claude)"
 * @return Pure model name like "claude-sonnet-4.5"
 */
@NotNull
private String extractPureModelName(@NotNull String displayText) {
    // Remove emoji and prefix
    String cleaned = displayText.replaceFirst("^🤖\\s*", "");
    cleaned = cleaned.replaceFirst(".*使用模型:\\s*", "");
    cleaned = cleaned.replaceFirst(".*Model:\\s*", "");

    // Remove provider suffix in parentheses
    cleaned = cleaned.replaceAll("\\s*\\([^)]+\\)$", "");

    return cleaned.trim();
}
```

- [ ] **步骤 2：修改 startGeneration 方法，在开始时获取模型信息**

找到 `startGeneration` 方法，在 `final Timer[] timerHolder = {null};` 这行之前添加：

```java
// Get model info before starting generation
final String[] modelInfo = {""};
try {
    GitCommitMessageService tempService = new GitCommitMessageService(project);
    modelInfo[0] = tempService.getModelDisplayText();
} catch (Exception e) {
    LOG.warn("Failed to get model info", e);
    modelInfo[0] = "🤖 " + ClaudeCodeGuiBundle.message("commit.progress.unknownModel");
}
final String finalModelInfo = modelInfo[0];
```

- [ ] **步骤 3：启动进度对话框**

在 `startGeneration` 方法中，找到设置初始状态的代码块（`// Set initial status`），在这之前添加：

```java
// Start progress dialog with model info
final CommitGenerationProgressDialog[] dialogHolder = {null};
ApplicationManager.getApplication().invokeLater(() -> {
    String pureModelName = extractPureModelName(finalModelInfo);
    dialogHolder[0] = new CommitGenerationProgressDialog(project, pureModelName);
    // Show dialog in background thread to avoid blocking
    ApplicationManager.getApplication().executeOnPooledThread(() -> {
        dialogHolder[0].start();
    });
});
```

- [ ] **步骤 4：修改初始状态显示，包含模型信息**

找到 `// Set initial status` 代码块，修改为：

```java
// Set initial status with model info
ApplicationManager.getApplication().invokeLater(() -> {
    String initialStatus = finalModelInfo + "\n\n" +
                           ClaudeCodeGuiBundle.message("commit.progress.initializing") + "...";
    lastProgressMessage[0] = initialStatus;
    finalCommitMessagePanel.setCommitMessage(initialStatus);
});
```

- [ ] **步骤 5：修改进度更新逻辑，保持模型信息在顶部**

找到 Timer 的 `actionPerformed` 方法，修改 `status` 变量的构建方式：

将：
```java
String status = lastProgressMessage[0] + "\n\n" + hint + "\n" +
               String.format("⏱ %s", timeText);
```

改为：
```java
// Keep model info at the top, then progress/hint/timer
String status = finalModelInfo + "\n\n" + lastProgressMessage[0] + "\n\n" + hint + "\n" +
               String.format("⏱ %s", timeText);
```

- [ ] **步骤 6：在成功回调中关闭进度对话框**

找到 `onSuccess` 回调方法，在 `timerHolder[0].stop();` 后添加：

```java
if (dialogHolder[0] != null) {
    dialogHolder[0].complete();
}
```

- [ ] **步骤 7：在错误回调中关闭进度对话框**

找到 `onError` 回调方法，在 `timerHolder[0].stop();` 后添加：

```java
if (dialogHolder[0] != null) {
    dialogHolder[0].error(error);
}
```

- [ ] **步骤 8：在异常处理中关闭进度对话框**

找到 catch 异常处理的代码块，在 `timerHolder[0].stop();` 后添加：

```java
if (dialogHolder[0] != null) {
    dialogHolder[0].error(ex.getMessage());
}
```

- [ ] **步骤 9：在取消操作中关闭进度对话框**

找到取消按钮的 `actionPerformed` 方法，在 `isCancelled[0] = true;` 后添加：

```java
if (dialogHolder[0] != null) {
    dialogHolder[0].dispose();
}
```

- [ ] **步骤 10：Commit**

```bash
git add src/main/java/com/github/claudecodegui/action/vcs/GenerateCommitMessageAction.java
git commit -m "feat(commit): 在生成过程中显示模型信息

- 在开始生成前获取并显示模型信息
- 启用 CommitGenerationProgressDialog 显示进度对话框
- 在 commit 输入框中显示模型信息和计时器
- 生成完成或错误时正确关闭对话框
- 支持取消操作并清理对话框资源"
```

---

## 任务 4：手动测试验证

**文件：**
- 无代码变更，仅测试

- [ ] **步骤 1：构建并运行插件**

```bash
cd "E:\Develop\workspace\IdeaProjects\java\jetbrains-cc-gui"
./gradlew clean runIde
```

- [ ] **步骤 2：测试 Claude provider 模型显示**

1. 在打开的 sandbox IDE 中，创建或修改一个文件
2. 打开 Commit 窗口（View → Tool Windows → Commit）
3. 点击 "Generate Commit Message" 按钮
4. 验证：
   - 进度对话框显示，包含模型名称（如 "claude-sonnet-4.5"）
   - Commit 输入框显示模型信息（如 "🤖 使用模型: claude-sonnet-4.5 (Claude)"）
   - 计时器正常工作
   - 生成完成后对话框自动关闭

- [ ] **步骤 3：测试 Codex provider 模型显示**

1. 在设置中切换到 Codex provider
2. 重复步骤 2 的测试
3. 验证模型显示为 Codex 相关模型

- [ ] **步骤 4：测试取消功能**

1. 点击 "Generate Commit Message"
2. 在进度对话框显示时点击系统通知的 "取消" 按钮
3. 验证：
   - 对话框正确关闭
   - 显示重试通知

- [ ] **步骤 5：测试错误处理**

1. 暂时断开网络或设置无效的 API key
2. 点击 "Generate Commit Message"
3. 验证：
   - 对话框显示错误状态
   - 输入框显示错误信息

- [ ] **步骤 6：测试国际化**

1. 在设置中切换不同语言
2. 验证模型信息显示格式正确

---

## 自检结果

**✓ 规格覆盖度：**
- 模型信息获取方法 → 任务 1
- 国际化翻译 → 任务 2
- 输入框显示模型信息 → 任务 3
- 进度对话框显示 → 任务 3
- 错误处理 → 任务 3
- 测试验证 → 任务 4

**✓ 占位符扫描：** 无占位符，所有步骤包含完整代码

**✓ 类型一致性：** 方法名和变量名在各任务间保持一致
