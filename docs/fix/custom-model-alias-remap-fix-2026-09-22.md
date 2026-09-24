# 修复：自定义模型 `claude-opus-4-6` 被强制改写为 `claude-opus-5`

- 影响版本：v0.5.6（提交 `5a06d250`）。`claude-opus-4-6` 在 `249765a4`（2026-07-29）首次进入迁移表（目标 opus-4-8），Java 侧由 `04f6e4ef`（2026-08-17）照抄，`a9e6f6f7`（v0.5.5-fix1）只是把目标改成了 opus-5
- 日期：2026-09-22
- 现象：
  1. 在“管理自定义模型”里添加 ID 为 `claude-opus-4-6` 的模型后，模型下拉框里 **Opus 4.6 与 Opus 5 同时打勾**。
  2. 选中该自定义模型后，实际发给 Claude 的模型是 `claude-opus-5`，而不是 `claude-opus-4-6`。

---

## 1. 根因

插件在 v0.5.5-fix1 里把 `claude-opus-4-6` 加入了“已下线模型迁移表”，任何出现该 ID 的地方都会被改写成 `claude-opus-5`。迁移表**没有区分内置旧模型和用户自定义模型**，所以用户手动添加的 `claude-opus-4-6` 也被改写。

迁移表在前端和 Java 后端各有一份，逻辑完全一样。

### 1.1 前端

[webview/src/components/ChatInputBox/types.ts](../webview/src/components/ChatInputBox/types.ts) 第 349 行起：

```ts
const LEGACY_CLAUDE_MODEL_ID_ALIASES: Record<string, string> = {
  'claude-sonnet-4-6': 'claude-sonnet-5',
  'claude-sonnet-4-7': 'claude-sonnet-5',
  'claude-opus-4-6': 'claude-opus-5',   // <-- 问题条目
  'claude-opus-4-8': 'claude-opus-5',
};

export function normalizeClaudeModelId(modelId: string | undefined | null): string {
  if (!modelId) return DEFAULT_CLAUDE_MODEL_ID;
  const stripped = strip1MContextSuffix(modelId);   // 先去掉 [1m]
  return LEGACY_CLAUDE_MODEL_ID_ALIASES[stripped] ?? stripped;
}
```

`normalizeClaudeModelId` 的调用点（均会触发改写）：

| 文件 | 行 | 作用 |
|---|---|---|
| `components/ChatInputBox/selectors/useModelSelectState.ts` | 54 | `isSelectedModel`：对**列表每一项**归一化后与当前值比较，导致双勾 |
| `components/ChatInputBox/selectors/useModelSelectState.ts` | 34 | 计算当前选中项 |
| `components/ChatInputBox/selectors/useModelConfigSummary.ts` | 35 | 底部摘要显示 |
| `hooks/modelProviderStateHelpers.ts` | 201–203 | `applyModelSelect`：用户点选后，**归一化后再 `set_model` 发给后端** |
| `hooks/providers/useModelStatePersistence.ts` | 232 | 启动时恢复上次选择 |
| `applyHistoryModel.ts` | 114–116 | 打开历史会话时恢复模型 |
| `hooks/windowCallbacks/registerCallbacks/usageModeCallbacks.ts` | 112 / 120 / 141 | 后端回调 `onModelChanged` / `onModelConfirmed` |

双勾的直接原因是第 54 行：

```ts
const isSelectedModel = (modelId: string): boolean => {
  if (currentProvider !== 'claude') return modelId === strippedValue;
  return normalizeClaudeModelId(modelId) === normalizedValue;
};
```

自定义项 `claude-opus-4-6` 归一化后是 `claude-opus-5`，内置 Opus 5 也是 `claude-opus-5`，两项都为真。

### 1.2 Java 后端

[src/main/java/com/github/claudecodegui/session/SessionState.java](../src/main/java/com/github/claudecodegui/session/SessionState.java) 第 288 行起：

