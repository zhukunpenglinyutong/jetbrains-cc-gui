# Local Provider Snapshot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add manual snapshot save/restore functionality for the local settings.json provider

**Architecture:** Backend adds snapshot management APIs in ProviderManager, frontend adds two buttons (Save/Restore) to local provider card with snapshot info display

**Tech Stack:** Java (backend), TypeScript/React (frontend), JSON file storage

---

## Task 1: Backend - Add Snapshot File Path Management

**Files:**
- Modify: `src/main/java/com/github/claudecodegui/settings/ConfigPathManager.java`

**Step 1: Add snapshot path method**

Add method to get the snapshot file path:

```java
/**
 * Get local provider snapshot file path (~/.codemoss/local-provider-snapshot.json).
 */
public Path getLocalProviderSnapshotPath() {
    return Paths.get(getCodemossDir(), "local-provider-snapshot.json");
}
```

**Step 2: Verify compilation**

Run: `./gradlew compileJava` (or equivalent build command)
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/main/java/com/github/claudecodegui/settings/ConfigPathManager.java
git commit -m "feat: add local provider snapshot path management"
```

---

## Task 2: Backend - Implement Snapshot Save API

**Files:**
- Modify: `src/main/java/com/github/claudecodegui/settings/ProviderManager.java`

**Step 1: Add saveLocalProviderSnapshot method**

Add the snapshot save implementation:

```java
/**
 * Save local provider snapshot.
 * @return snapshot timestamp
 */
public String saveLocalProviderSnapshot() throws IOException {
    // Read current settings.json
    JsonObject settings = claudeSettingsManager.readClaudeSettings();

    // Create snapshot object with timestamp
    JsonObject snapshot = new JsonObject();
    String timestamp = Instant.now().toString();
    snapshot.addProperty("timestamp", timestamp);
    snapshot.add("settings", settings.deepCopy()); // Deep copy to avoid reference

    // Write to snapshot file
    Path snapshotPath = pathManager.getLocalProviderSnapshotPath();
    if (!Files.exists(snapshotPath.getParent())) {
        Files.createDirectories(snapshotPath.getParent());
    }

    try (FileWriter writer = new FileWriter(snapshotPath.toFile())) {
        gson.toJson(snapshot, writer);
        LOG.info("[ProviderManager] Saved local provider snapshot at: " + timestamp);
    }

    return timestamp;
}
```

**Step 2: Verify compilation**

Run: `./gradlew compileJava`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/main/java/com/github/claudecodegui/settings/ProviderManager.java
git commit -m "feat: implement save local provider snapshot API"
```

---

## Task 3: Backend - Implement Snapshot Restore API

**Files:**
- Modify: `src/main/java/com/github/claudecodegui/settings/ProviderManager.java`

**Step 1: Add restoreLocalProviderSnapshot method**

```java
/**
 * Restore local provider snapshot.
 * @return true if successfully restored
 */
public boolean restoreLocalProviderSnapshot() throws IOException {
    Path snapshotPath = pathManager.getLocalProviderSnapshotPath();

    if (!Files.exists(snapshotPath)) {
        LOG.warn("[ProviderManager] Snapshot file not found: " + snapshotPath);
        return false;
    }

    try (FileReader reader = new FileReader(snapshotPath.toFile())) {
        JsonObject snapshot = JsonParser.parseReader(reader).getAsJsonObject();

        if (!snapshot.has("settings") || snapshot.get("settings").isJsonNull()) {
            LOG.error("[ProviderManager] Invalid snapshot file: missing settings");
            return false;
        }

        JsonObject settings = snapshot.getAsJsonObject("settings").deepCopy();
        claudeSettingsManager.writeClaudeSettings(settings);

        String timestamp = snapshot.has("timestamp") ? snapshot.get("timestamp").getAsString() : "unknown";
        LOG.info("[ProviderManager] Restored local provider snapshot from: " + timestamp);
        return true;
    } catch (Exception e) {
        LOG.error("[ProviderManager] Failed to restore snapshot: " + e.getMessage(), e);
        throw new IOException("Failed to restore snapshot", e);
    }
}
```

**Step 2: Verify compilation**

