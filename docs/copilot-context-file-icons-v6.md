# Copilot context file icons v6

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
