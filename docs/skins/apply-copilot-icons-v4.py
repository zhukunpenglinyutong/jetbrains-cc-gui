
from pathlib import Path
import re

ROOT = Path.cwd()

def write(path, content):
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding='utf-8')

def ensure_contains(path, marker, insert_after, addition):
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    if marker in text:
        return False
    if insert_after in text:
        text = text.replace(insert_after, insert_after + addition)
    else:
        text = text + addition
    p.write_text(text, encoding='utf-8')
    return True

copilot_icon_tsx = r'''import type React from 'react';

export type CopilotIconName =
  | 'agent'
  | 'attachment'
  | 'back'
  | 'branch'
  | 'check'
  | 'chevronDown'
  | 'chevronRight'
  | 'code'
  | 'copy'
  | 'edit'
  | 'error'
  | 'file'
  | 'history'
  | 'info'
  | 'link'
  | 'model'
  | 'reload'
  | 'search'
  | 'send'
  | 'settings'
  | 'spark'
  | 'spinner'
  | 'stop'
  | 'terminal'
  | 'thumbsDown'
  | 'thumbsUp'
  | 'tool'
  | 'warning'
  | 'x';

export interface CopilotIconProps extends Omit<React.SVGProps<SVGSVGElement>, 'name'> {
  name: CopilotIconName;
  size?: number;
  strokeWidth?: number;
}

function renderIcon(name: CopilotIconName): React.ReactNode {
  switch (name) {
    case 'agent':
      return (
        <>
          <circle cx="12" cy="8" r="3" />
          <path d="M5.75 19.25c.65-3.45 2.75-5.25 6.25-5.25s5.6 1.8 6.25 5.25" />
          <path d="M8.25 8h-.9a2.1 2.1 0 0 0-2.1 2.1v1.3" />
          <path d="M15.75 8h.9a2.1 2.1 0 0 1 2.1 2.1v1.3" />
        </>
      );
    case 'attachment':
      return <path d="M8.5 12.5 14.8 6.2a3.05 3.05 0 0 1 4.3 4.3l-7.8 7.8a5 5 0 0 1-7.1-7.1l7.5-7.5" />;
    case 'back':
      return <path d="M15.5 5.5 9 12l6.5 6.5" />;
    case 'branch':
      return (
        <>
          <circle cx="7" cy="6" r="2.25" />
          <circle cx="17" cy="18" r="2.25" />
          <circle cx="7" cy="18" r="2.25" />
          <path d="M7 8.25v7.5" />
          <path d="M9.25 6H13a4 4 0 0 1 4 4v5.75" />
        </>
      );
    case 'check':
      return <path d="m5 12.5 4.2 4.2L19 6.8" />;
    case 'chevronDown':
      return <path d="m6.5 9 5.5 5.5L17.5 9" />;
    case 'chevronRight':
      return <path d="m9 6.5 5.5 5.5L9 17.5" />;
    case 'code':
      return (
        <>
          <path d="m9 7-4.5 5L9 17" />
          <path d="m15 7 4.5 5L15 17" />
          <path d="m13.2 5.75-2.4 12.5" />
        </>
      );
    case 'copy':
      return (
        <>
          <rect x="8" y="7" width="10" height="12" rx="2" />
          <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
        </>
      );
    case 'edit':
      return (
        <>
          <path d="M5 19h4.3L18.6 9.7a2.1 2.1 0 0 0-3-3L6.3 16H5v3Z" />
          <path d="m13.8 8.5 1.7 1.7" />
        </>
      );
    case 'error':
      return (
        <>
          <circle cx="12" cy="12" r="8.25" />
          <path d="M12 7.75v5" />
          <path d="M12 16.25h.01" />
        </>
      );
    case 'file':
      return (
        <>
          <path d="M6.75 3.75h6.6L18.25 8.7v11.55H6.75V3.75Z" />
          <path d="M13.25 4v5h5" />
        </>
      );
    case 'history':
      return (
        <>
          <path d="M5 12a7 7 0 1 0 2.05-4.95" />
          <path d="M5 5.5v4h4" />
          <path d="M12 8v4.25l2.75 1.75" />
        </>
      );
    case 'info':
      return (
        <>
          <circle cx="12" cy="12" r="8.25" />
          <path d="M12 11v5" />
          <path d="M12 8h.01" />
        </>
      );
    case 'link':
      return (
        <>
          <path d="M9.75 13.75a3.25 3.25 0 0 1 0-4.6l2.1-2.1a3.25 3.25 0 1 1 4.6 4.6l-1.1 1.1" />
          <path d="M14.25 10.25a3.25 3.25 0 0 1 0 4.6l-2.1 2.1a3.25 3.25 0 1 1-4.6-4.6l1.1-1.1" />
        </>
      );
    case 'model':
      return (
        <>
          <rect x="4" y="5" width="16" height="14" rx="3" />
          <path d="M8 9h8" />
          <path d="M8 13h5" />
          <path d="M16 13h.01" />
        </>
      );
    case 'reload':
      return (
        <>
          <path d="M19 11a7 7 0 1 0-2 4.9" />
          <path d="M19 5.75V11h-5.25" />
        </>
      );
    case 'search':
      return (
        <>
          <circle cx="10.75" cy="10.75" r="5.75" />
          <path d="m15.25 15.25 4 4" />
        </>
      );
    case 'send':
      return (
        <>
          <path d="M4 12 19.5 4.5 16 19.5 12 13 4 12Z" />
          <path d="M12 13 19.5 4.5" />
        </>
      );
    case 'settings':
      return (
        <>
          <circle cx="12" cy="12" r="2.75" />
          <path d="M19 12a7.2 7.2 0 0 0-.1-1.15l2-1.55-2-3.45-2.45 1a7.4 7.4 0 0 0-1.95-1.12L14.15 3h-4.3L9.5 5.73a7.4 7.4 0 0 0-1.95 1.12l-2.45-1-2 3.45 2 1.55a7.2 7.2 0 0 0 0 2.3l-2 1.55 2 3.45 2.45-1A7.4 7.4 0 0 0 9.5 18.27l.35 2.73h4.3l.35-2.73a7.4 7.4 0 0 0 1.95-1.12l2.45 1 2-3.45-2-1.55c.07-.37.1-.75.1-1.15Z" />
        </>
      );
    case 'spark':
      return (
        <>
          <path d="M12 3.75 13.55 9 19 10.55 13.55 12.1 12 17.25 10.45 12.1 5 10.55 10.45 9 12 3.75Z" />
          <path d="M18.5 15.5 19.1 17.4 21 18l-1.9.6-.6 1.9-.6-1.9L16 18l1.9-.6.6-1.9Z" />
        </>
      );
    case 'spinner':
      return <path d="M20 12a8 8 0 1 1-3.2-6.4" />;
    case 'stop':
      return <rect x="7" y="7" width="10" height="10" rx="2" />;
    case 'terminal':
      return (
        <>
          <path d="m5.5 8 4 4-4 4" />
          <path d="M11.5 16h7" />
        </>
      );
    case 'thumbsDown':
      return (
        <>
          <path d="M7.5 4.5v10" />
          <path d="M7.5 13.5h-2a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h8.25a2 2 0 0 1 1.9 1.37l1.85 5.63a2 2 0 0 1-1.9 2.63H13l.55 3.2a2 2 0 0 1-3.35 1.7L7.5 16.5v-3Z" />
        </>
      );
    case 'thumbsUp':
      return (
        <>
          <path d="M7.5 19.5v-10" />
          <path d="M7.5 10.5h-2a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h8.25a2 2 0 0 0 1.9-1.37l1.85-5.63a2 2 0 0 0-1.9-2.63H13l.55-3.2a2 2 0 0 0-3.35-1.7L7.5 7.5v3Z" />
        </>
      );
    case 'tool':
      return (
        <>
          <path d="M15.5 4.75a4 4 0 0 0 3.75 5.25l-8.7 8.7a2.2 2.2 0 0 1-3.1-3.1l8.7-8.7a4 4 0 0 0-.65-2.15Z" />
          <path d="M7.5 16.5h.01" />
        </>
      );
    case 'warning':
      return (
        <>
          <path d="M10.2 4.8a2.1 2.1 0 0 1 3.6 0l7.1 12.3a2.1 2.1 0 0 1-1.8 3.15H4.9a2.1 2.1 0 0 1-1.8-3.15L10.2 4.8Z" />
          <path d="M12 9v4.5" />
          <path d="M12 17h.01" />
        </>
      );
    case 'x':
      return <path d="m7 7 10 10M17 7 7 17" />;
  }
}

export function CopilotIcon({
  name,
  size = 16,
  strokeWidth = 1.7,
  className,
  ...svgProps
}: CopilotIconProps) {
  const classes = ['copilot-icon', `copilot-icon-${name}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <svg
      {...svgProps}
      className={classes}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={svgProps['aria-label'] ? undefined : true}
      focusable="false"
    >
      {renderIcon(name)}
    </svg>
  );
}
'''

