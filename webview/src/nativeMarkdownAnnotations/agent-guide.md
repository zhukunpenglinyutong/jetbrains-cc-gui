# Markdown review context

Runtime rules live in `MarkdownReviewPrompt.GUIDE` (under 600 characters).
They require checking current source, verifying corrections, respecting IDE cleanup, and reporting completed IDs and every unfinished/partial item with file, reason and next step.

Claude activates these rules in the existing system/agent context on the first review turn. The append stays stable across subsequent turns and compaction, and resets for a new session; history restore can reactivate it. Other providers receive compact hidden agent context only on review turns.

User messages contain only the versioned snapshot envelope and the user's request. The UI displays snapshots in a collapsed context card and hides the former long preamble in legacy history. This is context, not a fabricated tool invocation or an installed skill.
