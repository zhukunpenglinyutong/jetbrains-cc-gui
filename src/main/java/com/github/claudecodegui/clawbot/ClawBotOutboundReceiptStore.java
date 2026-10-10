package com.github.claudecodegui.clawbot;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/** Persists redacted outbound delivery outcomes without retaining message content or recipients. */
final class ClawBotOutboundReceiptStore {

    private static final String FILE_NAME = "outbound-receipts.json";
    private static final int MAX_RECEIPT_COUNT = 256;
    private static final long MAX_FILE_SIZE = 256L * 1024L;

    private final Path stateFile;
    private final Map<String, Receipt> receipts = new LinkedHashMap<>();
    private boolean loaded;
    private boolean reconcilePending = true;

    synchronized void reload() throws IOException {
        receipts.clear();
        loaded = false;
        loadIfNeeded();
    }

    synchronized StatusSnapshot readOnlyStatus() {
        ClawBotOutboundReceiptStore reader = new ClawBotOutboundReceiptStore(stateFile.getParent());
        reader.reconcilePending = false;
        return reader.status();
    }

    ClawBotOutboundReceiptStore(Path runtimeDirectory) {
        stateFile = Objects.requireNonNull(runtimeDirectory, "runtimeDirectory")
                .toAbsolutePath().normalize().resolve(FILE_NAME);
    }

    synchronized void begin(String clientId, long timestamp) throws IOException {
        loadIfNeeded();
        requireClientId(clientId);
        if (timestamp < 0L) {
            throw new IOException("CLAWBOT_OUTBOX_TIMESTAMP_INVALID");
        }
        Map<String, Receipt> previous = new LinkedHashMap<>(receipts);
        Receipt receipt = new Receipt(clientId, "PENDING", timestamp, timestamp, null);
        receipts.put(clientId, receipt);
        try {
            trim();
            save();
        } catch (IOException error) {
            receipts.clear();
            receipts.putAll(previous);
            throw error;
        }
    }

    synchronized void complete(String clientId, String status, String errorCode, long timestamp) throws IOException {
        loadIfNeeded();
        Receipt current = receipts.get(clientId);
        if (current == null || !List.of("SENT", "FAILED", "UNKNOWN").contains(status)
                || timestamp < current.createdAt() || (errorCode != null && !isSafeErrorCode(errorCode))) {
            throw new IOException("CLAWBOT_OUTBOX_RECEIPT_INVALID");
        }
        Map<String, Receipt> previous = new LinkedHashMap<>(receipts);
        receipts.put(clientId, new Receipt(clientId, status, current.createdAt(), timestamp, errorCode));
        try {
            save();
        } catch (IOException error) {
            receipts.clear();
            receipts.putAll(previous);
            throw error;
        }
    }

    synchronized StatusSnapshot status() {
        try {
            loadIfNeeded();
            int pending = 0;
            int sent = 0;
            int failed = 0;
            int unknown = 0;
            Receipt latest = null;
            for (Receipt receipt : receipts.values()) {
                switch (receipt.status()) {
                    case "PENDING":
                        pending++;
                        break;
                    case "SENT":
                        sent++;
                        break;
                    case "FAILED":
                        failed++;
                        break;
                    case "UNKNOWN":
                        unknown++;
                        break;
                    default:
                        throw new IllegalStateException("Invalid outbox state");
                }
                if (latest == null || receipt.updatedAt() > latest.updatedAt()) {
                    latest = receipt;
                }
            }
            return new StatusSnapshot(true, pending, sent, unknown, failed,
                    latest == null ? "" : latest.status(), latest == null ? "" : nullToEmpty(latest.errorCode()));
        } catch (IOException | RuntimeException error) {
            return new StatusSnapshot(false, 0, 0, 0, 0, "", "CLAWBOT_OUTBOX_STORE_UNAVAILABLE");
        }
    }

    synchronized String statusOf(String clientId) {
        try {
            loadIfNeeded();
            Receipt receipt = receipts.get(clientId);
            return receipt == null ? "" : receipt.status();
        } catch (IOException | RuntimeException error) {
            return "";
        }
    }

    synchronized List<Receipt> recent() throws IOException {
        loadIfNeeded();
        return receipts.values().stream().sorted(java.util.Comparator.comparingLong(Receipt::updatedAt).reversed()).toList();
    }

