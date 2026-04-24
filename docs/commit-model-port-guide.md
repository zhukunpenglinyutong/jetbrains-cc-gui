# Git 提交消息模型选择功能移植指南

## 概述

本文档记录了将 `comit/0.4` 分支上的 Git 提交消息模型选择相关改造功能移植到 `feature/v0.4.1` 分支的完整过程。

**移植日期：** 2026-04-25

**源分支：** `comit/0.4`

**目标分支：** `feature/v0.4.1-commit-model` (基于 `feature/v0.4.1` 创建)

---

## 移植的提交列表

| 提交哈希 | 提交消息 | 说明 |
|---------|---------|------|
| `37b05b00` | feat(commit): add Codex/GPT models and custom model support | 添加 Codex/GPT 模型和自定义模型支持 |
| `c088ebaf` | feat(commit): display SDK and target address info in model selection dialog | 在模型选择对话框中显示 SDK 和目标地址信息 |
| `5c075435` | feat: 支持从配置文件加载自定义模型到Git提交模型选择弹窗 | 支持从配置文件加载自定义模型 |
| `bb491dac` | feat(commit): 添加提交消息生成进度对话框 | 添加提交消息生成进度对话框 |

---

## 详细移植步骤

### 步骤 1: 创建新分支

```bash
git checkout feature/v0.4.1
git checkout -b feature/v0.4.1-commit-model
```

### 步骤 2: 分析提交差异

首先确认源分支和目标分支之间的差异：

```bash
# 查看提交历史
git log comit/0.4 ^feature/v0.4.1 --oneline

# 查看文件变更
git diff feature/v0.4.1..comit/0.4 --name-only
```

**关键发现：**
- `feature/v0.4.1` 使用 `com.github.claudecodegui` 包名
- `comit/0.4` 使用 `com.github.myccgui` 包名
- 需要在移植过程中进行包名转换

### 步骤 3: 移植第一个提交 (37b05b00)

**涉及文件：**
- `ModelSelectionDialog.java` (新增)
- `GitCommitMessageService.java` (修改)

**移植命令：**

```bash
# 获取文件并转换包名
git show 37b05b00:src/main/java/com/github/myccgui/action/vcs/ModelSelectionDialog.java \
  | sed 's/myccgui/claudecodegui/g' \
  > src/main/java/com/github/claudecodegui/action/vcs/ModelSelectionDialog.java

git show 37b05b00:src/main/java/com/github/myccgui/service/GitCommitMessageService.java \
  | sed 's/myccgui/claudecodegui/g' \
  > src/main/java/com/github/claudecodegui/service/GitCommitMessageService.java
```

**核心改动：**
- 添加 Codex/GPT 模型列表 (gpt-5.4, gpt-5.3-codex, gpt-5.2-codex, o3-mini, o1-mini)
- 添加自定义模型输入字段
- 实现基于模型名称的 provider 自动检测

### 步骤 4: 移植第二个提交 (c088ebaf)

**涉及文件：**
- `ModelSelectionDialog.java` (修改)
- `BridgeDirectoryResolver.java` (修改)

**移植命令：**

```bash
git show c088ebaf:src/main/java/com/github/myccgui/action/vcs/ModelSelectionDialog.java \
  | sed 's/myccgui/claudecodegui/g' \
  > src/main/java/com/github/claudecodegui/action/vcs/ModelSelectionDialog.java

git show c088ebaf:src/main/java/com/github/myccgui/bridge/BridgeDirectoryResolver.java \
  | sed 's/myccgui/claudecodegui/g' \
  > src/main/java/com/github/claudecodegui/bridge/BridgeDirectoryResolver.java
```

**核心改动：**
- 在对话框顶部添加 SDK 信息面板
- 显示当前 SDK 类型 (Claude Agent SDK / Bedrock SDK / Anthropic SDK)
- 显示 API 目标地址
- 支持 CLI Login provider 检测

### 步骤 5: 移植第三个提交 (5c075435)

**涉及文件：**

**Java 文件：**
- `ModelSelectionDialog.java` (修改)
- `CustomModelsHandler.java` (新增)
- `ModelInfo.java` (新增)
- `ModelListProvider.java` (新增)
- `ConfigPathManager.java` (修改)
- `ChatWindowDelegate.java` (修改)

**前端文件：**
- `usePluginModels.ts`
- `useSettingsWindowCallbacks.ts`
- `registerCallbacks.ts`
- `settingsBootstrap.ts`