```java
public static String normalizeRetiredModelId(String model) {
    ...
    switch (base) {
        case "claude-sonnet-4-6":
        case "claude-sonnet-4-7":
            base = "claude-sonnet-5";
            break;
        case "claude-opus-4-6":      // <-- 问题条目
        case "claude-opus-4-8":
            base = "claude-opus-5";
            break;
        default:
            return trimmed;
    }
    return oneM ? base + "[1m]" : base;
}

public void setModel(String model) {
    this.model = normalizeRetiredModelId(model);   // 第 270 行，所有 setModel 都会经过
}
```

调用点：

- `SessionState.setModel`（第 270 行）：`ModelProviderHandler.handleSetModel` → `ClaudeSession.setModel` → 这里。用户在下拉框点选走的就是这条路。
- `CodemossSettingsService.java` 第 2370 行：读取 AI 功能默认模型时自愈。

Java 侧**不知道**用户的自定义模型列表，自定义模型只存在 webview 的 `localStorage`（键 `claude-custom-models`，见 `webview/src/types/provider.ts:45`）。

### 1.3 已排除的方案：用 `~/.claude/settings.json` 的 `modelOverrides` 别名

曾尝试把自定义模型 ID 改为别名 `Opus 4.6`（`settings.json` 里 `"modelOverrides": {"Opus 4.6": "claude-opus-4-6[1m]"}`）。实测无效：

| `claude -p --model <值>` | 结果 |
|---|---|
| `Opus 4.6[1m]` | `[claude-code:unrecognized_model]`，未发请求 |
| `Opus 4.6` | `[claude-code:unrecognized_model]`，未发请求 |
| `claude-opus-4-6[1m]` | 正常，`modelUsage` 为 `claude-opus-4-6[1m]` |

`modelOverrides` 只在交互式终端的 `/model` 菜单生效，SDK / `-p` 路径不解析别名。CC GUI 走 SDK 路径，且会把 1M 开关的 `[1m]` 拼到 ID 后面（IDEA 日志 `Setting model to: Opus 4.6[1m]`）。因此**必须传真实 ID `claude-opus-4-6`**，问题只能在插件里修。

同时上表也证明 `claude-opus-4-6` 在 API 侧仍然可用，把它列为“已下线”本身就不准确。

---

## 2. 修复方案

两个方案，推荐 **方案 A** 解决本地问题，**方案 B** 适合提给上游。

### 方案 A（最小改动）：把 `claude-opus-4-6` 从两张迁移表里删掉

理由：迁移表的注释写明它只用于“已下线且会导致请求失败”的模型（#1678、#1693）。`claude-opus-4-6` 仍可正常调用，不满足入表条件。删掉后旧会话继续跑 Opus 4.6，也不会失败。

#### A-1 前端 `webview/src/components/ChatInputBox/types.ts`

```diff
 const LEGACY_CLAUDE_MODEL_ID_ALIASES: Record<string, string> = {
   'claude-sonnet-4-6': 'claude-sonnet-5',
   'claude-sonnet-4-7': 'claude-sonnet-5',
-  'claude-opus-4-6': 'claude-opus-5',
   'claude-opus-4-8': 'claude-opus-5',
 };
```

#### A-2 前端测试 `webview/src/components/ChatInputBox/types.test.ts`

```diff
   it('migrates retired Opus generations to Opus 5', () => {
-    expect(normalizeClaudeModelId('claude-opus-4-6')).toBe('claude-opus-5');
     expect(normalizeClaudeModelId('claude-opus-4-8')).toBe('claude-opus-5');
   });

   it('migrates retired IDs carrying a [1m] suffix', () => {
     expect(normalizeClaudeModelId('claude-sonnet-4-6[1m]')).toBe('claude-sonnet-5');
     expect(normalizeClaudeModelId('claude-sonnet-4-7[1m]')).toBe('claude-sonnet-5');
-    expect(normalizeClaudeModelId('claude-opus-4-6[1m]')).toBe('claude-opus-5');
     expect(normalizeClaudeModelId('claude-opus-4-8[1m]')).toBe('claude-opus-5');
   });
+
+  it('keeps claude-opus-4-6 untouched: still a live model, used as a custom model', () => {
+    expect(normalizeClaudeModelId('claude-opus-4-6')).toBe('claude-opus-4-6');
+    expect(normalizeClaudeModelId('claude-opus-4-6[1m]')).toBe('claude-opus-4-6');
+  });
```