Run: `./gradlew compileJava`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/main/java/com/github/claudecodegui/settings/ProviderManager.java
git commit -m "feat: implement restore local provider snapshot API"
```

---

## Task 4: Backend - Implement Snapshot Info API

**Files:**
- Modify: `src/main/java/com/github/claudecodegui/settings/ProviderManager.java`

**Step 1: Add getLocalProviderSnapshotInfo method**

```java
/**
 * Get local provider snapshot information.
 * @return JsonObject with exists and timestamp fields
 */
public JsonObject getLocalProviderSnapshotInfo() throws IOException {
    JsonObject info = new JsonObject();
    Path snapshotPath = pathManager.getLocalProviderSnapshotPath();

    if (!Files.exists(snapshotPath)) {
        info.addProperty("exists", false);
        info.addProperty("timestamp", "");
        return info;
    }

    try (FileReader reader = new FileReader(snapshotPath.toFile())) {
        JsonObject snapshot = JsonParser.parseReader(reader).getAsJsonObject();
        info.addProperty("exists", true);
        String timestamp = snapshot.has("timestamp") ? snapshot.get("timestamp").getAsString() : "";
        info.addProperty("timestamp", timestamp);
    } catch (Exception e) {
        LOG.warn("[ProviderManager] Failed to read snapshot info: " + e.getMessage());
        info.addProperty("exists", false);
        info.addProperty("timestamp", "");
    }

    return info;
}
```

**Step 2: Verify compilation**

Run: `./gradlew compileJava`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/main/java/com/github/claudecodegui/settings/ProviderManager.java
git commit -m "feat: implement get local provider snapshot info API"
```

---

## Task 5: Backend - Add Message Handlers

**Files:**
- Modify: `src/main/java/com/github/claudecodegui/handler/ProviderHandler.java`

**Step 1: Add handleSaveLocalSnapshot handler**

Add message handler for saving snapshot:

```java
/**
 * Save local provider snapshot
 */
private void handleSaveLocalSnapshot(String content) {
    try {
        String timestamp = context.getSettingsService().saveLocalProviderSnapshot();

        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.showSuccess",
                escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("toast.snapshotSaved")));
            // Trigger refresh of snapshot info
            handleGetSnapshotInfo("");
        });
    } catch (Exception e) {
        LOG.error("[ProviderHandler] Failed to save snapshot: " + e.getMessage(), e);
        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.showError",
                escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("toast.snapshotSaveFailed", e.getMessage())));
        });
    }
}
```

**Step 2: Add handleRestoreLocalSnapshot handler**

```java
/**
 * Restore local provider snapshot
 */
private void handleRestoreLocalSnapshot(String content) {
    try {
        boolean success = context.getSettingsService().restoreLocalProviderSnapshot();

        if (success) {
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showSuccess",
                    escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("toast.snapshotRestored")));
                // Refresh current config display
                handleGetCurrentClaudeConfig();
            });
        } else {
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError",
                    escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("toast.snapshotNotFound")));
            });
        }
    } catch (Exception e) {
        LOG.error("[ProviderHandler] Failed to restore snapshot: " + e.getMessage(), e);
        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.showError",
                escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("toast.snapshotRestoreFailed", e.getMessage())));
        });
    }
}
```

**Step 3: Add handleGetSnapshotInfo handler**

```java
/**
 * Get local provider snapshot info
 */
private void handleGetSnapshotInfo(String content) {
    try {
        JsonObject info = context.getSettingsService().getLocalProviderSnapshotInfo();
        String infoJson = new Gson().toJson(info);

        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.updateSnapshotInfo", infoJson);
        });
    } catch (Exception e) {
        LOG.error("[ProviderHandler] Failed to get snapshot info: " + e.getMessage(), e);
    }
}
```

**Step 4: Register message handlers in router**

Find the message routing logic and add:

```java
case "save_local_snapshot":
    handleSaveLocalSnapshot(message);
    break;
case "restore_local_snapshot":
    handleRestoreLocalSnapshot(message);
    break;
case "get_snapshot_info":
    handleGetSnapshotInfo(message);
    break;
```

**Step 5: Verify compilation**

Run: `./gradlew compileJava`
Expected: SUCCESS

**Step 6: Commit**

```bash
git add src/main/java/com/github/claudecodegui/handler/ProviderHandler.java
git commit -m "feat: add snapshot message handlers and routing"
```

---

## Task 6: Frontend - Add Snapshot State Management