**移植命令：**

```bash
# Java 文件
for file in \
  "src/main/java/com/github/myccgui/action/vcs/ModelSelectionDialog.java" \
  "src/main/java/com/github/myccgui/handler/CustomModelsHandler.java" \
  "src/main/java/com/github/myccgui/model/ModelInfo.java" \
  "src/main/java/com/github/myccgui/provider/ModelListProvider.java" \
  "src/main/java/com/github/myccgui/settings/ConfigPathManager.java" \
  "src/main/java/com/github/myccgui/ui/ChatWindowDelegate.java"; do
  target=$(echo $file | sed 's|myccgui|claudecodegui|g')
  mkdir -p $(dirname $target)
  git show 5c075435:"$file" | sed 's/myccgui/claudecodegui/g' > "$target"
done

# 前端文件（无需包名转换）
for file in \
  "webview/src/components/settings/hooks/usePluginModels.ts" \
  "webview/src/components/settings/hooks/useSettingsWindowCallbacks.ts" \
  "webview/src/hooks/windowCallbacks/registerCallbacks.ts" \
  "webview/src/hooks/windowCallbacks/settingsBootstrap.ts"; do
  git show 5c075435:"$file" > "$file"
done
```

**核心改动：**
- 新增自定义模型加载器 `CustomModelsHandler`
- 新增模型信息类 `ModelInfo`
- 新增模型列表提供者 `ModelListProvider`
- 前端支持自定义模型配置 UI

### 步骤 6: 移植第四个提交 (bb491dac)

**涉及文件：**
- `CommitGenerationProgressDialog.java` (新增)
- `GenerateCommitMessageAction.java` (修改)
- `GitCommitMessageService.java` (修改)
- 8 个语言包文件

**移植命令：**

```bash
# Java 文件
for file in \
  "src/main/java/com/github/myccgui/action/vcs/CommitGenerationProgressDialog.java" \
  "src/main/java/com/github/myccgui/action/vcs/GenerateCommitMessageAction.java" \
  "src/main/java/com/github/myccgui/service/GitCommitMessageService.java"; do
  target=$(echo $file | sed 's|myccgui|claudecodegui|g')
  mkdir -p $(dirname $target)
  git show bb491dac:"$file" | sed 's/myccgui/claudecodegui/g' > "$target"
done

# 语言包文件（无需包名转换）
for file in \
  "src/main/resources/messages/ClaudeCodeGuiBundle_en.properties" \
  "src/main/resources/messages/ClaudeCodeGuiBundle_es.properties" \
  "src/main/resources/messages/ClaudeCodeGuiBundle_fr.properties" \
  "src/main/resources/messages/ClaudeCodeGuiBundle_hi.properties" \
  "src/main/resources/messages/ClaudeCodeGuiBundle_ja.properties" \
  "src/main/resources/messages/ClaudeCodeGuiBundle_ru.properties" \
  "src/main/resources/messages/ClaudeCodeGuiBundle_zh.properties" \
  "src/main/resources/messages/ClaudeCodeGuiBundle_zh_TW.properties"; do
  git show bb491dac:"$file" > "$file"
done
```

**核心改动：**
- 新增进度对话框 `CommitGenerationProgressDialog`
- 集成模型选择到 `GenerateCommitMessageAction`
- 更新服务以支持进度回调和流式响应
- 添加多语言支持

### 步骤 7: 提交变更

