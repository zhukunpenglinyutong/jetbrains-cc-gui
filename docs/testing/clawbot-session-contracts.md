# Claw session contracts

This topic supplies transport-neutral contracts, immutable session metadata,
bounded registry/queues and turn lifecycle. It does not start a channel, open a
socket, read credentials or activate settings.

Ownership includes IDE instance, connection epoch, provider and binding
generation. Epochs order connections within one IDE instance; another instance
cannot preempt an occupied handle by choosing a larger epoch. It must use a
different handle or wait for explicit unregistration/capacity eviction.
Reconnect snapshots replace one owner's roster atomically. Old connections
cannot heartbeat, drain or acknowledge another owner's queues.

Inbound queues accept only MESSAGE and UNSUPPORTED_MEDIA and require INBOUND.
Control queues accept INTERRUPT, NEW_SESSION, APPROVE, DENY and ANSWER and require
CONTROL. APPROVE, DENY and ANSWER additionally require an exact target and a
nonempty interaction token at enqueue time. Command conversion retains target,
route revision and interaction token. Generic untargeted stop/new commands bind
to the current target before enqueue. Waiting messages for an old target are
discarded; already dispatched work can still be acknowledged by its owner.

Message IDs have the same 512-character bound for construction and acknowledgement.
Each session remembers its last 256 accepted IDs across both queues, including
acknowledged IDs. Pending IDs remain deduplicated until dequeued even after this
window rolls over. This is bounded in-memory redelivery suppression, not durable
exactly-once delivery across restarts or ownership changes.

The registry holds at most 256 sessions and each queue at most 64 messages.
All nonterminal statuses expire after their monotonic heartbeat lease, including
UNKNOWN and UNAUTHORIZED. Registration and snapshot replacement reclaim stale
capacity before checking admission. Invalid/oversized snapshots cannot partially
replace an owner's roster. Metadata and capabilities are bounded and copied;
JSON epochs/revisions reject coercion, fractions, negatives and overflow.

`idleMillis` means **cumulative inactive time in the current ownership/generation**,
not time since the last action. Activity pauses this counter under a renewable
15-second lease. Routing subtracts its selection baseline, preserving the
remaining idle allowance during a long task. Repeated inactive reports and BUSY
heartbeats cannot renew proof of activity. Backward monotonic observations fail
closed. Ownership/generation changes reset the baseline.

Turn continuations execute in order even if an earlier continuation failed.
An unbound lifecycle keeps the follow-up visible and returns an error. Malformed
follow-up fields never dispatch a continuation or escape as JSON conversion errors.

Run focused tests with `gradlew test --tests '*ClawBot*Test' checkstyleMain`.
The contracts PR contains isolated boundary, registry, lifecycle and review
regressions; downstream topics additionally test routing, IPC and IDE activation.
