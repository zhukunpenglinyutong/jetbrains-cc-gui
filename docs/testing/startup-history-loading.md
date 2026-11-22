# Startup history loading

Automatic restored-history loading remains enabled by default. The application
preference can disable it and leave an explicit Load action in the restored tab.
The disabled value is stored explicitly: IntelliJ's two-argument boolean setter
unsets `false`, which a default of `true` would read back as enabled.
Automatic and manual restore share a bounded 5–120 second timeout, defaulting to
30 seconds. Cancellation preserves the live transcript and fences late commits.

A completed restore is one-shot for its bound session. Completion is recorded
before the queued UI notification, so tab reactivation cannot start another read
or regress the banner to unloaded. A different session object, even with the same
ID, has its own restore binding. The frontend also rejects same-generation
updates after loaded, and the success banner dismisses after three seconds.

Only an accepted transcript commit reports loaded. A regular load already in
progress, live messages added during a restore, stale provider results, malformed
responses and provider deadlines remain retryable; a restore overtaken by newer
live work says so instead of reporting a failure. A transcript that no longer
exists retires the stale session ID and shows a terminal "history no longer
exists" state. Grok and MiniMax report missing history only when the session is
provably absent: an unreadable sessions root, a snapshot being rewritten, or an
existing session directory without a readable transcript stays retryable.
ZCode and DSH hosts report no structured not-found, so their failures stay
retryable rather than guessing from error text.

Every session swap (New Session, a template, opening another session from
history) retires the restore before the transcript is cleared, and so does any
Codex history selection, which rebinds the current session in place. The webview
drops the banner on that reset. A same-session reload from history, or a
background reload of the same session, that commits its transcript settles the
restore as loaded. Ordinary history loads keep their
pre-restore reader contracts, including Codex's empty transcript for an
unreadable rollout and the warning-only ZCode and DSH timeouts.

The Claude/Codex query path retains the official Node process runner with its
whole-operation deadline and complete-output checks, plus restore cancellation.
The settings callback dispatcher is injected by tests; production still uses
the IntelliJ application dispatcher.

## Validation

Checkstyle and the complete Java suite pass: 2,350 discovered, 2,334 passed and
16 skipped, with no failures or errors. The complete webview suite passes (256
files, 2,750 tests) together with test and production TypeScript compilation.
The startup preference is exercised against IntelliJ's real property store, and
provider fixtures cover unreadable roots, snapshots mid-rewrite, transcripts not
yet written and the ordinary-load contracts. Fixtures cover a blocked read followed by a live send, overlapping loads,
missing transcripts, provider response failures, one-shot reactivation, an actual
five-second deadline, late commit fencing and banner dismissal. No live account,
user configuration write or manual IDE startup session is required or claimed.