#### A-3 Java `src/main/java/com/github/claudecodegui/session/SessionState.java`

```diff
         switch (base) {
             case "claude-sonnet-4-6":
             case "claude-sonnet-4-7":
                 base = "claude-sonnet-5";
                 break;
-            case "claude-opus-4-6":
             case "claude-opus-4-8":
                 base = "claude-opus-5";
                 break;
```

#### A-4 Java 测试 `src/test/java/com/github/claudecodegui/session/SessionStateTest.java`

第 27 行起的 `setModelMigratesRetiredOpus46ToOpus5` 现在断言 4.6 会被迁移，需要改掉：

```diff
     @Test
-    public void setModelMigratesRetiredOpus46ToOpus5() {
+    public void setModelMigratesRetiredOpus48ToOpus5() {
         SessionState state = new SessionState();
-        state.setModel("claude-opus-4-6");
-        Assert.assertEquals("claude-opus-5", state.getModel());
         state.setModel("claude-opus-4-8");
         Assert.assertEquals("claude-opus-5", state.getModel());
     }
```

再在 `setModelLeavesLiveModelsUntouched` 里追加：

```diff
     @Test
     public void setModelLeavesLiveModelsUntouched() {
         SessionState state = new SessionState();
         state.setModel("claude-sonnet-5");
         Assert.assertEquals("claude-sonnet-5", state.getModel());
         state.setModel("claude-fable-5-1[1m]");
         Assert.assertEquals("claude-fable-5-1[1m]", state.getModel());
+        // claude-opus-4-6 is still live and is commonly added as a custom model.
+        state.setModel("claude-opus-4-6[1m]");
+        Assert.assertEquals("claude-opus-4-6[1m]", state.getModel());
     }
```

其余涉及 `claude-opus-4-6` 的测试不受影响，不用改：

- `ModelProviderHandlerTest.java` 第 27、110、118 行：测的是上下文长度和环境变量解析，与迁移表无关。
- `webview/.../selectors/ModelSelect.test.tsx` 第 91 行：断言内置列表里没有 4.6，改的是迁移表不是内置列表。

### 方案 B（通用）：自定义模型跳过迁移；显式 `set_model` 不迁移

适合提 PR。即便以后某个模型真的下线，用户手动加回来的自定义 ID 也不该被改写。

#### B-1 前端：`normalizeClaudeModelId` 先查自定义模型

`types.ts`：

```diff
+import { STORAGE_KEYS } from '../../types/provider';
+
+function isUserCustomClaudeModel(id: string): boolean {
+  if (typeof window === 'undefined' || !window.localStorage) return false;
+  try {
+    const raw = window.localStorage.getItem(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS);
+    const list = raw ? (JSON.parse(raw) as { id?: unknown }[]) : [];
+    return Array.isArray(list) && list.some(m => m && m.id === id);
+  } catch {
+    return false;
+  }
+}
+
 export function normalizeClaudeModelId(modelId: string | undefined | null): string {
   if (!modelId) return DEFAULT_CLAUDE_MODEL_ID;
   const stripped = strip1MContextSuffix(modelId);
+  // User-defined custom models are never migrated: the user asked for this id.
+  if (isUserCustomClaudeModel(stripped)) return stripped;
   return LEGACY_CLAUDE_MODEL_ID_ALIASES[stripped] ?? stripped;
 }
```

