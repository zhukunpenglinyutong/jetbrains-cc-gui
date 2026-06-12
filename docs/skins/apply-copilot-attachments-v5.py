from pathlib import Path
import re

ROOT = Path.cwd()


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding='utf-8')


def replace_once(path: str, old: str, new: str, description: str) -> bool:
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    if new in text:
        print(f'skip {description}: already applied')
        return False
    if old not in text:
        raise RuntimeError(f'Could not find expected block for {description} in {path}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')
    print(f'patched {description}')
    return True


def ensure_contains(path: str, marker: str, addition: str) -> None:
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    if marker in text:
        print(f'skip {path}: marker already present')
        return
    p.write_text(text + addition, encoding='utf-8')
    print(f'patched {path}: appended import')


def patch_attachment_list() -> None:
    path = 'webview/src/components/ChatInputBox/AttachmentList.tsx'
    text = read(path)

    if "../copilotIcons" not in text:
        text = text.replace(
            "import { isImageAttachment } from './types';\n",
            "import { isImageAttachment } from './types';\nimport { CopilotIcon } from '../copilotIcons';\n",
            1,
        )

    old = """      <div className=\"attachment-list\">\n        {attachments.map((attachment) => (\n          <div\n            key={attachment.id}\n            className=\"attachment-item\"\n            onClick={() => handleClick(attachment)}\n            title={attachment.fileName}\n          >\n            {isImageAttachment(attachment) ? (\n              <img\n                className=\"attachment-thumbnail\"\n                src={`data:${attachment.mediaType};base64,${attachment.data}`}\n                alt={attachment.fileName}\n              />\n            ) : (\n              <div className=\"attachment-file\">\n                <span className={`attachment-file-icon codicon ${getFileIcon(attachment.mediaType)}`} />\n                <span className=\"attachment-file-name\">\n                  {getExtension(attachment.fileName) || attachment.fileName.slice(0, 6)}\n                </span>\n              </div>\n            )}\n\n            <button\n              className=\"attachment-remove\"\n              onClick={(e) => handleRemove(e, attachment.id)}\n              title={t('chat.removeAttachment')}\n            >\n              ×\n            </button>\n          </div>\n        ))}\n      </div>"""

    new = """      <div className=\"attachment-list\" role=\"list\" aria-label=\"Attachments\">\n        {attachments.map((attachment) => {\n          const imageAttachment = isImageAttachment(attachment);\n          const extension = getExtension(attachment.fileName);\n          const fallbackName = extension || attachment.fileName.slice(0, 6);\n\n          return (\n            <div\n              key={attachment.id}\n              className={`attachment-item ${imageAttachment ? 'attachment-item-image' : 'attachment-item-file'}`}\n              onClick={() => handleClick(attachment)}\n              title={attachment.fileName}\n              role=\"listitem\"\n            >\n              <span className=\"attachment-preview-frame\">\n                {imageAttachment ? (\n                  <img\n                    className=\"attachment-thumbnail\"\n                    src={`data:${attachment.mediaType};base64,${attachment.data}`}\n                    alt={attachment.fileName}\n                  />\n                ) : (\n                  <span className={`attachment-file-icon codicon ${getFileIcon(attachment.mediaType)}`} />\n                )}\n              </span>\n\n              <span className=\"attachment-label\">\n                {imageAttachment ? attachment.fileName : fallbackName}\n              </span>\n\n              <button\n                className=\"attachment-remove\"\n                onClick={(e) => handleRemove(e, attachment.id)}\n                title={t('chat.removeAttachment')}\n                aria-label={t('chat.removeAttachment')}\n              >\n                <CopilotIcon name=\"x\" size={12} />\n              </button>\n            </div>\n          );\n        })}\n      </div>"""

    if old not in text and new not in text:
        raise RuntimeError('Could not find attachment list JSX block. The file may have changed; patch manually.')
    if new not in text:
        text = text.replace(old, new, 1)
        print('patched AttachmentList JSX')
    else:
        print('skip AttachmentList JSX: already applied')

    write(path, text)


