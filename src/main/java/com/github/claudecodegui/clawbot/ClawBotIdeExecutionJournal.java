package com.github.claudecodegui.clawbot;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;

/** Bounded IDE-side execution guard that never stores message content. */
public final class ClawBotIdeExecutionJournal {

    private static final String FILE_NAME = "ide-execution-journal.json";
    private static final int MAX_RECORD_COUNT = 2_048;
    private static final long MAX_FILE_SIZE = 768L * 1024L;
    private static final Map<Path, ReentrantLock> PROCESS_LOCKS = new ConcurrentHashMap<>();

    private final Path stateFile;
    private final Path lockFile;
    private final Map<String, Entry> entries = new LinkedHashMap<>();

    public ClawBotIdeExecutionJournal(Path runtimeDirectory) {
        stateFile = Objects.requireNonNull(runtimeDirectory, "runtimeDirectory")
                .toAbsolutePath().normalize().resolve(FILE_NAME);
        lockFile = stateFile.resolveSibling(FILE_NAME + ".lock");
    }

    public synchronized void load() throws IOException {
        withJournalLock(() -> null);
    }

    /** Claims a message for provider execution exactly once per retained message ID. */
    public synchronized boolean tryStart(String messageId) throws IOException {
        return withJournalLock(() -> {
            requireMessageId(messageId);
            if (entries.containsKey(messageId)) {
                return false;
            }
            if (entries.size() >= MAX_RECORD_COUNT) {
                throw journalFull();
            }
            ProcessHandle owner = ProcessHandle.current();
            Entry entry = new Entry(messageId, State.STARTED, System.currentTimeMillis(), owner.pid(),
                    owner.info().startInstant().map(Instant::toEpochMilli).orElse(0L));
            entries.put(messageId, entry);
            try {
                save();
            } catch (IOException error) {
                entries.remove(messageId);
                throw error;
            }
            return true;
        });
    }

    public synchronized void markCompleted(String messageId) throws IOException {
        withJournalLock(() -> {
            requireMessageId(messageId);
            Entry current = entries.get(messageId);
            if (current == null || (current.state() != State.STARTED && current.state() != State.UNKNOWN)) {
                return null;
            }
            entries.put(messageId, current.withState(State.COMPLETED, System.currentTimeMillis()));
            try {
                save();
            } catch (IOException error) {
                entries.put(messageId, current);
                throw error;
            }
            return null;
        });
    }

    /** Removes the guard after the gateway accepts the terminal reply. */
    public synchronized void acknowledge(String messageId) throws IOException {
        withJournalLock(() -> {
            requireMessageId(messageId);
            Entry current = entries.remove(messageId);
            if (current == null) {
                return null;
            }
            try {
                save();
            } catch (IOException error) {
                entries.put(messageId, current);
                throw error;
            }
            return null;
        });
    }

    public synchronized State stateOf(String messageId) throws IOException {
        return withJournalLock(() -> {
            requireMessageId(messageId);
            Entry entry = entries.get(messageId);
            return entry == null ? State.NONE : entry.state();
        });
    }

    private <T> T withJournalLock(IoOperation<T> operation) throws IOException {
        ReentrantLock processLock = PROCESS_LOCKS.computeIfAbsent(lockFile, ignored -> new ReentrantLock());
        processLock.lock();
        try {
            Files.createDirectories(stateFile.getParent());
            if (Files.exists(lockFile, LinkOption.NOFOLLOW_LINKS)
                    && !Files.isRegularFile(lockFile, LinkOption.NOFOLLOW_LINKS)) {
                throw invalidJournal();
            }
            try (FileChannel channel = FileChannel.open(
                    lockFile, StandardOpenOption.CREATE, StandardOpenOption.WRITE);
                 FileLock ignored = channel.lock()) {
                refreshFromDisk();
                return operation.run();
            }
        } finally {
            processLock.unlock();
        }
    }

    private void refreshFromDisk() throws IOException {
        Map<String, Entry> currentEntries = readEntries();
        boolean changed = false;
        for (Map.Entry<String, Entry> item : currentEntries.entrySet()) {
            Entry entry = item.getValue();
            if (entry.state() == State.STARTED
                    && !isProcessAlive(entry.ownerProcessId(), entry.ownerProcessStartedAt())) {
                item.setValue(entry.withState(State.UNKNOWN, System.currentTimeMillis()));
                changed = true;
            }
        }
        entries.clear();
        entries.putAll(currentEntries);
        if (changed) {
            save();
        }
    }