index_ts = "export { CopilotIcon } from './CopilotIcon';\nexport type { CopilotIconName, CopilotIconProps } from './CopilotIcon';\n"

license_md = r'''MIT License

Copyright (c) 2026 AresStack contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
'''

style_less = r'''/* Copilot-inspired icon pack and icon-tone adapter.
   Scope all rules to the Copilot skin so the regular dark/light themes stay untouched. */

html[data-theme="github-copilot"] {
    --copilot-icon-default: #8b949e;
    --copilot-icon-muted: #6e7681;
    --copilot-icon-subtle: rgba(139, 148, 158, 0.72);
    --copilot-icon-link: #58a6ff;
    --copilot-icon-success: #3fb950;
    --copilot-icon-attention: #d29922;
    --copilot-icon-danger: #ff7b72;
    --copilot-icon-danger-muted: #d47772;
    --copilot-icon-ai: #a371f7;
}

html[data-theme="github-copilot"] .copilot-icon {
    display: inline-block;
    flex: 0 0 auto;
    color: currentColor;
    vertical-align: -0.15em;
}

html[data-theme="github-copilot"] .copilot-icon-spinner {
    animation: copilot-icon-spin 0.9s linear infinite;
    transform-origin: center;
}

@keyframes copilot-icon-spin {
    to { transform: rotate(360deg); }
}

html[data-theme="github-copilot"] .codicon {
    color: var(--copilot-icon-default);
    opacity: 0.88;
}

html[data-theme="github-copilot"] .icon-button,
html[data-theme="github-copilot"] .back-button,
html[data-theme="github-copilot"] .message-copy-btn,
html[data-theme="github-copilot"] .message-copy-btn-inline,
html[data-theme="github-copilot"] .copy-code-btn,
html[data-theme="github-copilot"] .enhance-prompt-button,
html[data-theme="github-copilot"] .tool-button-placeholder,
html[data-theme="github-copilot"] .config-selector-button,
html[data-theme="github-copilot"] .selector-trigger {
    color: var(--copilot-icon-default);
}

html[data-theme="github-copilot"] .icon-button:hover,
html[data-theme="github-copilot"] .back-button:hover,
html[data-theme="github-copilot"] .message-copy-btn:hover,
html[data-theme="github-copilot"] .message-copy-btn-inline:hover,
html[data-theme="github-copilot"] .copy-code-btn:hover,
html[data-theme="github-copilot"] .enhance-prompt-button:hover,
html[data-theme="github-copilot"] .tool-button-placeholder:hover,
html[data-theme="github-copilot"] .config-selector-button:hover,
html[data-theme="github-copilot"] .selector-trigger:hover {
    color: var(--copilot-icon-link);
}

html[data-theme="github-copilot"] .submit-button:not(:disabled),
html[data-theme="github-copilot"] .send-button:not(:disabled) {
    color: #ffffff;
}

html[data-theme="github-copilot"] .submit-button:disabled,
html[data-theme="github-copilot"] .send-button:disabled {
    color: var(--copilot-icon-muted);
}

html[data-theme="github-copilot"] .stop-button,
html[data-theme="github-copilot"] .stop-button .codicon,
html[data-theme="github-copilot"] .copilot-icon-stop {
    color: var(--copilot-icon-danger-muted);
}

html[data-theme="github-copilot"] .codicon-error,
html[data-theme="github-copilot"] .codicon-warning,
html[data-theme="github-copilot"] .codicon-debug-stop,
html[data-theme="github-copilot"] .codicon-trash,
html[data-theme="github-copilot"] .codicon-close,
html[data-theme="github-copilot"] .codicon-chrome-close,
html[data-theme="github-copilot"] .color-danger,
html[data-theme="github-copilot"] .danger,
html[data-theme="github-copilot"] .error .codicon {
    color: var(--copilot-icon-danger-muted) !important;
}

html[data-theme="github-copilot"] .codicon-pass,
html[data-theme="github-copilot"] .codicon-check,
html[data-theme="github-copilot"] .codicon-check-all,
html[data-theme="github-copilot"] .codicon-verified,
html[data-theme="github-copilot"] .task-notification-success .codicon,
html[data-theme="github-copilot"] .copilot-icon-check {
    color: var(--copilot-icon-success) !important;
}

html[data-theme="github-copilot"] .codicon-info,
html[data-theme="github-copilot"] .codicon-link,
html[data-theme="github-copilot"] .codicon-file-symlink-file,
html[data-theme="github-copilot"] .codicon-file-symlink-directory,
html[data-theme="github-copilot"] a .codicon,
html[data-theme="github-copilot"] .copilot-icon-link,
html[data-theme="github-copilot"] .copilot-icon-search,
html[data-theme="github-copilot"] .copilot-icon-reload {
    color: var(--copilot-icon-link) !important;
}

html[data-theme="github-copilot"] .codicon-sparkle,
html[data-theme="github-copilot"] .codicon-symbol-color,
html[data-theme="github-copilot"] .copilot-icon-spark,
html[data-theme="github-copilot"] .copilot-icon-agent {
    color: var(--copilot-icon-ai) !important;
}

html[data-theme="github-copilot"] .codicon-terminal,
html[data-theme="github-copilot"] .codicon-code,
html[data-theme="github-copilot"] .codicon-file-code,
html[data-theme="github-copilot"] .codicon-json,
html[data-theme="github-copilot"] .copilot-icon-code,
html[data-theme="github-copilot"] .copilot-icon-terminal {
    color: var(--copilot-icon-attention) !important;
}

html[data-theme="github-copilot"] .message-copy-btn .copilot-icon,
html[data-theme="github-copilot"] .message-copy-btn-inline .copilot-icon,
html[data-theme="github-copilot"] .copy-code-btn .copilot-icon {
    color: inherit;
}

html[data-theme="github-copilot"] .compact-summary-icon.copilot-icon,
html[data-theme="github-copilot"] .thinking-icon.copilot-icon {
    color: var(--copilot-icon-ai);
}

html[data-theme="github-copilot"] .waiting-spinner-icon {
    color: var(--copilot-icon-default);
}

html[data-theme="github-copilot"] .task-notification-icon,
html[data-theme="github-copilot"] .compact-summary-icon:not(.copilot-icon) {
    filter: saturate(0.65) brightness(0.95);
    opacity: 0.82;
}
'''

