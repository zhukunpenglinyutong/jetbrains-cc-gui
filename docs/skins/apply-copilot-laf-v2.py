from pathlib import Path
import re
import sys

PATCH_MARKER_START = "/* === Copilot screenshot look-and-feel overrides: BEGIN === */"
PATCH_MARKER_END = "/* === Copilot screenshot look-and-feel overrides: END === */"

ADDITIONS = r'''
/* === Copilot screenshot look-and-feel overrides: BEGIN === */
/*
 * Screenshot-oriented polish for the GitHub Copilot inspired skin.
 * Keep every selector scoped to data-theme="github-copilot" so dark/light stay unchanged.
 */

[data-theme="github-copilot"] {
    --copilot-shell-bg: #0d1117;
    --copilot-panel-bg: #161b22;
    --copilot-panel-raised-bg: #1c2128;
    --copilot-panel-subtle-bg: #11161d;
    --copilot-composer-bg: #3b3f47;
    --copilot-composer-border: #484f58;
    --copilot-tab-bg: #21262d;
    --copilot-code-header-bg: #161b22;
    --copilot-code-body-bg: #0d1117;
    --copilot-code-text: #c9d1d9;
    --copilot-code-accent: #e3b341;
    --copilot-muted-icon: #8b949e;
    --copilot-muted-icon-hover: #c9d1d9;
    --copilot-completed: #3fb950;
    --copilot-message-max-width: 100%;
    --copilot-body-font-size: 14px;
    --copilot-body-line-height: 1.65;
    --copilot-mono-font-size: 18px;
}

[data-theme="github-copilot"] body {
    background: #0b0f14;
}

[data-theme="github-copilot"] #app {
    background: var(--copilot-shell-bg);
    border-left: 0;
    border-radius: 8px 8px 0 0;
    box-shadow: inset 0 0 0 1px rgba(240, 246, 252, 0.04);
}

/* Top navigation and session header */
[data-theme="github-copilot"] .header {
    min-height: 40px;
    padding: 6px 10px 6px 14px;
    background: #161b22;
    border-bottom: 1px solid rgba(48, 54, 61, 0.85);
}

[data-theme="github-copilot"] .header-left {
    gap: 8px;
}

[data-theme="github-copilot"] .new-chat-button {
    height: 28px;
    padding: 4px 10px;
    border-radius: 6px;
    background: var(--copilot-tab-bg);
    border-color: #30363d;
    color: #c9d1d9;
    font-size: 12px;
    font-weight: 500;
    box-shadow: inset 0 1px 0 rgba(240, 246, 252, 0.04);
}

[data-theme="github-copilot"] .new-chat-button:hover {
    background: #30363d;
    border-color: #484f58;
    color: #f0f6fc;
}

[data-theme="github-copilot"] .back-button,
[data-theme="github-copilot"] .icon-button,
[data-theme="github-copilot"] .session-title-edit-btn {
    color: var(--copilot-muted-icon);
    border-radius: 6px;
}

[data-theme="github-copilot"] .back-button:hover,
[data-theme="github-copilot"] .icon-button:hover,
[data-theme="github-copilot"] .session-title-edit-btn:hover {
    color: var(--copilot-muted-icon-hover);
    background: rgba(110, 118, 129, 0.16);
}

[data-theme="github-copilot"] .session-title {
    color: #c9d1d9;
    font-size: 14px;
    font-weight: 500;
    padding-left: 4px;
}

/* Main chat surface */
[data-theme="github-copilot"] .messages-shell {
    background: var(--copilot-shell-bg);
    min-height: 0;
}

[data-theme="github-copilot"] .messages-container {
    padding: 0 0 8px;
    background: var(--copilot-shell-bg);
    scrollbar-color: var(--scrollbar-thumb) transparent;
}

[data-theme="github-copilot"] .messages-container::-webkit-scrollbar {
    width: 9px !important;
}

[data-theme="github-copilot"] .messages-container::-webkit-scrollbar-thumb {
    border-radius: 999px !important;
    border: 2px solid var(--copilot-shell-bg) !important;
    background-color: #484f58 !important;
}

/* Message layout and markdown typography */
[data-theme="github-copilot"] .message {
    padding: 12px 12px 18px;
    border-bottom: 0;
    color: #c9d1d9;
}

[data-theme="github-copilot"] .message.assistant {
    padding-left: 12px;
    padding-right: 18px;
}

[data-theme="github-copilot"] .message.assistant .message-content {
    max-width: var(--copilot-message-max-width);
    color: #c9d1d9;
    font-size: var(--copilot-body-font-size);
    line-height: var(--copilot-body-line-height);
}

[data-theme="github-copilot"] .message.assistant .message-content h1,
[data-theme="github-copilot"] .message.assistant .message-content h2,
[data-theme="github-copilot"] .message.assistant .message-content h3,
[data-theme="github-copilot"] .message.assistant .message-content h4 {
    margin: 14px 0 10px;
    color: #e6edf3;
    font-weight: 600;
    line-height: 1.35;
}

[data-theme="github-copilot"] .message.assistant .message-content h1 { font-size: 20px; }
[data-theme="github-copilot"] .message.assistant .message-content h2 { font-size: 18px; }
[data-theme="github-copilot"] .message.assistant .message-content h3 { font-size: 16px; }
[data-theme="github-copilot"] .message.assistant .message-content h4 { font-size: 15px; }

[data-theme="github-copilot"] .message.assistant .message-content p {
    margin: 10px 0;
}

[data-theme="github-copilot"] .message.assistant .message-content ul,
[data-theme="github-copilot"] .message.assistant .message-content ol {
    margin: 10px 0 10px 20px;
    padding-left: 0;
}

[data-theme="github-copilot"] .message.assistant .message-content li {
    margin: 3px 0;
    padding-left: 2px;
}

[data-theme="github-copilot"] .message.assistant .message-content a {
    color: #58a6ff;
    text-decoration: none;
}

[data-theme="github-copilot"] .message.assistant .message-content a:hover {
    text-decoration: underline;
}

[data-theme="github-copilot"] .message.assistant .message-content strong {
    color: #f0f6fc;
    font-weight: 600;
}

[data-theme="github-copilot"] .message.assistant .message-content blockquote {
    margin: 12px 0;
    padding: 0 0 0 12px;
    border-left: 3px solid #30363d;
    color: #8b949e;
}

/* Inline code and code block polish */
[data-theme="github-copilot"] .message.assistant .message-content :not(pre) > code,
[data-theme="github-copilot"] .message-content :not(pre) > code {
    padding: 0.16em 0.35em;
    border-radius: 6px;
    background: rgba(110, 118, 129, 0.22);
    color: #e3b341;
    font-size: 0.92em;
    white-space: break-spaces;
}

[data-theme="github-copilot"] .message-content pre,
[data-theme="github-copilot"] .markdown-body pre,
[data-theme="github-copilot"] .code-block,
[data-theme="github-copilot"] .code-block-container,
[data-theme="github-copilot"] [class*="codeBlock"],
[data-theme="github-copilot"] [class*="CodeBlock"] {
    overflow: hidden;
    margin: 12px 0 18px;
    border: 1px solid #30363d;
    border-radius: 8px;
    background: var(--copilot-code-body-bg);
    box-shadow: none;
}

[data-theme="github-copilot"] .message-content pre {
    padding: 14px 16px;
    overflow-x: auto;
}

[data-theme="github-copilot"] .message-content pre code,
[data-theme="github-copilot"] .markdown-body pre code,
[data-theme="github-copilot"] .code-block code,
[data-theme="github-copilot"] .code-block-container code {
    color: var(--copilot-code-text);
    background: transparent;
    font-size: var(--copilot-mono-font-size);
    line-height: 1.45;
    font-weight: 400;
}

[data-theme="github-copilot"] .code-block-header,
[data-theme="github-copilot"] .code-header,
[data-theme="github-copilot"] [class*="codeHeader"],
[data-theme="github-copilot"] [class*="CodeHeader"] {
    min-height: 32px;
    padding: 5px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--copilot-code-header-bg);
    border-bottom: 1px solid #30363d;
    color: #8b949e;
}

[data-theme="github-copilot"] .code-block-header button,
[data-theme="github-copilot"] .code-header button,
[data-theme="github-copilot"] [class*="codeHeader"] button,
[data-theme="github-copilot"] [class*="CodeHeader"] button {
    width: 24px;
    height: 24px;
    color: #8b949e;
    background: transparent;
    border: 0;
    border-radius: 6px;
}

[data-theme="github-copilot"] .code-block-header button:hover,
[data-theme="github-copilot"] .code-header button:hover,
[data-theme="github-copilot"] [class*="codeHeader"] button:hover,
[data-theme="github-copilot"] [class*="CodeHeader"] button:hover {
    color: #f0f6fc;
    background: rgba(110, 118, 129, 0.18);
}

/* User bubble: keep it Copilot-like, but less glossy than default */
[data-theme="github-copilot"] .message.user .message-content {
    background: linear-gradient(180deg, #8957e5 0%, #7c3aed 100%);
    border: 1px solid rgba(188, 140, 255, 0.28);
    border-radius: 14px 14px 4px 14px;
    box-shadow: 0 8px 20px rgba(76, 29, 149, 0.16);
    color: #ffffff;
}

/* Hover action buttons on messages */
[data-theme="github-copilot"] .message-copy-btn,
[data-theme="github-copilot"] .message-copy-btn-inline,
[data-theme="github-copilot"] .message-action-button,
[data-theme="github-copilot"] [class*="messageAction"] button {
    background: rgba(22, 27, 34, 0.88);
    border: 1px solid #30363d;
    color: #8b949e;
    border-radius: 6px;
}

[data-theme="github-copilot"] .message-copy-btn:hover,
[data-theme="github-copilot"] .message-copy-btn-inline:hover,
[data-theme="github-copilot"] .message-action-button:hover,
[data-theme="github-copilot"] [class*="messageAction"] button:hover {
    background: #21262d;
    border-color: #484f58;
    color: #f0f6fc;
}

/* Completed / model footer row under assistant output */
[data-theme="github-copilot"] .message-footer,
[data-theme="github-copilot"] .assistant-footer,
[data-theme="github-copilot"] .response-footer,
[data-theme="github-copilot"] [class*="messageFooter"],
[data-theme="github-copilot"] [class*="assistantFooter"],
[data-theme="github-copilot"] [class*="responseFooter"] {
    margin-top: 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: #8b949e;
    font-size: 12px;
}

[data-theme="github-copilot"] .completed,
[data-theme="github-copilot"] .completed-status,
[data-theme="github-copilot"] .status-completed,
[data-theme="github-copilot"] [class*="completed"],
[data-theme="github-copilot"] [class*="Completed"] {
    color: var(--copilot-completed);
}

[data-theme="github-copilot"] .model-label,
[data-theme="github-copilot"] .provider-label,
[data-theme="github-copilot"] [class*="modelLabel"],
[data-theme="github-copilot"] [class*="providerLabel"] {
    color: #8b949e;
    font-size: 12px;
}

/* Input composer: match the large rounded bottom surface in the screenshot */
[data-theme="github-copilot"] .input-area {
    padding: 10px 12px 12px;
    background: #0d1117;
    border-top: 1px solid rgba(48, 54, 61, 0.72);
}

[data-theme="github-copilot"] .input-container {
    min-height: 108px;
    gap: 8px;
    padding: 9px 12px 8px;
    border-radius: 10px;
    background: var(--copilot-composer-bg);
    border: 1px solid var(--copilot-composer-border);
    box-shadow: none;
}

[data-theme="github-copilot"] .input-container:focus-within {
    border-color: #6e7681;
    box-shadow: 0 0 0 1px rgba(110, 118, 129, 0.35);
}

[data-theme="github-copilot"] #messageInput {
    min-height: 44px;
    color: #f0f6fc;
    font-size: 13px;
    line-height: 1.5;
}

[data-theme="github-copilot"] #messageInput::placeholder {
    color: #a7adb6;
}

[data-theme="github-copilot"] .input-footer {
    padding-top: 2px;
    color: #c9d1d9;
}

[data-theme="github-copilot"] .input-tools-left,
[data-theme="github-copilot"] .input-actions {
    gap: 6px;
}

[data-theme="github-copilot"] .tool-button-placeholder,
[data-theme="github-copilot"] .input-footer button,
[data-theme="github-copilot"] .chat-input-toolbar button,
[data-theme="github-copilot"] [class*="toolbar"] button,
[data-theme="github-copilot"] [class*="Toolbar"] button {
    color: #c9d1d9;
    background: transparent;
    border-radius: 7px;
}

[data-theme="github-copilot"] .tool-button-placeholder:hover,
[data-theme="github-copilot"] .input-footer button:hover,
[data-theme="github-copilot"] .chat-input-toolbar button:hover,
[data-theme="github-copilot"] [class*="toolbar"] button:hover,
[data-theme="github-copilot"] [class*="Toolbar"] button:hover {
    color: #f0f6fc;
    background: rgba(255, 255, 255, 0.08);
}

[data-theme="github-copilot"] .action-button {
    width: 30px;
    height: 30px;
    border-radius: 999px;
}

[data-theme="github-copilot"] .send-button {
    background: #6e7681;
    color: #0d1117;
}

[data-theme="github-copilot"] .send-button:hover {
    background: #8b949e;
}

[data-theme="github-copilot"] .send-button:disabled {
    background: rgba(110, 118, 129, 0.32);
    color: rgba(201, 209, 217, 0.45);
}

[data-theme="github-copilot"] .stop-button {
    background: rgba(248, 81, 73, 0.10);
    border: 1px solid rgba(248, 81, 73, 0.38);
    color: #ff7b72;
}

/* Attachment chip visible above the composer text */
[data-theme="github-copilot"] .attachment-chip,
[data-theme="github-copilot"] .attachment-item,
[data-theme="github-copilot"] .file-chip,
[data-theme="github-copilot"] [class*="attachmentChip"],
[data-theme="github-copilot"] [class*="AttachmentChip"],
[data-theme="github-copilot"] [class*="fileChip"],
[data-theme="github-copilot"] [class*="FileChip"] {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    padding: 3px 8px;
    border-radius: 999px;
    background: rgba(88, 166, 255, 0.10);
    border: 1px solid rgba(88, 166, 255, 0.25);
    color: #8b949e;
    font-style: italic;
}

/* Dialogs, menus and settings panels should follow the same panel language. */
[data-theme="github-copilot"] .dialog-content,
[data-theme="github-copilot"] .context-menu,
[data-theme="github-copilot"] .settings-page,
[data-theme="github-copilot"] .settings-content,
[data-theme="github-copilot"] [class*="settingsContent"],
[data-theme="github-copilot"] [class*="Dialog"] {
    background: var(--copilot-panel-bg);
    border-color: #30363d;
    color: #c9d1d9;
}

[data-theme="github-copilot"] .waiting-indicator {
    margin-left: 12px;
    background: transparent;
    border: 0;
    box-shadow: none;
    padding: 8px 0;
}

[data-theme="github-copilot"] .waiting-spinner::before {
    border-width: 2px;
    border-color: rgba(139, 148, 158, 0.32);
    border-top-color: #c9d1d9;
}

/* === Copilot screenshot look-and-feel overrides: END === */
'''.strip() + "\n"