**Files:**
- Modify: `webview/src/components/settings/hooks/useProviderManagement.ts`

**Step 1: Add snapshot state**

Add state for snapshot info:

```typescript
const [snapshotInfo, setSnapshotInfo] = useState<{
  exists: boolean;
  timestamp: string;
}>({ exists: false, timestamp: '' });
```

**Step 2: Add snapshot info callback**

Register callback for snapshot info updates:

```typescript
useEffect(() => {
  (window as any).updateSnapshotInfo = (dataOrStr: any) => {
    let data = dataOrStr;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (e) {
        console.error('Failed to parse snapshot info:', e);
        return;
      }
    }
    setSnapshotInfo(data);
  };

  // Request snapshot info on mount
  sendToJava('get_snapshot_info');

  return () => {
    delete (window as any).updateSnapshotInfo;
  };
}, []);
```

**Step 3: Add snapshot action handlers**

```typescript
const handleSaveSnapshot = useCallback(() => {
  sendToJava('save_local_snapshot');
}, []);

const handleRestoreSnapshot = useCallback(() => {
  if (window.confirm(t('settings.provider.confirmRestoreSnapshot'))) {
    sendToJava('restore_local_snapshot');
  }
}, [t]);
```

**Step 4: Export snapshot state and handlers**

Add to return object:

```typescript
return {
  // ... existing exports
  snapshotInfo,
  handleSaveSnapshot,
  handleRestoreSnapshot,
};
```

**Step 5: Verify TypeScript compilation**

Run: `npm run type-check` (or `tsc --noEmit`)
Expected: No errors

**Step 6: Commit**

```bash
git add webview/src/components/settings/hooks/useProviderManagement.ts
git commit -m "feat: add snapshot state management in provider hook"
```

---

## Task 7: Frontend - Update Local Provider Card UI

**Files:**
- Modify: `webview/src/components/settings/ProviderList/index.tsx`

**Step 1: Get snapshot state from hook**

In the component, destructure snapshot info:

```typescript
const { snapshotInfo, handleSaveSnapshot, handleRestoreSnapshot } = useProviderManagement(...);
```

**Step 2: Update local provider card JSX**

Replace the local provider card section (around line 343-373) with:

```tsx
<div
  key={LOCAL_PROVIDER_ID}
  className={`${styles.card} ${providers.some(p => p.id === LOCAL_PROVIDER_ID && p.isActive) ? styles.active : ''} ${styles.localProviderCard}`}
>
  <div className={styles.cardInfo}>
    <div className={styles.name}>
      <span className="codicon codicon-file" style={{ marginRight: '8px' }} />
      {t('settings.provider.localProviderName')}
    </div>
    <div className={styles.website} title={t('settings.provider.localProviderDescription')}>
      {t('settings.provider.localProviderDescription')}
    </div>

    {/* Snapshot feature hint */}
    <div className={styles.snapshotHint}>
      <div className={styles.hintIcon}>💡</div>
      <div className={styles.hintContent}>
        <div className={styles.hintTitle}>{t('settings.provider.snapshotFeature')}</div>
        <ul className={styles.hintList}>
          <li>{t('settings.provider.snapshotHint1')}</li>
          <li>{t('settings.provider.snapshotHint2')}</li>
          <li>{t('settings.provider.snapshotHint3')}</li>
        </ul>
      </div>
    </div>

    {/* Snapshot status */}
    <div className={styles.snapshotStatus}>
      {snapshotInfo.exists ? (
        <>
          <span className="codicon codicon-save" style={{ marginRight: '4px' }} />
          {t('settings.provider.lastSnapshot')}: {new Date(snapshotInfo.timestamp).toLocaleString()}
        </>
      ) : (
        <>
          <span className="codicon codicon-warning" style={{ marginRight: '4px' }} />
          {t('settings.provider.noSnapshot')}
        </>
      )}
    </div>
  </div>

  <div className={styles.cardActions}>
    {/* Snapshot buttons */}
    <div className={styles.snapshotActions}>
      <button
        className={styles.snapshotButton}
        onClick={handleSaveSnapshot}
        title={t('settings.provider.saveSnapshotTooltip')}
      >
        <span className="codicon codicon-save" />
        {t('settings.provider.saveSnapshot')}
      </button>
      <button
        className={styles.snapshotButton}
        onClick={handleRestoreSnapshot}
        disabled={!snapshotInfo.exists}
        title={t('settings.provider.restoreSnapshotTooltip')}
      >
        <span className="codicon codicon-history" />
        {t('settings.provider.restoreSnapshot')}
      </button>
    </div>

    {/* Use/In Use badge */}
    {providers.some(p => p.id === LOCAL_PROVIDER_ID && p.isActive) ? (
      <div className={styles.activeBadge}>
        <span className="codicon codicon-check" />
        {t('settings.provider.inUse')}
      </div>
    ) : (
      <button
        className={styles.useButton}
        onClick={() => onSwitch(LOCAL_PROVIDER_ID)}
      >
        <span className="codicon codicon-play" />
        {t('settings.provider.enable')}
      </button>
    )}
  </div>
</div>
```