def patch_header_order() -> None:
    path = 'webview/src/components/ChatInputBox/ChatInputBoxHeader.tsx'
    text = read(path)
    old = """      {/* Attachment list */}\n      {attachments.length > 0 && (\n        <AttachmentList attachments={attachments} onRemove={onRemoveAttachment} />\n      )}\n\n      {/* Context bar (Top Control Bar) */}\n      <ContextBar\n        activeFile={activeFile}\n        selectedLines={selectedLines}\n        percentage={usagePercentage}\n        usedTokens={usageUsedTokens}\n        maxTokens={usageMaxTokens}\n        showUsage={showUsage}\n        onClearFile={onClearContext}\n        onAddAttachment={onAddAttachment}\n        selectedAgent={selectedAgent}\n        onClearAgent={onClearAgent}\n        currentProvider={currentProvider}\n        hasMessages={hasMessages}\n        onRewind={onRewind}\n        statusPanelExpanded={statusPanelExpanded}\n        onToggleStatusPanel={onToggleStatusPanel}\n        autoOpenFileEnabled={autoOpenFileEnabled}\n        onRequestEnableFileContext={onRequestEnableFileContext}\n      />"""
    new = """      {/* Context bar (Top Control Bar) */}\n      <ContextBar\n        activeFile={activeFile}\n        selectedLines={selectedLines}\n        percentage={usagePercentage}\n        usedTokens={usageUsedTokens}\n        maxTokens={usageMaxTokens}\n        showUsage={showUsage}\n        onClearFile={onClearContext}\n        onAddAttachment={onAddAttachment}\n        selectedAgent={selectedAgent}\n        onClearAgent={onClearAgent}\n        currentProvider={currentProvider}\n        hasMessages={hasMessages}\n        onRewind={onRewind}\n        statusPanelExpanded={statusPanelExpanded}\n        onToggleStatusPanel={onToggleStatusPanel}\n        autoOpenFileEnabled={autoOpenFileEnabled}\n        onRequestEnableFileContext={onRequestEnableFileContext}\n      />\n\n      {/* Attachment strip - keep it closest to the editable prompt, like GitHub Copilot. */}\n      {attachments.length > 0 && (\n        <AttachmentList attachments={attachments} onRemove={onRemoveAttachment} />\n      )}"""
    if new in text:
        print('skip ChatInputBoxHeader order: already applied')
        return
    if old not in text:
        raise RuntimeError('Could not find ChatInputBoxHeader attachment/context block. The file may have changed; patch manually.')
    write(path, text.replace(old, new, 1))
    print('patched ChatInputBoxHeader order')


