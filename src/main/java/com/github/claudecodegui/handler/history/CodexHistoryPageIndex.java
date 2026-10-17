package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Objects;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;

final class CodexHistoryPageIndex implements AutoCloseable {
    private static final long MAX_IDLE_NANOS = java.util.concurrent.TimeUnit.MINUTES.toNanos(5);
    private static final int VALIDATION_BLOCK_BYTES = 4096;
    // Each digest also retains an array header and an ArrayList reference.
    private static final int VALIDATION_HASH_BYTES = 64;
    private final int maxSessions;
    private final int maxMessages;
    private final long maxBytes;
    private final LinkedHashMap<Path, Entry> entries = new LinkedHashMap<>(4, 0.75f, true);

    CodexHistoryPageIndex() {
        this(2, 200_000, 64L * 1024 * 1024);
    }

    CodexHistoryPageIndex(int maxSessions, int maxMessages, long maxBytes) {
        if (maxSessions <= 0 || maxMessages <= 0 || maxBytes <= 0) {
            throw new IllegalArgumentException("Codex index budgets must be positive");
        }
        this.maxSessions = maxSessions;
        this.maxMessages = maxMessages;
        this.maxBytes = maxBytes;
    }

    synchronized HistoryMessageInjector.CodexHistoryPage read(
            CodexHistoryReader reader, String sessionId, Integer beforeTurn, int pageSize,
            BooleanSupplier active) throws IOException {
        checkActive(active);
        if (pageSize <= 0 || (beforeTurn != null && beforeTurn < 0)) {
            throw new IllegalArgumentException("Invalid Codex history page cursor or size");
        }
        expire();
        Path source = reader.resolveSessionFile(sessionId);
        Snapshot snapshot = Snapshot.read(source);
        Entry entry = this.entries.get(source);
        // Windows replacement can preserve all exposed metadata, so a cache hit still needs content validation.
        // A null snapshot means a half-initialized entry; skip validation and let the indexing branch fill it.
        if (entry != null && entry.snapshot != null
                && (entry.snapshot.equals(snapshot)
                ? !entry.stillRecognizesSource(source) : !entry.canAppend(source, snapshot))) {
            remove(source);
            entry = null;
        }
        if (entry == null) {
            while (entries.size() >= maxSessions) {
                remove(entries.keySet().iterator().next());
            }
            entry = new Entry();
            entries.put(source, entry);
        }
        try {
            int parsed = 0;
            long start = entry.snapshot == null ? 0 : entry.snapshot.size;
            long readBytes = snapshot.size - start;
            if (entry.snapshot == null || !entry.snapshot.equals(snapshot)) {
                Entry target = entry;
                Entry.SourceCapture capture = entry.new SourceCapture(snapshot, active);
                parsed = reader.forEachSessionMessage(sessionId, source, start, snapshot.size, active, raw -> {
                    HistoryMessageInjector.extractSessionMeta(raw, target.metadata);
                    target.accumulator.accept(raw);
                    if (target.accumulator.retainedBytes() > this.maxBytes) {
                        throw new IndexLimitException();
                    }
                }, capture::accept);
                if (entry.accumulator.retainedBytes() > maxBytes) {
                    throw new IndexLimitException();
                }
                checkActive(active);
                if (!snapshot.equals(Snapshot.read(source))) {
                    throw new IOException("Codex history changed while indexing; retry the page");
                }
                capture.finish();
            }
            HistoryMessageInjector.CodexHistoryPage page = entry.page(beforeTurn, pageSize, active);
            page.rawRecordCount = parsed;
            page.sourceBytesRead = readBytes;
            return page;
        } catch (IndexLimitException exception) {
            remove(source);
            Snapshot beforeFallback = Snapshot.read(source);
            HistoryMessageInjector.CodexHistoryPage page =
                    HistoryMessageInjector.scanCodexHistoryPageUncached(reader, sessionId, beforeTurn, pageSize, active);
            checkActive(active);
            if (!beforeFallback.equals(Snapshot.read(source))) {
                throw new IOException("Codex history changed while reading; retry the page");
            }
            return page;
        } catch (IOException | RuntimeException exception) {
            remove(source);
            throw exception;
        }
    }

    private void expire() throws IOException {
        long now = System.nanoTime();
        for (Path path : new ArrayList<>(entries.keySet())) {
            if (now - entries.get(path).lastAccess > MAX_IDLE_NANOS) {
                remove(path);
            }
        }
    }

    synchronized int size() {
        return entries.size();
    }

    synchronized List<Path> spoolFiles() {
        return entries.values().stream().map(entry -> entry.spoolPath).toList();
    }

    private void remove(Path source) throws IOException {
        Entry entry = entries.remove(source);
        if (entry != null) {
            entry.close();
        }
    }

    @Override
    public synchronized void close() throws IOException {
        for (Path source : new ArrayList<>(entries.keySet())) {
            remove(source);
        }
    }

    private static void checkActive(BooleanSupplier active) {
        if (!active.getAsBoolean()) {
            throw new CancellationException("Stale Codex history request");
        }
    }

