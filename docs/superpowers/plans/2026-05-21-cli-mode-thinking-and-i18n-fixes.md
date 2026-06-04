# CLI Mode Thinking And I18n Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore CLI-mode thinking visibility, normalize stray stdin startup text, and complete invocation mode Chinese i18n text.

**Architecture:** Keep existing SDK and CLI routing intact, but normalize CLI event parsing so provider-specific raw output is converted into the same frontend-facing stream markers and thinking deltas used by the existing message handlers. Fill the missing invocation-mode translation keys directly in the locale file used by the settings UI.

**Tech Stack:** Java, JUnit4, React i18n JSON locales

---

### Task 1: Lock Regression Coverage

**Files:**
- Modify: `src/test/java/com/github/claudecodegui/provider/claude/ClaudeCliStreamParserTest.java`
- Create: `src/test/java/com/github/claudecodegui/cli/codex/CodexCliSessionTest.java`

- [ ] **Step 1: Add failing Claude CLI thinking test**
- [ ] **Step 2: Add failing Codex CLI stdin/thinking normalization tests**
- [ ] **Step 3: Run targeted tests to verify failures**

### Task 2: Restore CLI Thinking And Filter Stdin Noise

**Files:**
- Modify: `src/main/java/com/github/claudecodegui/provider/claude/ClaudeCliBridge.java`
- Modify: `src/main/java/com/github/claudecodegui/cli/codex/CodexCliSession.java`

- [ ] **Step 1: Stop suppressing Claude CLI thinking blocks**
- [ ] **Step 2: Parse Codex CLI reasoning events into `thinking_delta`**
- [ ] **Step 3: Ignore `Reading additional input from stdin...` raw noise**
- [ ] **Step 4: Normalize non-JSON fallback lines to connected/loading state behavior**
- [ ] **Step 5: Run targeted Java tests to verify green**

### Task 3: Complete Invocation Mode Chinese Locale

**Files:**
- Modify: `webview/src/i18n/locales/zh.json`

- [ ] **Step 1: Add missing `settings.basic.invocationMode.*` keys**
- [ ] **Step 2: Verify key names match `EnvironmentTab.tsx` usage exactly**

### Task 4: Final Verification

**Files:**
- Modify: `src/test/java/com/github/claudecodegui/provider/claude/ClaudeCliStreamParserTest.java`
- Modify: `src/test/java/com/github/claudecodegui/cli/codex/CodexCliSessionTest.java`
- Modify: `src/main/java/com/github/claudecodegui/provider/claude/ClaudeCliBridge.java`
- Modify: `src/main/java/com/github/claudecodegui/cli/codex/CodexCliSession.java`
- Modify: `webview/src/i18n/locales/zh.json`

- [ ] **Step 1: Run targeted Java tests**
- [ ] **Step 2: Run any relevant frontend test or static verification available for i18n usage**
- [ ] **Step 3: Review diff for unrelated changes and leave user edits untouched**
