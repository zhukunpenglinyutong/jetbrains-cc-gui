# Gemini Integration Quickstart

> Provider-integration guide for the Gemini CLI (`agy`). This document records the
> integration shape and the on-disk storage contract the history reader depends on.
> Structure follows [the OpenCode quickstart](../opencode/OPENCODE-INTEGRATION-QUICKSTART.md).

## What This Adds

The Gemini CLI becomes a headless CLI provider beside Claude, Codex, Grok, and the
other disk-reader providers. Chat turns already flow through the shared marker
protocol; Story 1.7 closes the history round-trip: listing, content load, export,
and delete through the same shared history UI every other provider uses.

## Architecture Highlights

```text
Gemini: Java -> GeminiCliBridge (MarkerCliBridge) -> ai-bridge gemini-channel -> agy CLI
```

Key boundaries:

- Java provider bridge: `provider/gemini/GeminiCliBridge` (provider id `gemini`,
  stdin env key `GEMINI_USE_STDIN`)
- Java history reader: `provider/gemini/GeminiHistoryReader`
- Node channel: `ai-bridge/channels/gemini-channel.js`
- Node services: `ai-bridge/services/gemini/`
- Shared router: `SessionProviderRouter` (Java) and `ai-bridge/channel-manager.js`

## Runtime Ownership

The plugin does not install or configure the Gemini CLI.

- The user installs the `agy` CLI and authenticates through it.
- The plugin resolves the installed CLI and never writes CLI-owned configuration.
- Conversation storage under the CLI home is CLI-owned: the plugin reads it and
  deletes only whole conversation databases on explicit user request.

## CLI Storage Contract

Everything below was pinned against live storage (agy 1.1.22, macOS, verified
2026-09-04). The CLI's internal schema is **not** a stable public contract — treat
this as a snapshot, keep readers defensive, and re-verify after CLI upgrades.

### Directory layout

`~/.gemini/antigravity-cli/`

| Path | Purpose |
| --- | --- |
| `conversations/<uuid>.db` | One SQLite database per conversation, plus `-shm`/`-wal` sidecars while live. |
| `conversation_summaries.db` | Fallback titles (`conversation_id, title, preview`). WAL-state can defeat `mode=ro`; best-effort only. |
| `cache/conversation_metadata.json` | Legacy listing cache. **Not maintained by the current CLI** (stale on real installs — see the staleness note below): entries are trusted only when `conversations/<id>.db` still exists; when nothing survives the filter, listing falls back to scanning the databases. |
| `cache/last_conversations.json` | cwd → latest conversation id; used as a project-scoping fallback. |

### Conversation database schema

Tables include `trajectory_meta`, `steps`, `gen_metadata`, `executor_metadata`,
`parent_references`, `trajectory_metadata_blob`. Only `steps` is read:

```sql
steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER,
      step_payload BLOB, error_details BLOB, ...)
```

`idx` orders the conversation. `step_type` is an **integer enum** (verified across
18 sampled live databases — histogram {14: 21, 15: 167, 132: 140, 101: 18}; the
full live corpus adds types **17/23/90/98 — 331 steps** of CLI-injected/context
bookkeeping):

| Value | Meaning | Reader behavior |
| --- | --- | --- |
| 14 | user turn | decode user text |
| 15 | agent turn | decode agent text + tool calls |
| 132 | executed tool call | decode call + result |
| 101, 17/23/90/98 (and others) | CLI bookkeeping / notices | skipped, one summary log line per load |

`status` is an integer (3 = completed on live data).

### step_payload wire map (live shape)

`step_payload` is a protobuf message. The minimal, live-verified field map:

- **User (14):** top-level field 19 repeated; the content envelope carries the
  prompt text at `19.2`. The first repeated `19` blob is not always the text one —
  the reader iterates and takes the first blob with a non-blank `2`.
- **Agent (15):** top-level field 20 repeated. The live corpus shows exactly ONE
  `20` blob per agent step (22382/22382) — there is no "first blob is a trajectory
  reference" rule (an earlier sample-based reading of this was wrong). The reader
  iterates every repeated `20` and collects text and tool calls across all blobs,
  so a multi-blob payload loses nothing. Each blob carries:
  - `20.3` — agent response text
  - `20.7` — repeated tool-call messages `{1: call id, 2: tool name, 3: args JSON}`