    private record Snapshot(long size, FileTime modified, FileTime created, Object fileKey, Object changed) {
        static Snapshot read(Path source) throws IOException {
            BasicFileAttributes attributes = Files.readAttributes(source, BasicFileAttributes.class);
            Object changed = null;
            if (source.getFileSystem().supportedFileAttributeViews().contains("unix")) {
                changed = Files.getAttribute(source, "unix:ctime");
            }
            return new Snapshot(attributes.size(), attributes.lastModifiedTime(), attributes.creationTime(), attributes.fileKey(), changed);
        }

        boolean sameFile(Snapshot other) {
            return Objects.equals(fileKey, other.fileKey) && created.equals(other.created);
        }
    }

    private static final class IndexLimitException extends RuntimeException { }

    private final class Entry implements AutoCloseable {
        private final Path spoolPath = Files.createTempFile("ccgui-codex-page-", ".jsonl");
        private final RandomAccessFile spool = new RandomAccessFile(spoolPath.toFile(), "rw");
        private final List<Long> offsets = new ArrayList<>();
        private final List<Integer> turns = new ArrayList<>();
        private final HistoryMessageInjector.CodexHistoryPage metadata = new HistoryMessageInjector.CodexHistoryPage();
        private final HistoryMessageInjector.CodexFrontendMessageAccumulator accumulator =
                new HistoryMessageInjector.CodexFrontendMessageAccumulator(this::append, this::updateUsage);
        private Snapshot snapshot;
        private byte[] head;
        private byte[] tail;
        private final List<byte[]> blockHashes = new ArrayList<>();
        private int nextValidationBlock = 1;
        private boolean terminated;
        private JsonObject lastAssistant;
        private int lastAssistantIndex = -1;
        private long lastAccess = System.nanoTime();

        private Entry() throws IOException { }

        private void append(JsonObject message) {
            if (HistoryMessageInjector.isHumanUserMessage(message)) {
                turns.add(offsets.size());
            }
            if (turns.isEmpty()) {
                return;
            }
            if (offsets.size() >= maxMessages) {
                throw new IndexLimitException();
            }
            offsets.add(write(message));
            if ("assistant".equals(HistoryMessageInjector.getStringProperty(message, "type"))) {
                lastAssistant = message;
                lastAssistantIndex = offsets.size() - 1;
            }
        }

        private void updateUsage(JsonObject message) {
            if (message == lastAssistant && lastAssistantIndex >= 0) {
                offsets.set(lastAssistantIndex, write(message));
            }
        }

        private long write(JsonObject message) {
            byte[] encoded = message.toString().getBytes(StandardCharsets.UTF_8);
            try {
                long offset = spool.length();
                if (offset + encoded.length + Integer.BYTES > maxBytes) {
                    throw new IndexLimitException();
                }
                spool.seek(offset);
                spool.writeInt(encoded.length);
                spool.write(encoded);
                return offset;
            } catch (IOException exception) {
                throw new UncheckedIOException(exception);
            }
        }

        private JsonObject readMessage(int index) throws IOException {
            spool.seek(offsets.get(index));
            byte[] encoded = new byte[spool.readInt()];
            spool.readFully(encoded);
            return JsonParser.parseString(new String(encoded, StandardCharsets.UTF_8)).getAsJsonObject();
        }

        private HistoryMessageInjector.CodexHistoryPage page(Integer beforeTurn, int pageSize,
                                                            BooleanSupplier active) throws IOException {
            lastAccess = System.nanoTime();
            List<JsonObject> pending = this.accumulator.pendingMessages();
            boolean pendingTurn = !pending.isEmpty() && HistoryMessageInjector.isHumanUserMessage(pending.get(0));
            int totalTurns = turns.size() + (pendingTurn ? 1 : 0);
            HistoryMessageInjector.CodexHistoryPage page = new HistoryMessageInjector.CodexHistoryPage();
            page.threadId = metadata.threadId;
            page.cwd = metadata.cwd;
            page.totalTurns = totalTurns;
            page.cursorReset = beforeTurn != null && beforeTurn > totalTurns;
            page.toTurn = beforeTurn == null || page.cursorReset ? totalTurns : beforeTurn;
            page.fromTurn = Math.max(0, page.toTurn - pageSize);
            int start = page.fromTurn < turns.size() ? turns.get(page.fromTurn) : offsets.size();
            int end = page.toTurn < turns.size() ? turns.get(page.toTurn) : offsets.size();
            for (int index = start; index < end; index++) {
                checkActive(active);
                page.messages.add(readMessage(index));
            }
            if (page.toTurn == totalTurns && page.toTurn > page.fromTurn) {
                page.messages.addAll(pending);
            }
            checkActive(active);
            return page;
        }

        private boolean canAppend(Path source, Snapshot next) throws IOException {
            if (this.snapshot == null || !this.terminated || next.size <= this.snapshot.size || !this.snapshot.sameFile(next)) {
                return false;
            }
            return this.stillRecognizesSource(source);
        }