    synchronized void clear() throws IOException {
        if (Files.exists(stateFile, LinkOption.NOFOLLOW_LINKS)
                && !Files.isRegularFile(stateFile, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("CLAWBOT_OUTBOX_STORE_INVALID");
        }
        Files.deleteIfExists(stateFile);
        receipts.clear();
        loaded = true;
    }

    private void loadIfNeeded() throws IOException {
        if (loaded) {
            return;
        }
        Map<String, Receipt> loadedReceipts = new LinkedHashMap<>();
        if (Files.exists(stateFile, LinkOption.NOFOLLOW_LINKS)) {
            if (!Files.isRegularFile(stateFile, LinkOption.NOFOLLOW_LINKS)
                    || Files.size(stateFile) > MAX_FILE_SIZE) {
                throw new IOException("CLAWBOT_OUTBOX_STORE_INVALID");
            }
            try {
                JsonElement parsed = JsonParser.parseString(Files.readString(stateFile, StandardCharsets.UTF_8));
                if (!parsed.isJsonArray() || parsed.getAsJsonArray().size() > MAX_RECEIPT_COUNT) {
                    throw new IOException("CLAWBOT_OUTBOX_STORE_INVALID");
                }
                for (JsonElement element : parsed.getAsJsonArray()) {
                    Receipt receipt = readReceipt(element);
                    if (loadedReceipts.put(receipt.clientId(), receipt) != null) {
                        throw new IOException("CLAWBOT_OUTBOX_STORE_INVALID");
                    }
                }
            } catch (com.google.gson.JsonParseException | IllegalStateException error) {
                throw new IOException("CLAWBOT_OUTBOX_STORE_INVALID", error);
            }
        }
        receipts.putAll(loadedReceipts);
        long now = System.currentTimeMillis();
        boolean changed = false;
        for (Map.Entry<String, Receipt> entry : receipts.entrySet()) {
            Receipt receipt = entry.getValue();
            if (reconcilePending && "PENDING".equals(receipt.status())) {
                entry.setValue(new Receipt(receipt.clientId(), "UNKNOWN", receipt.createdAt(),
                        Math.max(now, receipt.updatedAt()), "CLAWBOT_GATEWAY_RESTARTED"));
                changed = true;
            }
        }
        if (changed) {
            try {
                save();
            } catch (IOException error) {
                receipts.clear();
                throw error;
            }
        }
        loaded = true;
    }

    private void save() throws IOException {
        JsonArray payload = new JsonArray();
        for (Receipt receipt : receipts.values()) {
            JsonObject entry = new JsonObject();
            entry.addProperty("clientId", receipt.clientId());
            entry.addProperty("status", receipt.status());
            entry.addProperty("createdAt", receipt.createdAt());
            entry.addProperty("updatedAt", receipt.updatedAt());
            if (receipt.errorCode() == null) {
                entry.add("errorCode", com.google.gson.JsonNull.INSTANCE);
            } else {
                entry.addProperty("errorCode", receipt.errorCode());
            }
            payload.add(entry);
        }
        Files.createDirectories(stateFile.getParent());
        Path temporary = Files.createTempFile(stateFile.getParent(), "outbound-receipts-", ".tmp");
        try {
            Files.writeString(temporary, payload.toString(), StandardCharsets.UTF_8);
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

    private static Receipt readReceipt(JsonElement element) throws IOException {
        if (element == null || !element.isJsonObject()) {
            throw new IOException("CLAWBOT_OUTBOX_STORE_INVALID");
        }
        JsonObject object = element.getAsJsonObject();
        String clientId = readString(object, "clientId", 64);
        requireClientId(clientId);
        String status = readString(object, "status", 16);
        if (!List.of("PENDING", "SENT", "FAILED", "UNKNOWN").contains(status)) {
            throw new IOException("CLAWBOT_OUTBOX_STORE_INVALID");
        }
        long createdAt = readTimestamp(object, "createdAt");
        long updatedAt = readTimestamp(object, "updatedAt");
        if (updatedAt < createdAt) {
            throw new IOException("CLAWBOT_OUTBOX_STORE_INVALID");
        }
        JsonElement errorValue = object.get("errorCode");
        String errorCode = errorValue == null || errorValue.isJsonNull()
                ? null : readString(object, "errorCode", 128);
        if (errorCode != null && !isSafeErrorCode(errorCode)) {
            throw new IOException("CLAWBOT_OUTBOX_STORE_INVALID");
        }
        return new Receipt(clientId, status, createdAt, updatedAt, errorCode);
    }

    private static String readString(JsonObject object, String name, int maxLength) throws IOException {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new IOException("CLAWBOT_OUTBOX_STORE_INVALID");
        }
        String text = value.getAsString();
        if (text.isBlank() || text.length() > maxLength || text.chars().anyMatch(Character::isISOControl)) {
            throw new IOException("CLAWBOT_OUTBOX_STORE_INVALID");
        }
        return text;
    }

    private static long readTimestamp(JsonObject object, String name) throws IOException {
        try {
            long value = object.get(name).getAsLong();
            if (value < 0L) {
                throw new NumberFormatException("negative");
            }
            return value;
        } catch (RuntimeException error) {
            throw new IOException("CLAWBOT_OUTBOX_STORE_INVALID", error);
        }
    }

    private static void requireClientId(String clientId) throws IOException {
        try {
            UUID.fromString(clientId);
        } catch (IllegalArgumentException error) {
            throw new IOException("CLAWBOT_OUTBOX_CLIENT_ID_INVALID", error);
        }
    }

    private static boolean isSafeErrorCode(String errorCode) {
        return errorCode != null && !errorCode.isBlank() && errorCode.length() <= 128
                && errorCode.chars().allMatch(character -> (character >= 'A' && character <= 'Z')
                || (character >= '0' && character <= '9') || character == '_');
    }

    private static void trim(Map<String, Receipt> receipts) throws IOException {
        while (receipts.size() > MAX_RECEIPT_COUNT) {
            boolean removed = false;
            var iterator = receipts.entrySet().iterator();
            while (iterator.hasNext()) {
                if (!"PENDING".equals(iterator.next().getValue().status())) {
                    iterator.remove();
                    removed = true;
                    break;
                }
            }
            if (!removed) {
                throw new IOException("CLAWBOT_OUTBOX_FULL");
            }
        }
    }

    private void trim() throws IOException {
        trim(receipts);
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    record Receipt(String clientId, String status, long createdAt, long updatedAt, String errorCode) {
    }

    record StatusSnapshot(boolean available, int pendingCount, int sentCount, int unknownCount,
                          int failedCount, String latestStatus, String latestErrorCode) {
    }
}