- **Tool (132):**
  - `5.4` — the executed call `{1: id, 2: name, 3: args JSON}` (same id as the
    agent step's `20.7` entry → the reader deduplicates tool_use envelopes by id)
  - `140` — render/result: `140.1` is a repeated key/value list (key `toolSummary`
    at `{1,2}`), `140.2` is the result text (preferred content)
- Top-level field 1 is a varint echo of `step_type` — never a string.

The reader also honours a **flat fixture shape** (fields 1–4 as strings: user
input, agent response, tool name, tool summary; `step_type` as text
`user`/`agent`/`tool`). The fixture shape is the decode-pipeline contract used by
the test suite; the live shape is pinned by
`GeminiHistoryReaderTest#liveIntegerStepTypesAndNestedEnvelopesDecode` so CLI-side
drift fails a test instead of silently emptying real history.

Undecodable payloads and unknown `step_type` values are skipped — with a summary
log line per load. Content is never fabricated.

### Listing cache shape

`cache/conversation_metadata.json`:

```json
{"conversations":{"<uuid>":{
  "summary":{"ID":"<uuid>","Title":"","Preview":"...","NumSteps":345,
             "UpdatedAt":"2026-04-16T10:14:21.956393Z",
             "WorkspaceURIs":["file:///Volumes/dx/dev/blink"],
             "AppDataDir":"antigravity","ProjectID":"<uuid>","AgentName":""},
  "is_internal":false,
  "last_modified_time":"2026-05-20T04:31:59.990808083-04:00"}}}
```

Observed rules (2026-09-04, 84 entries): `AppDataDir` varies (`antigravity`,
`antigravity-cli`) — **never filter on it**; `is_internal` is false on every
observed entry — skipped defensively when true; exactly one entry lacked
`WorkspaceURIs` (handled: project-scoped listing skips it, unless
`last_conversations.json` claims it for the current cwd).

**Staleness (2026-09-04 live check):** the cache is **not maintained by the
current CLI**. On a real install (agy 1.1.22) all 84 cache entries were ~3.5
months stale — 0 had a backing `conversations/<id>.db` — while 500 real
conversations existed only on disk and were absent from the cache. The reader
therefore lists cache entries only when their database still exists (whitelist-
checked id first) and falls back to the database scan when nothing survives.
`conversation_summaries.db` is equally stale and stays best-effort: a title
source only, never a listing source.

`cache/last_conversations.json`: `{ "<abs cwd>": "<latest conversation uuid>" }`.

## History Round-Trip Mapping

| Operation | Mechanism |
| --- | --- |
| List | Cache first, filtered to entries whose `conversations/<id>.db` still exists (skip `is_internal`, non-object summaries, blank or whitelist-violating ids — the whitelist runs before any path is built); when no entry survives, scan `conversations/*.db` mtimes with titles from `conversation_summaries.db` (best-effort). Shared `{success, sessions[], sessionCount, total}` envelope. |
| Project scope | `WorkspaceURIs` matched via `HistoryPathMatcher` (exact, `/tmp`↔`/private/tmp`, parent/child); `last_conversations.json` ids count as matches. |
| Load | Whitelist `^[A-Za-z0-9._-]+$` → open the db read-only (`?mode=ro` + `PRAGMA query_only`; temp copy of db+sidecars when a live WAL defeats ro) → decode steps in `idx` order → Claude-compatible envelopes (`user`/`assistant` with `text`/`tool_use`/`tool_result` blocks). |
| Export | Same envelope list through the shared `HistoryExportService` → `{sessionId, title, provider, messages}` download. |
| Delete | Whitelist + bounds check → remove `<id>.db` **and** its `-shm`/`-wal` sidecars; nothing else is pruned (CLI-owned caches stay untouched). |

## Manual Smoke Test

1. Run two real agy turns from a project directory.
2. Open history with provider `gemini` — both sessions listed, project-scoped.
3. Load each — content restored intact into the chat view.
4. Export — the downloaded JSON opens and carries the messages.
5. Delete — entry gone from the UI and `<uuid>.db` (+ sidecars) gone from
   `conversations/`; sibling conversations untouched.

## Stability Caveats

- The protobuf field map is reverse-engineered from live payloads; an agy upgrade
  can shift field numbers. The reader fails toward empty lists and log lines, and
  the live-shape test is the drift alarm.
- The metadata cache is a legacy artifact the current CLI does not refresh — expect
  it to go stale; the db-existence filter plus the scan fallback are what keeps the
  listing honest.
- `conversation_summaries.db` may be unreadable while the CLI holds it open; the
  reader treats it as best-effort and falls back to id-as-title.
- Reads never block the CLI: read-only URLs, temp-copy fallback (its temp directory
  is removed on success and on failure alike), deletes limited to whole conversation
  files.

## Related Docs

- [OpenCode Integration Quickstart (template)](../opencode/OPENCODE-INTEGRATION-QUICKSTART.md)
- [Streaming Event Logs](../opencode/STREAMING-EVENT-LOGS.md) — gemini's live-CLI
  NDJSON fixtures live in `ai-bridge/services/gemini/fixtures/` (see its
  Gemini-Specific Notes for the replay convention)
- `src/main/java/com/github/claudecodegui/provider/gemini/GeminiHistoryReader.java`
- `src/test/java/com/github/claudecodegui/provider/gemini/GeminiHistoryReaderTest.java`