        private boolean stillRecognizesSource(Path source) throws IOException {
            try (RandomAccessFile input = new RandomAccessFile(source.toFile(), "r")) {
                if (!Arrays.equals(this.head, this.sample(input, 0, this.head.length))
                        || !Arrays.equals(this.tail, this.sample(input, this.snapshot.size - this.tail.length, this.tail.length))) {
                    return false;
                }
                // At most 12 KiB per check; rotating blocks eventually find equal-metadata interior rewrites.
                int endBlock = this.blockHashes.size() - 1;
                if (endBlock > 1) {
                    if (this.nextValidationBlock >= endBlock) {
                        this.nextValidationBlock = 1;
                    }
                    int block = this.nextValidationBlock;
                    this.nextValidationBlock = block + 1 >= endBlock ? 1 : block + 1;
                    byte[] bytes = this.sample(input, (long) block * VALIDATION_BLOCK_BYTES, VALIDATION_BLOCK_BYTES);
                    return Arrays.equals(this.blockHashes.get(block), this.checksum(bytes));
                }
                return true;
            }
        }

        private final class SourceCapture {
            private final Snapshot next;
            private final BooleanSupplier active;
            private final byte[] head;
            private final byte[] tail;
            private final byte[] block = new byte[VALIDATION_BLOCK_BYTES];
            private long position;
            private int tailSize;
            private int blockSize;

            private SourceCapture(Snapshot next, BooleanSupplier active) {
                long blocks = next.size / VALIDATION_BLOCK_BYTES + (next.size % VALIDATION_BLOCK_BYTES == 0 ? 0 : 1);
                int sampleSize = (int) Math.min(VALIDATION_BLOCK_BYTES, next.size);
                if (2L * sampleSize + blocks * VALIDATION_HASH_BYTES > CodexHistoryPageIndex.this.maxBytes) {
                    throw new IndexLimitException();
                }
                this.next = next;
                this.active = active;
                this.head = new byte[sampleSize];
                this.tail = new byte[sampleSize];
                this.position = Entry.this.snapshot == null ? 0 : Entry.this.snapshot.size;
                this.blockSize = (int) (this.position % VALIDATION_BLOCK_BYTES);
                if (Entry.this.snapshot != null) {
                    System.arraycopy(Entry.this.head, 0, this.head, 0, Entry.this.head.length);
                    System.arraycopy(Entry.this.tail, 0, this.tail, 0, Entry.this.tail.length);
                    this.tailSize = Entry.this.tail.length;
                    System.arraycopy(Entry.this.tail, Entry.this.tail.length - this.blockSize,
                            this.block, 0, this.blockSize);
                }
                // Appends extend the prior partial block without rereading old source bytes.
                int startBlock = Math.toIntExact(this.position / VALIDATION_BLOCK_BYTES);
                Entry.this.blockHashes.subList(startBlock, Entry.this.blockHashes.size()).clear();
            }

            private void accept(ByteBuffer bytes) {
                // A later read can observe a rewrite that the parser never saw and bless stale page contents.
                while (bytes.hasRemaining()) {
                    checkActive(this.active);
                    int start = this.blockSize;
                    int length = Math.min(VALIDATION_BLOCK_BYTES - start, bytes.remaining());
                    bytes.get(this.block, start, length);
                    if (this.position < this.head.length) {
                        int headLength = (int) Math.min(length, this.head.length - this.position);
                        System.arraycopy(this.block, start, this.head, (int) this.position, headLength);
                    }
                    int retainedTail = Math.min(this.tailSize, this.tail.length - length);
                    System.arraycopy(this.tail, this.tailSize - retainedTail, this.tail, 0, retainedTail);
                    System.arraycopy(this.block, start, this.tail, retainedTail, length);
                    this.tailSize = retainedTail + length;
                    this.position += length;
                    this.blockSize += length;
                    if (this.blockSize == VALIDATION_BLOCK_BYTES) {
                        Entry.this.blockHashes.add(Entry.this.checksum(this.block));
                        this.blockSize = 0;
                    }
                }
            }

            private void finish() throws IOException {
                checkActive(this.active);
                if (this.position != this.next.size) {
                    throw new IOException("Codex history byte range changed while indexing");
                }
                if (this.blockSize > 0) {
                    Entry.this.blockHashes.add(Entry.this.checksum(Arrays.copyOf(this.block, this.blockSize)));
                }
                Entry.this.head = this.head;
                Entry.this.tail = this.tail;
                Entry.this.terminated = this.next.size == 0 || this.tail[this.tail.length - 1] == '\n';
                Entry.this.snapshot = this.next;
            }
        }

        private byte[] checksum(byte[] bytes) {
            try {
                return MessageDigest.getInstance("SHA-256").digest(bytes);
            } catch (NoSuchAlgorithmException exception) {
                throw new IllegalStateException("SHA-256 is required by the Java runtime", exception);
            }
        }

        private byte[] sample(RandomAccessFile input, long offset, int length) throws IOException {
            byte[] bytes = new byte[length];
            input.seek(offset);
            input.readFully(bytes);
            return bytes;
        }

        @Override
        public void close() throws IOException {
            try {
                spool.close();
            } finally {
                Files.deleteIfExists(spoolPath);
            }
        }
    }
}