doc_md = r'''# Copilot-inspired icon pack

This icon pack is intentionally **not** a copy of GitHub Copilot, Octicons, or any GitHub brand asset.
It provides small, original, stroke-based SVG primitives that fit the Copilot-inspired skin.

## License

The icon source in `webview/src/components/copilotIcons` is MIT licensed.

## Design rules

- Use `currentColor` only.
- Prefer 16 px icons with 1.7 px stroke width.
- Keep shapes quiet and geometric.
- Use semantic colors from `copilot-icon-pack.less`:
  - blue for links, navigation and active actions
  - amber for code, terminal and attention
  - green for completed or successful state
  - muted red only for destructive/error state
  - purple only for AI/spark/agent affordances

## Integration policy

Existing Codicons are normalized by CSS in the Copilot theme. New or refactored components should use
`CopilotIcon` directly, for example:

```tsx
import { CopilotIcon } from '../copilotIcons';

<CopilotIcon name="copy" size={14} />
```

Do not use official Copilot logos or GitHub brand assets for this skin.
'''

write('webview/src/components/copilotIcons/CopilotIcon.tsx', copilot_icon_tsx)
write('webview/src/components/copilotIcons/index.ts', index_ts)
write('webview/src/components/copilotIcons/LICENSE.md', license_md)
write('webview/src/styles/less/copilot-icon-pack.less', style_less)
write('docs/copilot-icon-pack.md', doc_md)