注意：`types.ts` 目前是纯模块，引入 `localStorage` 读取会带来副作用，并且 `normalizeClaudeModelId` 在列表渲染时对每一项调用。若在意性能，可改成由调用方传入自定义模型列表（`normalizeClaudeModelId(id, customIds?: Set<string>)`），共 8 处调用点需要改。

测试：在 `types.test.ts` 里用 `localStorage.setItem('claude-custom-models', JSON.stringify([{id:'claude-opus-4-6'}]))` 后断言不迁移。

#### B-2 Java：只在“恢复”路径迁移，用户显式选择不迁移

Java 拿不到自定义模型列表，改为按来源区分：

`SessionState.java`：

```diff
     public void setModel(String model) {
         this.model = normalizeRetiredModelId(model);
     }
+
+    /**
+     * Store the model exactly as given. Used for explicit user selections
+     * (set_model from the webview) where the id may be a user-defined custom
+     * model that must not be migrated.
+     */
+    public void setModelRaw(String model) {
+        this.model = model == null ? null : model.trim();
+    }
```

`ClaudeSession.java` 增加对应的 `setModelRaw`，`ModelProviderHandler.handleSetModel` 第 118 行改为：

```diff
-                context.getSession().setModel(model);
+                context.getSession().setModelRaw(model);
```

其余 `setModel` 调用点（`SessionLifecycleManager`、`ClaudeChatWindow.java:1510` 恢复持久化状态、`HistoryMessageInjector`）保持迁移行为不变。

---

## 2.1 实际落地（2026-09-22）

同时做了方案 A 和一个调整过的方案 B。原则：**自定义模型 ID 无条件原样使用，迁移表只服务于恢复路径，"已下线"只作提示不作改写。**

- 方案 A 原样落地：两侧迁移表删掉 `claude-opus-4-6`，注释写明它仍可调用、不得入表。
- 前端 `normalizeClaudeModelId(modelId, customModelIds?)` 增加可选参数，命中自定义 ID 集合时直接返回，不查迁移表。8 个调用点全部传入：下拉框比较和底部摘要从 `models` 里带 `isCustom` 标记的项取集合，其余调用点用新工具 `utils/customClaudeModels.ts` 的 `readCustomClaudeModelIds()` 从 localStorage 读。没有采用 B-1 里在 `types.ts` 内读 localStorage 的写法。
- 前端 `ModelInfo` 新增 `isCustom` 字段；`ButtonArea` 改用 `readCustomClaudeModels()` 构造自定义模型列表并打上标记。
- 下拉框里自定义模型若命中迁移表（即官方已下线），显示"已下线"标签，悬停提示"会原样发送"。新增 `models.retiredBadge` / `models.retiredCustomHint` 两个 i18n 键，10 种语言。
- Java 新增 `SessionState.setModelVerbatim` / `ClaudeSession.setModelVerbatim`，`ModelProviderHandler.handleSetModel` 改为调用它。恢复路径（`SessionLifecycleManager`、`ClaudeChatWindow` 持久化恢复、`HistoryMessageInjector`、`ChatWindowDelegate`）仍用 `setModel` 做迁移。
- 前端持久化恢复后会把恢复的模型通过 `set_model` 回发 Java，所以 Java 的持久化恢复即便先迁移了一个自定义的已下线 ID，随后也会被前端回发的原始 ID 覆盖，两侧最终一致。
- 顺带修了 `ModelProviderHandler.resolveConfiguredClaudeModelFromSettings` 在没有 settings service 时的空指针。

已知边界：迁移表里目前只剩 sonnet-4-6、sonnet-4-7、opus-4-8 三个真正停服的 ID。用户把它们添加为自定义模型时，插件会原样发送，由 API 返回报错。

## 2.2 第二个根因：Node 桥接层把模型 ID 换成家族别名（2026-09-22 实测）