def find_repo_root(start: Path) -> Path:
    current = start.resolve()
    for candidate in [current] + list(current.parents):
        if (candidate / "webview" / "src" / "styles" / "app.less").exists():
            return candidate
    raise SystemExit("Could not find repository root. Run this script from the jetbrains-cc-gui repo root.")


def ensure_import(app_less: Path) -> None:
    text = app_less.read_text(encoding="utf-8")
    import_line = '@import "less/copilot-skin.less";'
    if import_line in text:
        return
    anchor = '@import "less/variables.less";'
    if anchor in text:
        text = text.replace(anchor, anchor + "\n" + import_line, 1)
    else:
        text = import_line + "\n" + text
    app_less.write_text(text, encoding="utf-8")


def upsert_copilot_overrides(copilot_less: Path) -> None:
    copilot_less.parent.mkdir(parents=True, exist_ok=True)
    if copilot_less.exists():
        text = copilot_less.read_text(encoding="utf-8")
    else:
        text = "/* GitHub Copilot inspired skin. */\n\n[data-theme=\"github-copilot\"] {\n    --bg-primary: #0d1117;\n    --bg-chat: #0d1117;\n}\n"

    pattern = re.compile(re.escape(PATCH_MARKER_START) + r".*?" + re.escape(PATCH_MARKER_END) + r"\n?", re.DOTALL)
    text = pattern.sub("", text).rstrip() + "\n\n" + ADDITIONS
    copilot_less.write_text(text, encoding="utf-8")


def main() -> None:
    root = find_repo_root(Path.cwd())
    app_less = root / "webview" / "src" / "styles" / "app.less"
    copilot_less = root / "webview" / "src" / "styles" / "less" / "copilot-skin.less"

    ensure_import(app_less)
    upsert_copilot_overrides(copilot_less)

    print("Applied Copilot look-and-feel v2 overrides:")
    print(f"- {app_less.relative_to(root)}")
    print(f"- {copilot_less.relative_to(root)}")
    print("\nNext:")
    print("  cd webview")
    print("  npm run test")
    print("  npm run build")
    print("  cd ..")
    print("  ./gradlew runIde")


if __name__ == "__main__":
    main()
