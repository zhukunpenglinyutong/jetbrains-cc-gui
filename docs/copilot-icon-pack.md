# Copilot-inspired icon pack

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