ensure_contains('webview/src/styles/app.less', '@import "less/copilot-icon-pack.less";', '@import "less/copilot-laf-v3.less";', '\n@import "less/copilot-icon-pack.less";')
ensure_contains('webview/src/styles/app.less', '@import "less/copilot-icon-pack.less";', '@import "less/copilot-skin.less";', '\n@import "less/copilot-icon-pack.less";')

message_item = ROOT / 'webview/src/components/MessageItem/MessageItem.tsx'
if message_item.exists():
    text = message_item.read_text(encoding='utf-8')
    if "../copilotIcons" not in text:
        text = text.replace("import { copyToClipboard } from '../../utils/copyUtils';\n", "import { copyToClipboard } from '../../utils/copyUtils';\nimport { CopilotIcon } from '../copilotIcons';\n")
    text = re.sub(r"/\*\* Shared copy icon SVG used by both user and assistant message copy buttons \*/\s*const CopyIcon = \(\) => \([\s\S]*?\n\);", "/** Render the shared copy icon used by both user and assistant message copy buttons. */\nconst CopyIcon = () => <CopilotIcon name=\"copy\" size={14} strokeWidth={1.75} />;", text, count=1)
    message_item.write_text(text, encoding='utf-8')

waiting = ROOT / 'webview/src/components/WaitingIndicator.tsx'
if waiting.exists():
    text = waiting.read_text(encoding='utf-8')
    if "./copilotIcons" not in text:
        text = text.replace("import { useTranslation } from 'react-i18next';\n", "import { useTranslation } from 'react-i18next';\nimport { CopilotIcon } from './copilotIcons';\n")
    text = text.replace('<span className="waiting-spinner" style={spinnerStyle} />', '<span className="waiting-spinner" style={spinnerStyle}>\n        <CopilotIcon className="waiting-spinner-icon" name="spinner" size={size} aria-hidden="true" />\n      </span>')
    waiting.write_text(text, encoding='utf-8')

