# Copilot attachment strip v5

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
