# Startup history loading

Automatic restored-history loading remains enabled by default. The application
preference can disable it and leave an explicit Load action in the restored tab.
Automatic and manual restore share a bounded 5–120 second timeout, defaulting to
30 seconds. Cancellation preserves the live transcript and fences late commits.

A completed restore is one-shot for its bound session. Completion is recorded
before the queued UI notification, so tab reactivation cannot start another read
or regress the banner to unloaded. A different session object, even with the same
ID, has its own restore binding. The frontend also rejects same-generation
updates after loaded, and the success banner dismisses after three seconds.

Only an accepted transcript commit reports loaded. A regular load already in
progress, live messages added during a restore, stale provider results, missing
transcripts, malformed responses and provider deadlines remain retryable. Normal
explicit history loads retain their existing stale-session retirement behavior.
ZCode and DSH no longer turn missing responses into empty success, while Grok
and MiniMax strict restore reads distinguish missing files from valid empty data.

The Claude/Codex query path retains the official Node process runner with its
whole-operation deadline and complete-output checks, plus restore cancellation.
The settings callback dispatcher is injected by tests; production still uses
the IntelliJ application dispatcher.

## Validation

All 85 focused Java cases and Checkstyle pass. The complete Java suite passes:
2,047 discovered, 2,031 passed and 16 skipped, with no failures or errors.
All 39 affected frontend cases, test TypeScript compilation and production build
pass. Fixtures cover a blocked read followed by a live send, overlapping loads,
missing transcripts, provider response failures, one-shot reactivation, an actual
five-second deadline, late commit fencing and banner dismissal. No live account,
user configuration write or manual IDE startup session is required or claimed.