**Step 3: Verify TypeScript compilation**

Run: `npm run type-check`
Expected: No errors

**Step 4: Commit**

```bash
git add webview/src/components/settings/ProviderList/index.tsx
git commit -m "feat: add snapshot UI to local provider card"
```

---

## Task 8: Frontend - Add Snapshot Styles

**Files:**
- Modify: `webview/src/components/settings/ProviderList/style.module.less`

**Step 1: Add snapshot-related styles**

```less
.snapshotHint {
  margin-top: 12px;
  padding: 12px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: 4px;
  display: flex;
  gap: 8px;
  font-size: 12px;

  .hintIcon {
    font-size: 16px;
    flex-shrink: 0;
  }

  .hintContent {
    flex: 1;
  }

  .hintTitle {
    font-weight: 600;
    margin-bottom: 6px;
    color: var(--vscode-foreground);
  }

  .hintList {
    margin: 0;
    padding-left: 20px;
    color: var(--vscode-descriptionForeground);

    li {
      margin-bottom: 4px;

      &:last-child {
        margin-bottom: 0;
      }
    }
  }
}

.snapshotStatus {
  margin-top: 8px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  display: flex;
  align-items: center;
}

.snapshotActions {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.snapshotButton {
  padding: 6px 12px;
  border: 1px solid var(--vscode-button-border);
  background-color: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  cursor: pointer;
  border-radius: 4px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
  transition: background-color 0.2s;

  &:hover:not(:disabled) {
    background-color: var(--vscode-button-secondaryHoverBackground);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}
```

**Step 2: Verify build**

