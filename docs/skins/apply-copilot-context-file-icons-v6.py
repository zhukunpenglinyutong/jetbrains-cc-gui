from pathlib import Path
import re

ROOT = Path.cwd()


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding='utf-8')


def ensure_import(path: str, marker: str, after: str, addition: str) -> None:
    text = read(path)
    if marker in text:
        return
    if after not in text:
        raise RuntimeError(f'Could not find import anchor in {path}: {after!r}')
    write(path, text.replace(after, after + addition, 1))


def patch_context_bar() -> None:
    path = 'webview/src/components/ChatInputBox/ContextBar.tsx'
    text = read(path)

    text = text.replace("import { getFileIcon } from '../../utils/fileIcons';\n", "")
    if "../copilotIcons" not in text:
        text = text.replace(
            "import { TokenIndicator } from './TokenIndicator';\n",
            "import { TokenIndicator } from './TokenIndicator';\nimport { CopilotIcon } from '../copilotIcons';\n",
            1,
        )

    old_helper = """  const getFileIconSvg = (path: string) => {\n    const fileName = getFileName(path);\n    const extension = fileName.indexOf('.') !== -1 ? fileName.split('.').pop() : '';\n    return getFileIcon(extension, fileName);\n  };"""
    new_helper = """  const getContextFileIconName = (path: string): 'code' | 'file' => {\n    const fileName = getFileName(path);\n    const extension = fileName.indexOf('.') !== -1\n      ? (fileName.split('.').pop() || '').toLowerCase()\n      : '';\n    const codeExtensions = new Set([\n      'bat', 'c', 'cmd', 'cpp', 'cs', 'css', 'go', 'gradle', 'groovy', 'h', 'hpp',\n      'html', 'java', 'js', 'json', 'jsx', 'kt', 'kts', 'less', 'md', 'properties',\n      'py', 'rs', 'scss', 'sh', 'sql', 'ts', 'tsx', 'xml', 'yaml', 'yml',\n    ]);\n    return codeExtensions.has(extension) ? 'code' : 'file';\n  };"""
    if old_helper in text:
        text = text.replace(old_helper, new_helper, 1)
    elif 'const getContextFileIconName' not in text:
        raise RuntimeError('Could not find getFileIconSvg helper in ContextBar.tsx')

    replacements = {
        '<span className="codicon codicon-attach" />': '<CopilotIcon name="attachment" size={16} aria-hidden="true" />',
        '<span\n            className="codicon codicon-robot"\n            style={ROBOT_ICON_STYLE}\n          />': '<CopilotIcon\n            className="context-agent-icon"\n            name="agent"\n            size={15}\n            style={ROBOT_ICON_STYLE}\n            aria-hidden="true"\n          />',
        '<span className="codicon codicon-file" />': '<CopilotIcon name="file" size={14} aria-hidden="true" />',
        '<span className={`codicon ${statusPanelExpanded ? \'codicon-chevron-down\' : \'codicon-layers\'}`} />': '<CopilotIcon name={statusPanelExpanded ? \'chevronDown\' : \'tool\'} size={15} aria-hidden="true" />',
        '<span className="codicon codicon-discard" />': '<CopilotIcon name="history" size={15} aria-hidden="true" />',
    }
    for old, new in replacements.items():
        text = text.replace(old, new)

    old_active_icon = """          {activeFile && (\n            <span\n              className="context-file-icon"\n              style={FILE_ICON_STYLE}\n              dangerouslySetInnerHTML={{ __html: getFileIconSvg(activeFile) }}\n            />\n          )}"""
    new_active_icon = """          {activeFile && (\n            <CopilotIcon\n              className={`context-file-icon context-file-icon-${getContextFileIconName(activeFile)}`}\n              name={getContextFileIconName(activeFile)}\n              size={15}\n              style={FILE_ICON_STYLE}\n              aria-hidden="true"\n            />\n          )}"""
    if old_active_icon in text:
        text = text.replace(old_active_icon, new_active_icon, 1)
    elif 'dangerouslySetInnerHTML={{ __html: getFileIconSvg(activeFile) }}' in text:
        raise RuntimeError('ContextBar active file icon block changed unexpectedly; patch manually')

    close_agent_old = """          <span \n            className="codicon codicon-close context-close" \n            onClick={onClearAgent}\n            title="Remove agent"\n          />"""
    close_agent_new = """          <span\n            className="context-close context-close-button"\n            onClick={onClearAgent}\n            title="Remove agent"\n            role="button"\n            tabIndex={0}\n          >\n            <CopilotIcon name="x" size={12} aria-hidden="true" />\n          </span>"""
    text = text.replace(close_agent_old, close_agent_new)

    close_file_old = """          <span\n            className="codicon codicon-close context-close"\n            onClick={onClearFile}\n            title="Remove file context"\n          />"""
    close_file_new = """          <span\n            className="context-close context-close-button"\n            onClick={onClearFile}\n            title="Remove file context"\n            role="button"\n            tabIndex={0}\n          >\n            <CopilotIcon name="x" size={12} aria-hidden="true" />\n          </span>"""
    text = text.replace(close_file_old, close_file_new)

    write(path, text)
    print('patched ContextBar file/context icons')


