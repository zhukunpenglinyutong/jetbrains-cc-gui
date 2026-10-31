# AI data runtime admission

Migration intent excludes new starts before idle runtimes are stopped. Active
work rejects migration. Runtime callbacks execute outside the gate mutex.

On Windows, process/read permits share a stable OS lock with exclusive migration
permits. The lock lives under the user's `.cc-gui/ai-data-coordination`, outside
every movable provider home. Per-inode JVM state rejects local contenders before
opening another descriptor, which would otherwise release POSIX process locks
when that descriptor closes. Lock ownership includes PID and process start time.

New starts request cancellation from the current owner's pre-commit migration
and wait for rollback. The request carries an owner ID so it cannot cancel a
later migration. After commit, starts wait without cancelling the move. Waiting
for another JVM is bounded to 30 seconds and reports `AI_DATA_MIGRATION_BUSY`.
An active migration's journal is not reported as abandoned recovery while its
OS lock is held. A leftover journal blocks admission until recovery completes.

An I/O failure in the optional coordination directory disables relocation and
reports that condition, while ordinary AI process startup remains available.
Inventory reads and maintenance do not receive unprotected read permits.
Contention and pending recovery are not treated as coordination I/O failures.

The migration permit owns its exclusive OS lock through commit or rollback
cleanup. Acquiring it must not be followed by a second acquisition of that same
lock. Closing a permit is idempotent; closing owner metadata precedes unlocking.

Observed descendants retain process admission after parent exit. Observation
retries transient failures, prunes exited handles, and avoids recursively
scanning every child after the root scan. A termination timeout retains admission
and repeatedly checks newly observed children. The dependent relocation layer requests normal daemon shutdown and preserves
detached background tools; explicit user stop may terminate the owned tree.

Process handles cannot guarantee observation of an arbitrary process that forks
and reparents between OS snapshots. They do not establish that unrelated external
CLIs are idle. The relocation layer performs its own external-process checks.

Focused checks cover independent gates, cancellation on both sides of commit,
coordination I/O degradation, real parent/child processes, competing JVMs,
owner death, retained shared/exclusive locks, and linked coordination paths.
The foundation PR keeps launcher wiring and directory migration in dependent
patches; those patches add daemon, journal recovery and cleanup checks.