content_renderer = ROOT / 'webview/src/components/MessageItem/ContentBlockRenderer.tsx'
if content_renderer.exists():
    text = content_renderer.read_text(encoding='utf-8')
    if "../copilotIcons" not in text:
        text = text.replace("import MarkdownBlock from '../MarkdownBlock';\n", "import MarkdownBlock from '../MarkdownBlock';\nimport { CopilotIcon } from '../copilotIcons';\n")
    text = text.replace('<span className="compact-summary-icon" aria-hidden="true">●</span>', '<CopilotIcon className="compact-summary-icon" name="spark" size={12} aria-hidden="true" />')
    text = text.replace('<span className="compact-summary-toggle" aria-hidden="true">{expanded ? \'▼\' : \'▶\'}</span>', '<CopilotIcon className="compact-summary-toggle" name={expanded ? \'chevronDown\' : \'chevronRight\'} size={12} aria-hidden="true" />')
    text = text.replace('<span className="thinking-icon">\n            {isThinkingExpanded ? \'▼\' : \'▶\'}\n          </span>', '<CopilotIcon className="thinking-icon" name={isThinkingExpanded ? \'chevronDown\' : \'chevronRight\'} size={13} aria-hidden="true" />')
    content_renderer.write_text(text, encoding='utf-8')

button_area = ROOT / 'webview/src/components/ChatInputBox/ButtonArea.tsx'
if button_area.exists():
    text = button_area.read_text(encoding='utf-8')
    if "../copilotIcons" not in text:
        text = text.replace("import { readClaudeModelMapping } from '../../utils/claudeModelMapping';\n", "import { readClaudeModelMapping } from '../../utils/claudeModelMapping';\nimport { CopilotIcon } from '../copilotIcons';\n")
    text = text.replace("<span className={`codicon ${isEnhancing ? 'codicon-loading codicon-modifier-spin' : 'codicon-sparkle'}`} />", "<CopilotIcon className={isEnhancing ? 'codicon-modifier-spin' : undefined} name={isEnhancing ? 'spinner' : 'spark'} size={16} aria-hidden=\"true\" />")
    text = text.replace('<span className="codicon codicon-debug-stop" />', '<CopilotIcon name="stop" size={16} aria-hidden="true" />')
    text = text.replace('<span className="codicon codicon-send" />', '<CopilotIcon name="send" size={16} aria-hidden="true" />')
    button_area.write_text(text, encoding='utf-8')

print('Applied Copilot inspired icon pack v4.')