    private Map<String, Entry> readEntries() throws IOException {
        Map<String, Entry> result = new LinkedHashMap<>();
        if (!Files.exists(stateFile, LinkOption.NOFOLLOW_LINKS)) {
            return result;
        }
        if (!Files.isRegularFile(stateFile, LinkOption.NOFOLLOW_LINKS)
                || Files.size(stateFile) > MAX_FILE_SIZE) {
            throw invalidJournal();
        }
        try {
            JsonElement parsed = JsonParser.parseString(Files.readString(stateFile, StandardCharsets.UTF_8));
            if (!parsed.isJsonArray() || parsed.getAsJsonArray().size() > MAX_RECORD_COUNT) {
                throw invalidJournal();
            }
            for (JsonElement element : parsed.getAsJsonArray()) {
                Entry entry = readEntry(element);
                if (result.put(entry.messageId(), entry) != null) {
                    throw invalidJournal();
                }
            }
        } catch (com.google.gson.JsonParseException | IllegalStateException error) {
            throw new IOException("CLAWBOT_IDE_EXECUTION_JOURNAL_INVALID", error);
        }
        return result;
    }

    private void save() throws IOException {
        JsonArray payload = new JsonArray();
        for (Entry entry : entries.values()) {
            JsonObject value = new JsonObject();
            value.addProperty("messageId", entry.messageId());
            value.addProperty("state", entry.state().name());
            value.addProperty("updatedAt", entry.updatedAt());
            value.addProperty("ownerProcessId", entry.ownerProcessId());
            value.addProperty("ownerProcessStartedAt", entry.ownerProcessStartedAt());
            payload.add(value);
        }
        String serialized = payload.toString();
        if (serialized.getBytes(StandardCharsets.UTF_8).length > MAX_FILE_SIZE) {
            throw journalFull();
        }
        Path temporary = Files.createTempFile(stateFile.getParent(), "ide-execution-journal-", ".tmp");
        try {
            Files.writeString(temporary, serialized, StandardCharsets.UTF_8);
            try {
                Files.move(temporary, stateFile, StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException error) {
                Files.move(temporary, stateFile, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private static Entry readEntry(JsonElement element) throws IOException {
        if (element == null || !element.isJsonObject()) {
            throw invalidJournal();
        }
        JsonObject value = element.getAsJsonObject();
        String messageId = readString(value, "messageId", ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH);
        String stateValue = readString(value, "state", 16);
        State state;
        try {
            state = State.valueOf(stateValue);
        } catch (IllegalArgumentException error) {
            throw invalidJournal();
        }
        if (state == State.NONE) {
            throw invalidJournal();
        }
        long updatedAt;
        try {
            updatedAt = value.get("updatedAt").getAsLong();
            if (updatedAt < 0L) {
                throw new NumberFormatException("updatedAt");
            }
        } catch (RuntimeException error) {
            throw new IOException("CLAWBOT_IDE_EXECUTION_JOURNAL_INVALID", error);
        }
        long ownerProcessId;
        long ownerProcessStartedAt;
        try {
            ownerProcessId = value.has("ownerProcessId") ? value.get("ownerProcessId").getAsLong() : 0L;
            ownerProcessStartedAt = value.has("ownerProcessStartedAt")
                    ? value.get("ownerProcessStartedAt").getAsLong() : 0L;
            if (ownerProcessId < 0L || ownerProcessStartedAt < 0L) {
                throw new NumberFormatException("ownerProcessId");
            }
        } catch (RuntimeException error) {
            throw new IOException("CLAWBOT_IDE_EXECUTION_JOURNAL_INVALID", error);
        }
        return new Entry(messageId, state, updatedAt, ownerProcessId, ownerProcessStartedAt);
    }

    private static boolean isProcessAlive(long processId, long startedAt) {
        if (processId <= 0L) {
            return false;
        }
        return ProcessHandle.of(processId).filter(ProcessHandle::isAlive).map(process -> {
            if (startedAt == 0L) {
                return true;
            }
            return process.info().startInstant().map(Instant::toEpochMilli)
                    .filter(processStart -> processStart == startedAt).isPresent();
        }).orElse(false);
    }

    private static String readString(JsonObject value, String name, int maxLength) throws IOException {
        JsonElement element = value.get(name);
        if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
            throw invalidJournal();
        }
        String result = element.getAsString();
        if (result.isBlank() || result.length() > maxLength
                || result.chars().anyMatch(Character::isISOControl)) {
            throw invalidJournal();
        }
        return result;
    }

    private static void requireMessageId(String messageId) throws IOException {
        if (messageId == null || messageId.isBlank()
                || messageId.length() > ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH
                || messageId.chars().anyMatch(Character::isISOControl)) {
            throw new IOException("CLAWBOT_IDE_EXECUTION_MESSAGE_ID_INVALID");
        }
    }

    private static IOException invalidJournal() {
        return new IOException("CLAWBOT_IDE_EXECUTION_JOURNAL_INVALID");
    }

    private static IOException journalFull() {
        return new IOException("CLAWBOT_IDE_EXECUTION_JOURNAL_FULL");
    }

    @FunctionalInterface
    private interface IoOperation<T> {
        T run() throws IOException;
    }

    public enum State {
        NONE,
        STARTED,
        COMPLETED,
        UNKNOWN
    }

    private record Entry(
            String messageId, State state, long updatedAt, long ownerProcessId, long ownerProcessStartedAt) {

        Entry withState(State nextState, long timestamp) {
            return new Entry(messageId, nextState, timestamp, ownerProcessId, ownerProcessStartedAt);
        }
    }
}