def write_css() -> None:
    content = r'''/* GitHub Copilot inspired attachment strip.
   Scoped to the Copilot theme and loaded from ChatInputBox/styles.css so it wins over component-local CSS. */

html[data-theme="github-copilot"] .chat-input-box {
  --copilot-attachment-strip-bg: rgba(13, 17, 23, 0.72);
  --copilot-attachment-chip-bg: rgba(22, 27, 34, 0.86);
  --copilot-attachment-chip-bg-hover: rgba(33, 38, 45, 0.94);
  --copilot-attachment-chip-border: rgba(88, 166, 255, 0.20);
  --copilot-attachment-chip-border-hover: rgba(88, 166, 255, 0.42);
  --copilot-attachment-thumbnail-border: rgba(240, 246, 252, 0.10);
  --copilot-attachment-remove-bg-hover: rgba(248, 81, 73, 0.14);
  --copilot-attachment-remove-border-hover: rgba(248, 81, 73, 0.32);
}

html[data-theme="github-copilot"] .attachment-list {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  min-height: 62px;
  padding: 6px 12px 10px;
  margin: 0;
  overflow-x: auto;
  overflow-y: hidden;
  border-bottom: none;
  background:
    linear-gradient(90deg, rgba(88, 166, 255, 0.09), transparent 22%, transparent 78%, rgba(137, 87, 229, 0.08)),
    var(--copilot-attachment-strip-bg);
  scrollbar-width: thin;
  scrollbar-color: rgba(139, 148, 158, 0.42) transparent;
}

html[data-theme="github-copilot"] .context-bar + .attachment-list {
  padding-top: 4px;
}

html[data-theme="github-copilot"] .attachment-list::-webkit-scrollbar {
  height: 6px !important;
}

html[data-theme="github-copilot"] .attachment-list::-webkit-scrollbar-thumb {
  background-color: rgba(139, 148, 158, 0.42) !important;
  border-radius: 999px !important;
  border: 2px solid transparent !important;
}

html[data-theme="github-copilot"] .attachment-item {
  position: relative;
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 8px;
  width: auto;
  min-width: 132px;
  max-width: 230px;
  height: 48px;
  padding: 4px 30px 4px 5px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--copilot-attachment-chip-bg);
  border: 1px solid var(--copilot-attachment-chip-border);
  box-shadow: 0 1px 0 rgba(240, 246, 252, 0.04) inset;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    transform 0.15s ease;
}

html[data-theme="github-copilot"] .attachment-item:hover {
  background: var(--copilot-attachment-chip-bg-hover);
  border-color: var(--copilot-attachment-chip-border-hover);
  transform: translateY(-1px);
}

html[data-theme="github-copilot"] .attachment-item-image {
  min-width: 150px;
}

html[data-theme="github-copilot"] .attachment-preview-frame {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  border-radius: 8px;
  overflow: hidden;
  background: #0d1117;
  border: 1px solid var(--copilot-attachment-thumbnail-border);
}

html[data-theme="github-copilot"] .attachment-thumbnail {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

html[data-theme="github-copilot"] .attachment-file-icon {
  font-size: 18px;
  color: #58a6ff;
}

html[data-theme="github-copilot"] .attachment-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #c9d1d9;
  font-size: 12px;
  line-height: 1.2;
  letter-spacing: 0;
}

html[data-theme="github-copilot"] .attachment-item-image .attachment-label {
  color: #dbeafe;
}

html[data-theme="github-copilot"] .attachment-remove {
  position: absolute;
  top: 6px;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: #8b949e;
  opacity: 0.82;
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease,
    border-color 0.15s ease,
    opacity 0.15s ease;
}

html[data-theme="github-copilot"] .attachment-item:hover .attachment-remove,
html[data-theme="github-copilot"] .attachment-remove:focus-visible {
  opacity: 1;
}

html[data-theme="github-copilot"] .attachment-remove:hover {
  background: var(--copilot-attachment-remove-bg-hover);
  border-color: var(--copilot-attachment-remove-border-hover);
  color: #ff7b72;
}

html[data-theme="github-copilot"] .attachment-remove svg {
  width: 12px;
  height: 12px;
  stroke-width: 2;
}

html[data-theme="github-copilot"] .image-preview-overlay {
  background: rgba(1, 4, 9, 0.78);
  backdrop-filter: blur(10px);
}

html[data-theme="github-copilot"] .image-preview-content {
  border-radius: 12px;
  border: 1px solid rgba(88, 166, 255, 0.26);
  box-shadow: 0 24px 80px rgba(1, 4, 9, 0.65);
}

html[data-theme="github-copilot"] .image-preview-close {
  background: rgba(22, 27, 34, 0.92);
  border: 1px solid rgba(240, 246, 252, 0.12);
  color: #c9d1d9;
}

html[data-theme="github-copilot"] .image-preview-close:hover {
  background: rgba(248, 81, 73, 0.14);
  border-color: rgba(248, 81, 73, 0.32);
  color: #ff7b72;
}
'''
    write('webview/src/components/ChatInputBox/styles/copilot-attachments.css', content)


def patch_styles_import() -> None:
    path = 'webview/src/components/ChatInputBox/styles.css'
    text = read(path)
    marker = "@import './styles/copilot-attachments.css';"
    if marker in text:
        print('skip ChatInputBox/styles.css import: already applied')
        return
    # Load after all component CSS so the scoped Copilot rules win without !important.
    text = text.rstrip() + "\n@import './styles/copilot-attachments.css';\n"
    write(path, text)
    print('patched ChatInputBox/styles.css import')


def write_doc() -> None:
    doc = r'''# Copilot attachment strip v5

This patch makes the ChatInputBox attachment area behave like a GitHub Copilot inspired attachment strip.

## What changed

- `AttachmentList` now renders attachment chips with a preview frame, label and Copilot-inspired close icon.
- `ChatInputBoxHeader` renders context controls first and the attachment strip directly above the editable prompt area.
- `ChatInputBox/styles.css` imports `styles/copilot-attachments.css` last, so scoped Copilot rules override component-local defaults.

## Mapping

| Fork element | Copilot-inspired mapping |
| --- | --- |
| `.attachment-list` | horizontal strip inside the composer |
| `.attachment-item-image` | image preview chip |
| `.attachment-preview-frame` | thumbnail frame |
| `.attachment-label` | filename label, visually secondary |
| `.attachment-remove` | quiet circular close action |
| `.image-preview-overlay` | dark translucent preview surface |

The rules are scoped to `html[data-theme="github-copilot"]` so normal dark/light themes are not redesigned.
'''
    write('docs/copilot-attachments-v5.md', doc)


def main() -> None:
    patch_attachment_list()
    patch_header_order()
    write_css()
    patch_styles_import()
    write_doc()
    print('\nCopilot attachment strip v5 patch applied.')
    print('Run: cd webview && npm run test && npm run build')


if __name__ == '__main__':
    main()