Run: `npm run build`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add webview/src/components/settings/ProviderList/style.module.less
git commit -m "feat: add snapshot feature styles"
```

---

## Task 9: Add i18n Translations

**Files:**
- Modify: `webview/src/locales/zh-CN.json`
- Modify: `webview/src/locales/en-US.json`
- Modify: `src/main/resources/messages/ClaudeCodeGuiBundle.properties` (or equivalent)

**Step 1: Add Chinese translations**

In `zh-CN.json`, add under `settings.provider`:

```json
"snapshotFeature": "快照功能：",
"snapshotHint1": "切换供应商会修改 ~/.claude/settings.json",
"snapshotHint2": "切换前建议先"保存快照"备份配置",
"snapshotHint3": "之后可随时"恢复快照"还原配置",
"lastSnapshot": "最后快照",
"noSnapshot": "暂无快照",
"saveSnapshot": "保存快照",
"restoreSnapshot": "恢复快照",
"saveSnapshotTooltip": "备份当前 settings.json 配置",
"restoreSnapshotTooltip": "从备份恢复配置",
"confirmRestoreSnapshot": "确定要恢复快照吗？当前的 settings.json 配置将被覆盖。"
```

In `toast` section:

```json
"snapshotSaved": "快照已保存",
"snapshotRestored": "配置已恢复",
"snapshotNotFound": "快照文件不存在",
"snapshotSaveFailed": "保存快照失败: {0}",
"snapshotRestoreFailed": "恢复快照失败: {0}"
```

**Step 2: Add English translations**

In `en-US.json`, add under `settings.provider`:

```json
"snapshotFeature": "Snapshot Feature:",
"snapshotHint1": "Switching providers will modify ~/.claude/settings.json",
"snapshotHint2": "Recommend saving snapshot before switching",
"snapshotHint3": "You can restore snapshot anytime to revert config",
"lastSnapshot": "Last Snapshot",
"noSnapshot": "No Snapshot",
"saveSnapshot": "Save Snapshot",
"restoreSnapshot": "Restore Snapshot",
"saveSnapshotTooltip": "Backup current settings.json config",
"restoreSnapshotTooltip": "Restore config from backup",
"confirmRestoreSnapshot": "Are you sure to restore snapshot? Current settings.json will be overwritten."
```

In `toast` section:

```json
"snapshotSaved": "Snapshot saved",
"snapshotRestored": "Config restored",
"snapshotNotFound": "Snapshot file not found",
"snapshotSaveFailed": "Failed to save snapshot: {0}",
"snapshotRestoreFailed": "Failed to restore snapshot: {0}"
```

**Step 3: Add Java bundle properties**

In `ClaudeCodeGuiBundle.properties`:

```properties
toast.snapshotSaved=Snapshot saved
toast.snapshotRestored=Config restored
toast.snapshotNotFound=Snapshot file not found
toast.snapshotSaveFailed=Failed to save snapshot: {0}
toast.snapshotRestoreFailed=Failed to restore snapshot: {0}
```

**Step 4: Verify build**

Run: `npm run build && ./gradlew build`
Expected: SUCCESS

**Step 5: Commit**

```bash
git add webview/src/locales/*.json src/main/resources/messages/*.properties
git commit -m "feat: add snapshot feature i18n translations"
```

---

## Task 10: Manual Testing and Verification

**Step 1: Start the application**

Run: `./gradlew runIde` (or appropriate command to start plugin)

**Step 2: Test save snapshot**

1. Open settings page
2. Navigate to provider management section
3. Ensure local provider card displays snapshot hint
4. Click "保存快照" button
5. Verify toast shows "快照已保存"
6. Verify snapshot timestamp displays under the hint

**Step 3: Test restore snapshot**

1. Click "恢复快照" button
2. Verify confirmation dialog appears
3. Click confirm
4. Verify toast shows "配置已恢复"

**Step 4: Test snapshot persistence**

1. Save a snapshot
2. Switch to another provider (e.g., ccNexus)
3. Verify settings.json is modified
4. Switch back to local provider
5. Click "恢复快照"
6. Verify settings.json is restored to previous state

**Step 5: Test edge cases**

1. Test restore when no snapshot exists (button should be disabled)
2. Test saving snapshot multiple times (should overwrite)
3. Test with invalid snapshot file (manually corrupt the file)

**Step 6: Document test results**

Create: `docs/testing/2026-03-01-snapshot-manual-test-results.md`

Document all test results with screenshots if possible.

**Step 7: Commit test documentation**

```bash
git add docs/testing/2026-03-01-snapshot-manual-test-results.md
git commit -m "docs: add manual test results for snapshot feature"
```

---

## Task 11: Final Code Review and Cleanup

**Step 1: Review all changes**

Run: `git diff main...HEAD`

Check for:
- Proper error handling
- Immutability (no mutation of JsonObjects)
- Code comments where logic is complex
- No console.log statements
- No hardcoded values

**Step 2: Run full build**

```bash
npm run build
./gradlew build
```

Expected: SUCCESS with no warnings

**Step 3: Format code**

Run code formatters:
```bash
npm run format
./gradlew spotlessApply
```

**Step 4: Final commit**

```bash
git add .
git commit -m "chore: code cleanup and formatting for snapshot feature"
```

---

## Completion Checklist

- [ ] Backend snapshot APIs implemented (save, restore, getInfo)
- [ ] Message handlers added and registered
- [ ] Frontend state management implemented
- [ ] UI updated with snapshot buttons and status
- [ ] Styles added for snapshot components
- [ ] i18n translations added (zh-CN, en-US)
- [ ] Manual testing completed
- [ ] Code reviewed and cleaned up
- [ ] All commits following conventional commit format
- [ ] No compilation errors or warnings

## References

- Design Document: `docs/plans/2026-03-01-local-provider-snapshot-design.md`
- Existing Code: `ProviderManager.java`, `ProviderHandler.java`, `ProviderList/index.tsx`
- @coding-style: Follow immutability, error handling, input validation
- @git-workflow: Use conventional commits, frequent commits

---

**Estimated Time:** 2-3 hours for full implementation
**Risk Level:** Low (isolated feature, no impact on existing providers)
**Testing Priority:** High (manual testing critical for UX validation)
