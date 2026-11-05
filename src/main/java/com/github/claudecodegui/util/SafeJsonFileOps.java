package com.github.claudecodegui.util;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.io.Writer;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Crash-safe, race-tolerant access to JSON config files that are shared with
 * other processes (e.g. {@code ~/.claude.json}, which the Claude CLI rewrites
 * on its own while the plugin also updates it).
 *
 * <p>Historically these files were written with a plain {@code FileWriter}
 * that truncates the target first. A crash, kill, or antivirus scan pause in
 * the middle of that window left a truncated file behind; every later reader
 * (CLI or plugin) then saw an empty/corrupt config — which is how configured
 * MCP servers "mysteriously vanished". This utility prevents both classes of
 * damage:
 *
 * <ul>
 *   <li><b>Atomic writes</b>: content is staged in a temp file next to the
 *       target and moved into place with {@code ATOMIC_MOVE}. A crash can no
 *       longer leave a half-written config; readers see either the old or the
 *       new document, never a torn one. Symlinked targets are resolved so the
 *       link itself survives, and an existing target keeps its POSIX mode.</li>
 *   <li><b>Automatic backup</b>: before each replace, the previous file is
 *       copied to {@code <name>.ccgui-backup} so a bad overwrite can be
 *       recovered. A damaged live file never overwrites that backup.</li>
 *   <li><b>Retry reads</b>: parse failures (typically another process
 *       mid-write) are retried with backoff instead of being treated as
 *       permanent corruption.</li>
 *   <li><b>Read-only fallback</b>: {@link #readJsonOrBackup} may return the
 *       backup content, but it never writes to disk — a failed read can be a
 *       newer CLI write in progress, and restoring over it would destroy it.</li>
 *   <li><b>Optimistic conflict detection</b>:
 *       {@link #writeAtomicallyIfUnchanged} and
 *       {@link #mutateJsonAtomically} compare a content fingerprint taken at
 *       read time against the file right before the replace, and re-apply the
 *       caller's intent on the fresh content when another process won the race.</li>
 *   <li><b>Advisory locking</b>: {@link #withLock} serialises read-modify-write
 *       cycles across plugin windows (in-JVM via a reentrant lock, cross-process
 *       via an OS file lock on a dedicated {@code .lock} sidecar file). Failing
 *       to obtain the lock is reported to the caller instead of silently
 *       running the critical section unlocked.</li>
 * </ul>
 *
 * <p>Remaining limitation: a process that does not honour the advisory lock
 * (the Claude CLI) can still write between our final fingerprint check and the
 * replace. That window is narrowed to two adjacent statements but not closed —
 * no lock-free scheme can close it without cooperation from the other writer.
 */
public final class SafeJsonFileOps {

    private static final Logger LOG = Logger.getInstance(SafeJsonFileOps.class);

    /** Suffix for the automatic pre-overwrite backup of a config file. */
    public static final String BACKUP_SUFFIX = ".ccgui-backup";

    /** Suffix of the staged temp files that are moved over a config or its backup. */
    private static final String TEMP_SUFFIX = ".ccgui-tmp";

    /** How many times the replace-move is retried (Windows sharing violations while another process reads the target). */
    private static final int MOVE_ATTEMPTS = 5;
    private static final long MOVE_RETRY_DELAY_MS = 100;
    private static final long LOCK_RETRY_DELAY_MS = 50;
    /** Read attempts used inside the conflict-retried mutation helper. */
    private static final int STRICT_READ_ATTEMPTS = 3;

    /** In-JVM (same IDE, multiple tool windows / threads) locks keyed by lock-file path. */
    private static final ConcurrentMap<String, ReentrantLock> IN_JVM_LOCKS = new ConcurrentHashMap<>();

    /**
     * Lock-file keys this thread already holds a cross-process lock for. A nested
     * {@link #withLock} call on the same thread must not try to re-lock the OS
     * file: the outer frame already owns it, and a second lock from another
     * channel would raise {@link OverlappingFileLockException}.
     */
    private static final ThreadLocal<Set<String>> HELD_LOCKS = ThreadLocal.withInitial(HashSet::new);

    private SafeJsonFileOps() {
    }

    /** Callback that serialises JSON into the staged temp file's writer. */
    @FunctionalInterface
    public interface ThrowingWriter {
        void writeTo(Writer writer) throws IOException;
    }

    /** Callback executed while the advisory lock is held. */
    @FunctionalInterface
    public interface IORunnable {
        void run() throws IOException;
    }

    /**
     * Plans one read-modify-write step for {@link #mutateJsonAtomically}.
     *
     * <p>The mutation is re-planned from the freshly read content every time a
     * conflict is detected, so the caller's INTENT (add this server, delete that
     * id) is re-applied to the latest document instead of replaying a stale
     * snapshot.
     */
    @FunctionalInterface
    public interface JsonMutation {
        /**
         * @param current the content read from disk, or {@code null} when the file does not exist
         * @return a writer that stages the new content, or {@code null} when nothing needs to be written
         * @throws IOException when the intent cannot be applied to this content
         */
        ThrowingWriter plan(JsonObject current) throws IOException;
    }

    /**
     * Fingerprint of a config file's content, taken at read time and re-checked
     * right before a replace.
     *
     * <p>Uses a SHA-256 digest rather than size/mtime: mtime granularity is too
     * coarse on several filesystems to see a quick external rewrite, and a size
     * comparison alone misses same-length content changes.
     */
    public static final class ContentSnapshot {
        private static final ContentSnapshot ABSENT = new ContentSnapshot(false, -1L, null);

        private final boolean present;
        private final long size;
        private final byte[] digest;

        private ContentSnapshot(boolean present, long size, byte[] digest) {
            this.present = present;
            this.size = size;
            this.digest = digest;
        }

        /** @return whether the file existed when the snapshot was taken */
        public boolean isPresent() {
            return present;
        }

        /**
         * @param file the file to compare against
         * @return true when the file still holds exactly the snapshotted content
         *         (or is still absent); false when it changed or cannot be re-read
         */
        public boolean matches(Path file) {
            ContentSnapshot current;
            try {
                current = snapshot(file);
            } catch (IOException e) {
                LOG.debug("[SafeJsonFileOps] Could not re-snapshot " + file
                        + " — treating it as changed: " + e.getMessage());
                return false;
            }
            if (present != current.present) {
                return false;
            }
            if (!present) {
                return true;
            }
            return size == current.size && Arrays.equals(digest, current.digest);
        }
    }

    /**
     * Raised when the config changed between the caller's read and write: the
     * caller must re-read the file and re-apply its intent.
     */
    public static final class ConflictException extends IOException {
        private static final long serialVersionUID = 1L;

        ConflictException(String message) {
            super(message);
        }
    }

    /**
     * Atomically replace {@code target} with the JSON produced by {@code writerFn}.
     *
     * <p>Stages the content in a temp file beside the target, backs up the
     * current file to {@code <name>}{@value BACKUP_SUFFIX}}, then moves the
     * temp file onto the target with {@code ATOMIC_MOVE} (falling back to a
     * plain replace on filesystems without atomic moves, retrying either way
     * a few times to ride out transient Windows sharing violations).
     *
     * <p>No write happens when the target already holds exactly the requested
     * content, and the backup is only refreshed from content that parses as a
     * JSON object — see {@link #backupExisting(Path)}.
     *
     * @param target   the config file to replace
     * @param writerFn callback that writes the new content (e.g. {@code w -> gson.toJson(obj, w)})
     * @throws IOException if the content cannot be staged or the replace keeps failing
     */
    public static void writeAtomically(Path target, ThrowingWriter writerFn) throws IOException {
        writeAtomicallyInternal(target, writerFn, null);
    }

    /**
     * Atomically replace {@code target} only if it still matches {@code expected}.
     *
     * <p>Used by read-modify-write callers that must not clobber a concurrent
     * update from another process (the Claude CLI rewrites {@code ~/.claude.json}
     * from its own snapshot at arbitrary times).
     *
     * @param target   the config file to replace
     * @param expected the fingerprint captured when the caller read the file
     * @param writerFn callback that writes the new content
     * @throws ConflictException when the file no longer matches {@code expected}
     * @throws IOException       if the content cannot be staged or the replace keeps failing
     */
    public static void writeAtomicallyIfUnchanged(Path target, ContentSnapshot expected, ThrowingWriter writerFn)
            throws IOException {
        writeAtomicallyInternal(target, writerFn, expected);
    }

    /**
     * Take a content fingerprint of {@code file} for a later
     * {@link #writeAtomicallyIfUnchanged} check.
     *
     * @param file the file to fingerprint (a missing file yields an absent snapshot)
     * @return the fingerprint
     * @throws IOException when the file exists but cannot be read
     */
    public static ContentSnapshot snapshot(Path file) throws IOException {
        if (!Files.isRegularFile(file)) {
            return ContentSnapshot.ABSENT;
        }
        byte[] content = Files.readAllBytes(file);
        return new ContentSnapshot(true, content.length, sha256(content));
    }

    /**
     * Read and parse a JSON object, retrying on transient parse failures
     * (another process mid-write is the usual cause — with atomic writers on
     * the other side those windows are short).
     *
     * <p>Read-only: never writes to the file or its backup.
     *
     * @param file         the JSON file to read
     * @param attempts     number of read attempts before giving up
     * @param retryDelayMs delay between attempts
     * @return the parsed object, or {@code null} if the file is missing or still unparsable
     */
    public static JsonObject readJsonObject(Path file, int attempts, long retryDelayMs) {
        Exception lastError = null;
        for (int attempt = 0; attempt < attempts; attempt++) {
            if (!Files.isRegularFile(file)) {
                return null;
            }
            try (java.io.Reader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
                return JsonParser.parseReader(reader).getAsJsonObject();
            } catch (IOException | RuntimeException e) {
                lastError = e;
                if (attempt + 1 < attempts) {
                    sleepQuietly(retryDelayMs);
                }
            }
        }
        LOG.warn("[SafeJsonFileOps] Could not read/parse " + file
                + " after " + attempts + " attempt(s): "
                + (lastError != null ? lastError.getMessage() : "unknown"));
        return null;
    }

    /**
     * Read a JSON object for a read-modify-write cycle.
     *
     * <p>Unlike {@link #readJsonObject}, an existing-but-unreadable file is
     * reported as an error instead of {@code null}: a write derived from
     * "nothing could be read" would replace the user's config with a document
     * built from scratch.
     *
     * @param file         the JSON file to read
     * @param attempts     read attempts for the primary file
     * @param retryDelayMs delay between attempts
     * @return the parsed object, or {@code null} only when the file does not exist
     * @throws IOException when the file exists but cannot be parsed
     */
    public static JsonObject readJsonObjectStrict(Path file, int attempts, long retryDelayMs) throws IOException {
        JsonObject parsed = readJsonObject(file, attempts, retryDelayMs);
        if (parsed != null) {
            return parsed;
        }
        if (!Files.exists(file)) {
            return null;
        }
        throw new IOException("Could not parse " + file + " after " + attempts
                + " attempt(s); refusing to derive a write from unreadable content. " + recoveryHint(file));
    }

    /**
     * The backup is offered as reference material, not as a drop-in fix: it
     * predates the plugin's last write and any newer edits by other tools.
     *
     * @param file the unreadable config file
     * @return what the user can do about it, naming the backup when one parses
     */
    private static String recoveryHint(Path file) {
        String hint = "Retry in a moment (another process may be writing it); if it stays unreadable,"
                + " make sure it is readable and holds a valid JSON object.";
        Path backup = backupPathOf(file);
        if (readJsonObject(backup, 1, 0) == null) {
            return hint;
        }
        return hint + " " + backup + " holds the copy from before the plugin's last change"
                + " (it lacks that change and any newer edits by other tools).";
    }

    /**
     * Read a JSON object with retries; if the target stays unreadable but the
     * {@code <name>}{@value BACKUP_SUFFIX}} copy parses, return that copy.
     *
     * <p><b>Read-only.</b> The live file is never rewritten here: a read can
     * fail because the CLI is mid-write with content newer than our backup, so
     * restoring the backup over it would destroy data the read was supposed to
     * preserve. Callers that want to repair a file must do so through an
     * explicit write path.
     *
     * @param file         the JSON file to read
     * @param attempts     read attempts for the primary file
     * @param retryDelayMs delay between attempts
     * @return the parsed object (from the file or the backup), or {@code null} when both are unusable
     */
    public static JsonObject readJsonOrBackup(Path file, int attempts, long retryDelayMs) {
        JsonObject parsed = readJsonObject(file, attempts, retryDelayMs);
        if (parsed != null) {
            return parsed;
        }
        Path backup = backupPathOf(file);
        JsonObject fromBackup = readJsonObject(backup, 2, retryDelayMs);
        if (fromBackup == null) {
            return null;
        }
        LOG.warn("[SafeJsonFileOps] " + file.getFileName() + " is unreadable — returning the last known good copy from "
                + backup.getFileName() + " (read-only; the live file is left untouched)");
        return fromBackup;
    }

    /**
     * Apply a mutation to a JSON file with optimistic concurrency control.
     *
     * <p>Each attempt fingerprints the file, reads it strictly, lets the caller
     * re-plan its intent against that content, and performs a guarded replace.
     * When another process replaced the file in between, the attempt is
     * retried from a fresh read; after {@code maxAttempts} the failure is
     * reported instead of overwriting the other writer's data.
     *
     * @param file         the JSON file to mutate
     * @param maxAttempts  how many read/re-plan/replace rounds to try
     * @param retryDelayMs delay between rounds
     * @param mutation     the intent, re-applied to the latest content on every round
     * @throws IOException when the file stays unreadable, the mutation throws, or the
     *                     concurrent changes outlast {@code maxAttempts}
     */
    public static void mutateJsonAtomically(Path file, int maxAttempts, long retryDelayMs, JsonMutation mutation)
            throws IOException {
        IOException lastError = null;
        int attempts = Math.max(1, maxAttempts);
        for (int attempt = 1; attempt <= attempts; attempt++) {
            ContentSnapshot expected = snapshot(file);
            JsonObject current = readJsonObjectStrict(file, STRICT_READ_ATTEMPTS, retryDelayMs);
            ThrowingWriter writer = mutation.plan(current);
            if (writer == null) {
                LOG.debug("[SafeJsonFileOps] " + file.getFileName() + " — mutation needs no write");
                return;
            }
            try {
                writeAtomicallyIfUnchanged(file, expected, writer);
                return;
            } catch (ConflictException conflict) {
                lastError = conflict;
                LOG.info("[SafeJsonFileOps] " + file.getFileName() + " changed while a mutation was applied"
                        + " (attempt " + attempt + "/" + attempts + ") — re-reading and re-applying");
                if (attempt < attempts) {
                    sleepQuietly(retryDelayMs);
                }
            }
        }
        throw new IOException("Could not update " + file + " after " + attempts
                + " attempt(s): the file kept changing concurrently", lastError);
    }

    /**
     * Run {@code action} while holding an advisory lock on {@code lockFile}.
     *
     * <p>Serialises read-modify-write cycles across (a) threads inside this JVM
     * (reentrant lock, handles multiple tool windows in one IDE) and (b)
     * separate plugin processes (OS file lock, handles multiple IDE windows).
     *
     * <p>Failure to obtain either lock is reported, never ignored: running the
     * critical section unlocked would re-open exactly the lost-update window
     * this method exists to close, while still reporting success. Nested calls
     * on the same thread re-enter the outer lock instead of re-locking the OS
     * file.
     *
     * @param lockFile  the sidecar lock file (created if missing, never deleted)
     * @param timeoutMs how long to wait for each lock
     * @param action    the critical section
     * @throws IOException if a lock cannot be acquired (timeout/interrupt/IO error) or the action throws
     */
    public static void withLock(Path lockFile, long timeoutMs, IORunnable action) throws IOException {
        Path parent = lockFile.getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        String lockKey = lockFile.toAbsolutePath().toString();
        if (HELD_LOCKS.get().contains(lockKey)) {
            // Re-entrant call: this thread already owns both the in-JVM and the
            // OS lock through an outer frame.
            action.run();
            return;
        }

        ReentrantLock jvmLock = IN_JVM_LOCKS.computeIfAbsent(lockKey, key -> new ReentrantLock());
        try {
            if (!jvmLock.tryLock(timeoutMs, TimeUnit.MILLISECONDS)) {
                throw new IOException("Timed out after " + timeoutMs + " ms waiting for the in-JVM lock on "
                        + lockFile + "; no changes were written — retry the operation");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted while waiting for the in-JVM lock on " + lockFile, e);
        }

        try {
            try (FileChannel channel = FileChannel.open(lockFile, StandardOpenOption.CREATE, StandardOpenOption.WRITE);
                 FileLock fileLock = acquireLock(channel, lockFile, timeoutMs)) {
                Set<String> held = HELD_LOCKS.get();
                held.add(lockKey);
                try {
                    action.run();
                } finally {
                    held.remove(lockKey);
                }
            } catch (OverlappingFileLockException e) {
                // Another component in this JVM locked the same file through a
                // different channel; proceeding unlocked would silently void the
                // serialisation guarantee.
                throw new IOException("The lock file " + lockFile
                        + " is already locked by this JVM through another channel", e);
            }
        } finally {
            jvmLock.unlock();
        }
    }

    /**
     * Build a sibling path by appending {@code suffix} to the file name
     * (e.g. {@code .claude.json} + {@code .ccgui-backup}).
     *
     * @param file   the base file
     * @param suffix the suffix to append to its name
     * @return the sibling path
     */
    public static Path sibling(Path file, String suffix) {
        return file.resolveSibling(file.getFileName() + suffix);
    }

    /**
     * Locate the {@value BACKUP_SUFFIX} copy of {@code file}.
     *
     * <p>The atomic replace writes the backup beside the real file, so a
     * symlinked config has its backup next to the link's target, not next to
     * the link. A dangling link falls back to the sibling of the link itself.
     *
     * @param file the config file (may be a symlink)
     * @return the path of its backup
     */
    public static Path backupPathOf(Path file) {
        Path real = file;
        if (Files.isSymbolicLink(file)) {
            try {
                real = file.toRealPath();
            } catch (IOException e) {
                LOG.debug("[SafeJsonFileOps] Could not resolve the symlink " + file + ": " + e.getMessage());
            }
        }
        return sibling(real, BACKUP_SUFFIX);
    }

    // ==================== internals ====================

    /**
     * Shared implementation of the atomic replace.
     *
     * @param target   the file to replace (may be a symlink)
     * @param writerFn callback that writes the new content
     * @param expected fingerprint the target must still match, or {@code null} for an unconditional write
     * @throws IOException on staging/backup/replace failure or a fingerprint mismatch
     */
    private static void writeAtomicallyInternal(Path target, ThrowingWriter writerFn, ContentSnapshot expected)
            throws IOException {
        Path realTarget = resolveRealTarget(target);
        Path parent = realTarget.getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        Path tmp = Files.createTempFile(
                parent != null ? parent : realTarget.toAbsolutePath().getParent(),
                realTarget.getFileName().toString(),
                TEMP_SUFFIX);
        try {
            try (Writer writer = Files.newBufferedWriter(tmp, StandardCharsets.UTF_8)) {
                writerFn.writeTo(writer);
                writer.flush();
            }
            if (hasSameContent(realTarget, tmp)) {
                // Nothing to change: rewriting would needlessly rotate the
                // backup and bump the mtime for every no-op sync.
                LOG.debug("[SafeJsonFileOps] " + realTarget.getFileName()
                        + " already holds the requested content — skipping the write");
                return;
            }
            if (expected != null && !expected.matches(realTarget)) {
                throw new ConflictException(realTarget.getFileName()
                        + " changed after it was read — the caller must re-read and re-apply its update");
            }
            backupExisting(realTarget);
            copyPermissions(realTarget, tmp);
            moveWithRetry(tmp, realTarget);
        } finally {
            deleteQuietly(tmp);
        }
    }

    /**
     * Resolve a symlinked target to the file it points at, so the replace
     * updates the real file and leaves the link in place. A rename onto the
     * link path would replace the link itself with a regular file.
     *
     * @param target the path handed to the write
     * @return the real path to replace
     * @throws IOException when the link is dangling or cannot be resolved
     */
    private static Path resolveRealTarget(Path target) throws IOException {
        if (!Files.isSymbolicLink(target)) {
            return target;
        }
        Path real = target.toRealPath();
        LOG.debug("[SafeJsonFileOps] Writing through the symlink " + target + " -> " + real);
        return real;
    }

    /**
     * @param existing the current target
     * @param staged   the temp file holding the new content
     * @return true when both hold byte-identical content
     */
    private static boolean hasSameContent(Path existing, Path staged) {
        if (!Files.isRegularFile(existing)) {
            return false;
        }
        try {
            if (Files.size(existing) != Files.size(staged)) {
                return false;
            }
            return Arrays.equals(Files.readAllBytes(existing), Files.readAllBytes(staged));
        } catch (IOException e) {
            // Unreadable target: fall through to the normal write path.
            return false;
        }
    }

    /**
     * Copy the mode of an existing target onto the staged file so the atomic
     * replace does not silently change permissions (e.g. 0644 → 0600).
     *
     * <p>New files keep the staged temp file's mode — 0600 on POSIX, the
     * process default on filesystems without POSIX attributes. Not covered:
     * Windows ACLs. They are inherited from the directory and are not touched
     * by this code, which is a Windows-verification gap, not a guarantee.
     *
     * @param source the existing target (ignored when it does not exist)
     * @param staged the temp file about to replace it
     */
    private static void copyPermissions(Path source, Path staged) {
        try {
            if (!Files.isRegularFile(source)) {
                return;
            }
            Set<PosixFilePermission> permissions = Files.getPosixFilePermissions(source);
            Files.setPosixFilePermissions(staged, permissions);
        } catch (UnsupportedOperationException | IOException e) {
            LOG.debug("[SafeJsonFileOps] Could not carry permissions from " + source + " to " + staged
                    + ": " + e.getMessage());
        }
    }

    /**
     * Copy the current target to the backup sibling (best effort — a backup
     * failure must not block the write; the staged temp file still replaces
     * the old content atomically).
     *
     * <p>Only content that parses as a JSON object is promoted to the backup:
     * the backup is the recovery source, so replacing it with a damaged
     * snapshot would destroy the last known good copy.
     *
     * <p>The copy is staged in a temp file and moved over the old backup, like
     * the main file: rewriting the backup in place would destroy the last good
     * copy if the IDE died mid-copy, and a concurrent reader could see half of it.
     *
     * <p>The backup may carry secrets (the settings.json backup can hold
     * ANTHROPIC_AUTH_TOKEN — Security J). The staged copy is born owner-only
     * (0600) wherever POSIX is available, because {@code createTempFile}
     * creates it that way and the content is streamed into it rather than
     * copied with the source's mode; the move carries that mode onto the
     * backup. Windows keeps its default ACLs.
     *
     * @param target the file about to be replaced
     */
    private static void backupExisting(Path target) {
        if (!Files.isRegularFile(target)) {
            return;
        }
        if (!holdsJsonObject(target)) {
            LOG.warn("[SafeJsonFileOps] Not backing up " + target.getFileName()
                    + " — its current content is not a JSON object, the last known good backup is kept");
            return;
        }
        Path backup = sibling(target, BACKUP_SUFFIX);
        Path staged = null;
        try {
            staged = Files.createTempFile(backup.toAbsolutePath().getParent(),
                    backup.getFileName().toString(), TEMP_SUFFIX);
            try (java.io.InputStream in = Files.newInputStream(target);
                 java.io.OutputStream out = Files.newOutputStream(staged,
                         StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE)) {
                in.transferTo(out);
            }
            hardenOwnerOnly(staged);
            moveWithRetry(staged, backup);
        } catch (IOException e) {
            LOG.warn("[SafeJsonFileOps] Could not back up " + target + " before replacing: " + e.getMessage());
        } finally {
            deleteQuietly(staged);
        }
    }

    /**
     * Remove a leftover staged file, if any (best effort).
     *
     * @param staged the staged temp file, or {@code null} when none was created
     */
    private static void deleteQuietly(Path staged) {
        if (staged == null) {
            return;
        }
        try {
            Files.deleteIfExists(staged);
        } catch (IOException cleanupError) {
            LOG.debug("[SafeJsonFileOps] Could not delete staged temp file " + staged + ": " + cleanupError.getMessage());
        }
    }

    /**
     * Gson parses leniently: a truncated (0-byte) file reads as JSON null and a
     * NUL-filled one as a bare string. Neither is a usable config, so only a
     * JSON object counts.
     *
     * @param file the candidate config file
     * @return true when the file parses as a JSON object
     */
    private static boolean holdsJsonObject(Path file) {
        try (java.io.Reader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            return JsonParser.parseReader(reader).isJsonObject();
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    /** Best-effort 0600 — same policy as ClaudeSettingsManager.hardenFilePermissions. */
    private static void hardenOwnerOnly(Path file) {
        try {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException | IOException e) {
            LOG.debug("[SafeJsonFileOps] Could not set 0600 on " + file + ": " + e.getMessage());
        }
    }

    /**
     * Move the staged temp file onto the target, retrying transient failures
     * (Windows denies the replace while another process holds the target open
     * without share-delete) and degrading to a non-atomic replace only when
     * the filesystem has no atomic move.
     */
    private static void moveWithRetry(Path source, Path target) throws IOException {
        boolean atomicSupported = true;
        IOException lastError = null;
        for (int attempt = 0; attempt < MOVE_ATTEMPTS; attempt++) {
            try {
                if (atomicSupported) {
                    try {
                        Files.move(source, target,
                                StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                        return;
                    } catch (AtomicMoveNotSupportedException notAtomic) {
                        atomicSupported = false;
                        continue;
                    }
                }
                Files.move(source, target, StandardCopyOption.REPLACE_EXISTING);
                return;
            } catch (IOException e) {
                lastError = e;
                sleepQuietly(MOVE_RETRY_DELAY_MS);
            }
        }
        throw new IOException("Could not replace " + target + " after " + MOVE_ATTEMPTS + " attempts"
                + (lastError != null ? ": " + lastError.getMessage() : ""), lastError);
    }

    /**
     * Try to acquire the OS-level exclusive lock, polling until the deadline.
     *
     * @param channel   the channel of the lock file
     * @param lockFile  the lock file (for the error message)
     * @param timeoutMs how long to wait
     * @return the acquired lock
     * @throws IOException when the timeout elapses, the wait is interrupted, or the channel fails
     */
    private static FileLock acquireLock(FileChannel channel, Path lockFile, long timeoutMs) throws IOException {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        for (;;) {
            FileLock lock = channel.tryLock();
            if (lock != null) {
                return lock;
            }
            if (System.nanoTime() >= deadline) {
                throw new IOException("Timed out after " + timeoutMs + " ms waiting for the cross-process lock "
                        + lockFile + "; no changes were written — retry the operation");
            }
            try {
                Thread.sleep(LOCK_RETRY_DELAY_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("Interrupted while waiting for the cross-process lock " + lockFile, e);
            }
        }
    }

    /** Sleep helper that swallows interrupts (keeps interrupt status set). */
    private static void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * @param content the bytes to digest
     * @return the SHA-256 digest of {@code content}
     */
    private static byte[] sha256(byte[] content) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(content);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required by the Java platform", e);
        }
    }
}