```bash
git add -A
git commit -m "feat(commit): 移植 Git 提交消息模型选择功能

从 comit/0.4 分支移植以下功能到 feature/v0.4.1-commit-model：

- 添加 Codex/GPT 模型支持 (gpt-5.4, gpt-5.3-codex, o3-mini 等)
- 添加自定义模型输入字段
- 在模型选择对话框中显示 SDK 和目标地址信息
- 支持从配置文件加载自定义模型
- 添加提交消息生成进度对话框
- 自动检测模型名称对应的 provider

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## 遇到的问题与解决方案

### 问题 1: 包名不一致

**描述：** `feature/v0.4.1` 使用 `claudecodegui` 包名，而 `comit/0.4` 使用 `myccgui` 包名。

**解决方案：** 使用 `sed` 命令在移植过程中批量替换包名：

```bash
sed 's/myccgui/claudecodegui/g'
```

### 问题 2: Cherry-pick 冲突

**描述：** 直接使用 `git cherry-pick` 会产生大量冲突。

**解决方案：** 放弃 cherry-pick，改用直接获取文件内容并转换包名的方式。

### 问题 3: 文件路径转换

**描述：** 需要正确处理源文件路径到目标文件路径的转换。

**解决方案：** 使用 shell 脚本自动处理路径转换和目录创建：

```bash
target=$(echo $file | sed 's|myccgui|claudecodegui|g')
mkdir -p $(dirname $target)
```

---

## 文件变更清单

### 新增文件 (5 个)

| 文件 | 行数 | 描述 |
|------|------|------|
| `ModelSelectionDialog.java` | 282 | 模型选择对话框 |
| `CommitGenerationProgressDialog.java` | 201 | 生成进度对话框 |
| `CustomModelsHandler.java` | 91 | 自定义模型处理器 |
| `ModelInfo.java` | 43 | 模型信息类 |
| `ModelListProvider.java` | 234 | 模型列表提供者 |

### 修改文件 (17 个)

| 文件类型 | 文件数 | 主要改动 |
|---------|-------|---------|
| Java 源码 | 5 | 集成新功能、更新接口 |
| 前端 TypeScript | 4 | 支持自定义模型配置 |
| 语言包 | 8 | 添加新翻译 |

### 统计数据

- **总计：** 22 个文件
- **新增：** 1658 行
- **删除：** 98 行
- **净增：** 1560 行

---

## 验证方法

### 1. 编译验证

```bash
./gradlew clean buildPlugin
```

### 2. 功能测试

1. 在 IDE 中打开插件
2. 执行 Git 提交操作
3. 验证模型选择对话框显示正确
4. 验证 SDK 信息显示正确
5. 验证自定义模型输入功能
6. 验证进度对话框显示正确

### 3. 代码检查

```bash
# Checkstyle 检查
./gradlew checkstyleMain

# 查看变更统计
git diff HEAD~1 --stat
```

---

## 技术要点

### Provider 自动检测逻辑

```java
private String detectProviderForModel(String model) {
    if (model == null || model.isEmpty()) {
        return DEFAULT_PROVIDER;
    }

    String lowerModel = model.toLowerCase();
    for (String prefix : CODEX_MODEL_PREFIXES) {
        if (lowerModel.startsWith(prefix)) {
            return "codex";
        }
    }

    return DEFAULT_PROVIDER;
}
```

### SDK 信息解析

- 从 `CodemossSettingsService` 获取当前 provider 配置
- 解析 `settingsConfig.env` 中的环境变量
- 检测 `CLAUDE_CODE_USE_BEDROCK` 判断是否使用 Bedrock
- 解析 `ANTHROPIC_BASE_URL` 获取自定义 API 地址

### 模型列表合并

```java
static {
    AVAILABLE_MODELS = new String[CLAUDE_MODELS.length + CODEX_MODELS.length];
    MODEL_DISPLAY_NAMES = new String[CLAUDE_MODEL_DISPLAY_NAMES.length + CODEX_MODEL_DISPLAY_NAMES.length];

    int idx = 0;
    for (int i = 0; i < CLAUDE_MODELS.length; i++, idx++) {
        AVAILABLE_MODELS[idx] = CLAUDE_MODELS[i];
        MODEL_DISPLAY_NAMES[idx] = CLAUDE_MODEL_DISPLAY_NAMES[i];
    }
    for (int i = 0; i < CODEX_MODELS.length; i++, idx++) {
        AVAILABLE_MODELS[idx] = CODEX_MODELS[i];
        MODEL_DISPLAY_NAMES[idx] = CODEX_MODEL_DISPLAY_NAMES[i];
    }
}
```

---

## 后续工作建议

1. **测试覆盖：** 为新功能添加单元测试
2. **文档更新：** 更新用户文档说明新功能
3. **性能优化：** 评估大量模型时的性能表现
4. **UI 改进：** 根据用户反馈优化对话框布局
5. **国际化：** 确保所有新增文本都有完整的翻译

---

## 参考资源

- **源分支：** `comit/0.4`
- **目标分支：** `feature/v0.4.1-commit-model`
- **基础分支：** `feature/v0.4.1`
- **提交哈希：** `0e4dfba0`

---

*文档生成时间：2026-04-25*
*作者：Claude Code + zcl*
