# Copilot LAF v3 element map

This patch intentionally maps only real elements from this fork and keeps all
rules scoped to `html[data-theme="github-copilot"]`.

## Design language

- Base canvas: nearly black GitHub dark canvas.
- Main action/focus/link: blue.
- User authored content: blue bubble / blue composer focus ring.
- Attention and inline code: yellow/amber.
- Success/context/status: green.
- Done/AI accent: restrained purple only where useful.
- Icons: small, low contrast, visible on hover.
- Borders: thin and quiet, no heavy card shadows.

## Real element mapping

| Fork element | Mapping |
| --- | --- |
| `#app` | Rounded Copilot chat surface with subtle blue/purple glow. |
| `.header` | Thin top bar, quiet buttons, small icons. |
| `.messages-container` | Transparent canvas with room for the anchor rail. |
| `.message.user .message-content` | Blue sent-message bubble. |
| `.message.assistant .message-content` | Plain text on canvas, no heavy card. |
| `.code-block-wrapper + .copy-code-btn + pre/code` | GitHub-like code block with a quiet top strip. |
| `.message-duration` | Kept, but visually muted. |
| `.waiting-indicator` | Small pill with single circular spinner. |
| `.input-container` | Prominent bottom composer with blue gradient/focus border. |
| `.messages-anchor-rail` | Preserved as Copilot-style timeline, because it is useful even if GitHub Copilot does not have it. |
| Tool blocks | Calm activity cards, not loud diagnostics. |
| Thinking/compact/task blocks | Low-contrast disclosure/status surfaces. |

## Visibility policy

Do not remove additional information in this pass. Extra fork-specific details
are made visually quiet instead. If we later decide to hide fields, that should
be done in React with feature flags, not by brittle CSS `display: none` rules.