def patch_attachment_list() -> None:
    path = 'webview/src/components/ChatInputBox/AttachmentList.tsx'
    text = read(path)

    if "../copilotIcons" not in text:
        text = text.replace(
            "import { isImageAttachment } from './types';\n",
            "import { isImageAttachment } from './types';\nimport { CopilotIcon } from '../copilotIcons';\n",
            1,
        )

    text = re.sub(
        r"\n  /\*\*\n   \* Get file icon\n   \*/\n  const getFileIcon = \(mediaType: string\): string => \{[\s\S]*?\n  \};\n",
        "\n",
        text,
        count=1,
    )

    helper_anchor = """  const getExtension = (fileName: string): string => {\n    const parts = fileName.split('.');\n    return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : '';\n  };"""
    helper_addition = """

  /**
   * Map attachments to the local Copilot-inspired icon vocabulary.
   */
  const getAttachmentFileIconName = (attachment: Attachment): 'code' | 'file' => {
    const extension = getExtension(attachment.fileName).toLowerCase();
    const codeExtensions = new Set([
      'bat', 'c', 'cmd', 'cpp', 'cs', 'css', 'go', 'gradle', 'groovy', 'h', 'hpp',
      'html', 'java', 'js', 'json', 'jsx', 'kt', 'kts', 'less', 'md', 'properties',
      'py', 'rs', 'scss', 'sh', 'sql', 'ts', 'tsx', 'xml', 'yaml', 'yml',
    ]);
    return codeExtensions.has(extension) ? 'code' : 'file';
  };"""
    if 'getAttachmentFileIconName' not in text:
        if helper_anchor not in text:
            raise RuntimeError('Could not find getExtension helper in AttachmentList.tsx')
        text = text.replace(helper_anchor, helper_anchor + helper_addition, 1)

    text = text.replace(
        """          const fallbackName = extension || attachment.fileName.slice(0, 6);""",
        """          const fallbackName = attachment.fileName;""",
    )

    text = text.replace(
        """                  <span className={`attachment-file-icon codicon ${getFileIcon(attachment.mediaType)}`} />""",
        """                  <CopilotIcon
                    className={`attachment-file-icon attachment-file-icon-${getAttachmentFileIconName(attachment)}`}
                    name={getAttachmentFileIconName(attachment)}
                    size={17}
                    aria-hidden="true"
                  />""",
    )

    write(path, text)
    print('patched AttachmentList file icons')


