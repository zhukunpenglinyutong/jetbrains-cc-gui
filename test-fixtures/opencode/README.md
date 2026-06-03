## Opencode Replay Fixtures

These fixtures make rendering bugs reproducible without a live model.

Each fixture contains raw opencode events plus expected bridge-level and
webview-level invariants. Add a fixture whenever a rendering bug is found, then
minimize it to the smallest event sequence that still reproduces the issue.

Recommended workflow for agents:

1. Capture fresh `/event` JSONL or debug-log markers for the broken turn.
2. Keep only events for the affected `sessionID`.
3. Remove unrelated status, heartbeat, and duplicate tool events.
4. Add expected `contentDeltas`, `thinkingDeltas`, tool IDs, and block reset
   counts.
5. Add a `webviewReplay` marker sequence for the final UI invariant.
6. Run `node --test ai-bridge/services/opencode/opencode-replay.test.js` and
   the matching webview replay test.

Use this helper to generate a skeleton from raw event logs:

```bash
node ai-bridge/services/opencode/extract-opencode-replay-fixture.js events.jsonl \
  --session ses_123 --name my-regression > test-fixtures/opencode/my-regression.json
```