装上 2.1 的包后，Java 日志已是 `sendToClaude ... model=claude-opus-4-6[1m]`，但会话 jsonl 里 assistant 消息的 `model` 仍是 `claude-opus-5`。问题在 Java 之后的 `ai-bridge`：

- `utils/model-utils.js` 的 `mapModelIdToSdkName` 把任何含 `opus` 的 ID 都换成别名 `opus` 交给 SDK，真实版本靠 `setModelEnvironmentVariables` 写入 `process.env.ANTHROPIC_DEFAULT_OPUS_MODEL` 告诉 CLI。
- `config/api-config.js` 的 `buildWebviewControlledSettingsOverride`（`2f7c71d7`，2026-08-03）为了防止 settings.json 里的旧值泄漏，把 `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL` 全部以 settings 覆盖为空串。Claude Code 以 settings 为准，环境变量被清掉，`opus` 落到 CLI 默认的 Opus 5。

用桥接层实际加载的 SDK（`~/.codemoss/dependencies/claude-sdk`，0.3.278）直接调 `query()` 复现：

| options.model | env 里的 `ANTHROPIC_DEFAULT_OPUS_MODEL` | settings 覆盖 | 实际模型 |
|---|---|---|---|
| `opus` | 无 | 有（桥接层现状） | claude-opus-5 |
| `opus` | `claude-opus-4-6[1m]` | 有 | claude-opus-5 |
| `opus` | `claude-opus-4-6[1m]` | 无 | claude-opus-4-6 |
| `claude-opus-4-6[1m]` | 无 | 有 | claude-opus-4-6 |

这个缺陷与插件的迁移表无关，任何非 CLI 默认版本的 Opus / Sonnet / Haiku 在 daemon 路径都选不中。`/context` 路径的 `applyExactModelForContextUsage` 早已改用精确 ID，只是发送路径没跟上。

修法：新增 `resolveSdkModelName(modelId, resolvedModelId)`，有解析结果就把精确 ID 作为 `options.model` 交给 SDK，别名只作兜底。改了四处：`persistent-query-service.js`（daemon 发送）、`message-sender.js`（非 daemon 发送，两处）、`prompt-enhancer.js` 和 `commit-message.js`（AI 功能）。运行时签名因此包含精确模型 ID，切换模型版本会重建运行时而不是 `setModel`，行为更准确。

---

## 3. 验证步骤

1. 前端单测：

   ```bash
   cd webview && npm test
   ```

2. Java 单测与构建：

   ```bash
   ./gradlew test buildPlugin
   ```

3. 安装 `build/distributions/` 下的 zip（Settings → Plugins → ⚙ → Install Plugin from Disk），重启 IDEA。

4. 自定义模型 ID 填 `claude-opus-4-6`，显示名任意。打开下拉框，确认只有 Opus 4.6 一项打勾。

5. 发一条消息后，在 IDE 日志（macOS：`~/Library/Logs/JetBrains/<IDE 版本>/idea.log`）里确认：

   ```
   [ModelProviderHandler] Setting model to: claude-opus-4-6[1m]
   sendToClaude ... model=claude-opus-4-6[1m]
   ```

6. 在对应会话的 `~/.claude/projects/<项目>/<sessionId>.jsonl` 里确认 assistant 消息的 `"model"` 字段为 `claude-opus-4-6`。不要以模型的自述为准，它回答的版本号不可靠。

---

## 4. 附：用户侧配置说明

`~/.claude/settings.json` 里的下面两段对 CC GUI **没有作用**，只影响终端里的 `claude` 命令，保留或删除均可：

```json
"availableModels": ["claude-fable-5-1", "Opus 4.6", "opus[1m]", "sonnet", "haiku"],
"modelOverrides": { "Opus 4.6": "claude-opus-4-6[1m]" }
```

CC GUI 的自定义模型 ID 必须填真实模型 ID `claude-opus-4-6`，1M 上下文由下拉框里的“1M 上下文”开关控制，不要在 ID 里手写 `[1m]`。