def write_css() -> None:
    content = r'''/* Copilot active-file and file-attachment icon cleanup v6.
   The goal is to remove IDE/file-type logo noise (for example the bright Java cup)
   and render source-file chips with the local, quiet Copilot-inspired icon pack. */

html[data-theme="github-copilot"] .context-bar {
  gap: 6px;
}

html[data-theme="github-copilot"] .context-item {
  min-height: 28px;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 9px;
  background: rgba(22, 27, 34, 0.86);
  border-color: rgba(88, 166, 255, 0.22);
  box-shadow: 0 1px 0 rgba(240, 246, 252, 0.04) inset;
}

html[data-theme="github-copilot"] .context-item:hover {
  border-color: rgba(88, 166, 255, 0.38);
  background: rgba(33, 38, 45, 0.92);
}

html[data-theme="github-copilot"] .context-file-icon,
html[data-theme="github-copilot"] .context-agent-icon,
html[data-theme="github-copilot"] .context-file-placeholder .copilot-icon,
html[data-theme="github-copilot"] .context-tool-btn .copilot-icon {
  flex: 0 0 auto;
  margin-right: 4px;
  color: #8b949e;
}

html[data-theme="github-copilot"] .context-file-icon-code,
html[data-theme="github-copilot"] .attachment-file-icon-code {
  color: #58a6ff;
}

html[data-theme="github-copilot"] .context-file-icon-file,
html[data-theme="github-copilot"] .attachment-file-icon-file {
  color: #8b949e;
}

html[data-theme="github-copilot"] .context-agent-icon {
  color: #a371f7;
}

html[data-theme="github-copilot"] .context-text {
  color: #c9d1d9;
  font-size: 12px;
  letter-spacing: 0;
}

html[data-theme="github-copilot"] .context-close-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  margin-left: 2px;
  border-radius: 999px;
  color: #8b949e;
  opacity: 0.76;
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease, opacity 0.15s ease;
}

html[data-theme="github-copilot"] .context-close-button:hover,
html[data-theme="github-copilot"] .context-close-button:focus-visible {
  color: #ff7b72;
  opacity: 1;
  background: rgba(248, 81, 73, 0.14);
  outline: none;
}

html[data-theme="github-copilot"] .attachment-preview-frame .attachment-file-icon {
  margin: 0;
}

html[data-theme="github-copilot"] .attachment-file-icon {
  color: #58a6ff;
}

html[data-theme="github-copilot"] .attachment-label {
  color: #c9d1d9;
}

/* Guard against SVG icons injected by IDE file-type providers in older chips.
   If such markup still appears inside a context-file-icon span, neutralize its native colors. */
html[data-theme="github-copilot"] .context-file-icon svg [fill]:not([fill="none"]),
html[data-theme="github-copilot"] .context-file-icon svg path[fill]:not([fill="none"]) {
  fill: currentColor !important;
}

html[data-theme="github-copilot"] .context-file-icon svg [stroke]:not([stroke="none"]),
html[data-theme="github-copilot"] .context-file-icon svg path[stroke]:not([stroke="none"]) {
  stroke: currentColor !important;
}
'''
    write('webview/src/components/ChatInputBox/styles/copilot-context-file-icons.css', content)


def patch_styles_import() -> None:
    path = 'webview/src/components/ChatInputBox/styles.css'
    text = read(path)
    marker = "@import './styles/copilot-context-file-icons.css';"
    if marker not in text:
        text = text.rstrip() + "\n@import './styles/copilot-context-file-icons.css';\n"
        write(path, text)
        print('patched ChatInputBox/styles.css import')
    else:
        print('skip ChatInputBox/styles.css import: already applied')


def write_doc() -> None:
    doc = r'''# Copilot context file icons v6

This patch fixes the active-file/context chip, for example `Main.java`, which previously used IDE/file-type SVG icons.
Those icons can be visually loud, language-specific and sometimes bright red/orange. The Copilot skin now maps active
context files and file attachments to the local Copilot-inspired icon pack instead.

## What changed

- `ContextBar` no longer injects IDE file-type SVG markup via `dangerouslySetInnerHTML` for the active file chip.
- Source-like extensions such as `.java`, `.ts`, `.json`, `.gradle`, `.xml`, `.properties`, `.yml` map to the local `code` icon.
- Other files map to the local `file` icon.
- Attachment file chips use the same mapping.
- Close buttons in context chips use the quiet local `x` icon.
- The Copilot theme neutralizes any remaining injected SVG fill/stroke colors in context file icons.

## Design intent

The file chip should read as context, not as a Java/IDE brand badge. Blue indicates actionable file context; red is
reserved for actual destructive or error state.
'''
    write('docs/copilot-context-file-icons-v6.md', doc)


def main() -> None:
    patch_context_bar()
    patch_attachment_list()
    write_css()
    patch_styles_import()
    write_doc()
    print('\nCopilot context/file icon v6 patch applied.')
    print('Run: cd webview && npm run test && npm run build')


if __name__ == '__main__':
    main()
