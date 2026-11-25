package com.github.claudecodegui.handler;

import com.github.claudecodegui.util.ClaudeConfigDir;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.ApplicationInfo;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.UUID;

/**
 * Keeps the usage statistics server pointed at the configured Claude config directory.
 *
 * <p>tokentracker adds every path in {@code scanRoots.claude} of
 * {@code ~/.tokentracker/tracker/config.json} to the roots it scans, and re-reads that file on every
 * sync, so a running server (including one started by another client) picks a change up without a
 * restart. The plugin only ever adds or removes the single entry it manages: it remembers what it
 * added, leaves entries the user wrote alone, and preserves every other key in the file.
 */
final class TokenTrackerScanRoots {

    private static final Logger LOG = Logger.getInstance(TokenTrackerScanRoots.class);

    private static final String MARKER_ENTRY_FIELD = "claudeEntry";

    private static final Object LOCK = new Object();

    private static final Duration TRACKER_LOCK_WAIT = Duration.ofSeconds(2);

    private TokenTrackerScanRoots() {
    }

    /** Outcome of {@link #apply}: the updated config, the entry now tracked, and whether anything changed. */
    record Result(JsonObject config, String trackedEntry, boolean changed) {
    }

    /** Syncs the config file with the active Claude config directory; never throws. */
    static void syncFromSettings() {
        try {
            synchronized (LOCK) {
                Path override = ClaudeConfigDir.override();
                Path marker = markerFile(ApplicationInfo.getInstance().getBuild().getProductCode());
                String tracked = readMarker(marker);
                String trackedAfter = sync(configFile(), override == null ? null : override.toString(), tracked);
                if (!Objects.equals(tracked, trackedAfter)) {
                    writeMarker(marker, trackedAfter);
                }
            }
        } catch (Exception e) {
            LOG.warn("[TokenTrackerScanRoots] Could not update tokentracker scanRoots: " + e.getMessage());
        }
    }

    /**
     * Records the entry this plugin added, so only that entry is ever removed. It lives in a file the plugin
     * owns and is written immediately: IDE settings are flushed lazily, and losing the marker would leave an
     * entry in tokentracker's config that nothing owns. There is one file per IDE product because the setting
     * is stored per IDE: an IDE without the setting must not remove the entry another IDE added.
     */
    static Path markerFile(String productCode) {
        return Paths.get(PlatformUtils.getHomeDirectory(), ".codemoss", "tokentracker-scanroots-" + productCode + ".json");
    }

    /** The tracked entry, or null when there is none or the file cannot be read. */
    static String readMarker(Path file) {
        try {
            if (!Files.isRegularFile(file)) {
                return null;
            }
            JsonElement parsed = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8));
            if (!parsed.isJsonObject()) {
                return null;
            }
            JsonElement entry = parsed.getAsJsonObject().get(MARKER_ENTRY_FIELD);
            return entry != null && entry.isJsonPrimitive() && entry.getAsJsonPrimitive().isString()
                    && !entry.getAsString().isBlank() ? entry.getAsString() : null;
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    /** Stores the tracked entry; a null entry removes the marker. */
    static void writeMarker(Path file, String entry) throws IOException {
        if (entry == null) {
            Files.deleteIfExists(file);
            return;
        }
        JsonObject marker = new JsonObject();
        marker.addProperty(MARKER_ENTRY_FIELD, entry);
        writeAtomically(file, marker.toString());
    }

    static Path configFile() {
        return Paths.get(PlatformUtils.getHomeDirectory(), ".tokentracker", "tracker", "config.json");
    }

    /**
     * Reads {@code configFile}, applies the change and writes it back when something changed.
     *
     * @return the entry the plugin now tracks as its own (null when it added none)
     */
    static String sync(Path configFile, String desired, String previouslyAdded) throws IOException {
        return sync(configFile, desired, previouslyAdded, TRACKER_LOCK_WAIT);
    }

    static String sync(Path configFile, String desired, String previouslyAdded, Duration lockWait) throws IOException {
        if (!Files.isDirectory(configFile.getParent())) {
            // tokentracker has never run here, so nothing else can be writing the file.
            return syncUnlocked(configFile, desired, previouslyAdded);
        }
        Path lock = configFile.resolveSibling(configFile.getFileName() + ".lock");
        Path heartbeat = acquireTrackerLock(lock, UUID.randomUUID().toString(), lockWait);
        try {
            return syncUnlocked(configFile, desired, previouslyAdded);
        } finally {
            Files.deleteIfExists(heartbeat);
            Files.deleteIfExists(lock);
        }
    }

    /**
     * Takes the lease tokentracker itself uses for config.json (openLock in its src/lib/fs.js): an owner file
     * created exclusively with pid and token, plus a heartbeat file named after the token. A live pid with a
     * fresh heartbeat makes tokentracker wait. Returns the heartbeat file.
     */
    private static Path acquireTrackerLock(Path lock, String token, Duration wait) throws IOException {
        JsonObject owner = new JsonObject();
        owner.addProperty("pid", ProcessHandle.current().pid());
        owner.addProperty("token", token);
        owner.addProperty("createdAt", Instant.now().toString());
        long deadline = System.nanoTime() + wait.toNanos();
        while (true) {
            try {
                Files.writeString(lock, owner + "\n", StandardCharsets.UTF_8,
                        StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
                break;
            } catch (FileAlreadyExistsException busy) {
                // shortcut: a stale lease is left for tokentracker to reclaim; the next sync retries.
                if (System.nanoTime() >= deadline) {
                    throw new IOException("tokentracker is updating " + lock.getFileName() + ", try again later");
                }
                pause();
            }
        }
        Path heartbeat = lock.resolveSibling(lock.getFileName() + ".heartbeat." + sha256Hex(token));
        try {
            Files.writeString(heartbeat, token + "\n", StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
        } catch (IOException e) {
            Files.deleteIfExists(lock);
            throw e;
        }
        return heartbeat;
    }

    private static void pause() throws IOException {
        try {
            Thread.sleep(25);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted while waiting for the tokentracker config lock", e);
        }
    }

    private static String sha256Hex(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    private static String syncUnlocked(Path configFile, String desired, String previouslyAdded) throws IOException {
        JsonObject config = readConfig(configFile);
        if (config == null) {
            LOG.warn("[TokenTrackerScanRoots] Leaving an unreadable " + configFile + " untouched");
            return previouslyAdded;
        }
        Result result = apply(config, previouslyAdded, desired, PlatformUtils.isWindows());
        if (result.changed()) {
            writeAtomically(configFile, result.config().toString());
        }
        return result.trackedEntry();
    }

    /**
     * Pure merge. Removes the entry the plugin added earlier when it is no longer wanted, adds
     * {@code desired} when no equivalent entry exists, and leaves everything else as found.
     */
    static Result apply(JsonObject config, String previouslyAdded, String desired, boolean caseInsensitive) {
        JsonObject scanRoots = config.has("scanRoots") && config.get("scanRoots").isJsonObject()
                ? config.getAsJsonObject("scanRoots") : null;
        if (config.has("scanRoots") && scanRoots == null) {
            return new Result(config, previouslyAdded, false);
        }
        List<String> roots = new ArrayList<>();
        boolean claudeIsPresent = scanRoots != null && scanRoots.has("claude");
        if (claudeIsPresent && !readRoots(scanRoots.get("claude"), roots)) {
            return new Result(config, previouslyAdded, false);
        }
        List<String> before = new ArrayList<>(roots);

        if (previouslyAdded != null && (desired == null || !sameEntry(previouslyAdded, desired, caseInsensitive))) {
            roots.removeIf(root -> sameEntry(root, previouslyAdded, caseInsensitive));
        }

        String tracked = null;
        if (desired != null && !desired.isBlank()) {
            boolean present = roots.stream().anyMatch(root -> sameEntry(root, desired, caseInsensitive));
            if (!present) {
                roots.add(desired);
                tracked = desired;
            } else if (previouslyAdded != null && sameEntry(previouslyAdded, desired, caseInsensitive)) {
                tracked = previouslyAdded;
            }
        }

        if (roots.equals(before)) {
            return new Result(config, tracked, false);
        }

        JsonObject updated = JsonParser.parseString(config.toString()).getAsJsonObject();
        JsonObject updatedScanRoots = updated.has("scanRoots") ? updated.getAsJsonObject("scanRoots") : new JsonObject();
        if (roots.isEmpty()) {
            updatedScanRoots.remove("claude");
        } else {
            JsonArray array = new JsonArray();
            roots.forEach(array::add);
            updatedScanRoots.add("claude", array);
        }
        if (updatedScanRoots.size() == 0) {
            updated.remove("scanRoots");
        } else {
            updated.add("scanRoots", updatedScanRoots);
        }
        return new Result(updated, tracked, true);
    }

    /** Reads a string or an array of strings, as tokentracker does; false for any other shape. */
    private static boolean readRoots(JsonElement element, List<String> into) {
        if (element.isJsonPrimitive() && element.getAsJsonPrimitive().isString()) {
            into.add(element.getAsString());
            return true;
        }
        if (!element.isJsonArray()) {
            return false;
        }
        for (JsonElement item : element.getAsJsonArray()) {
            if (!item.isJsonPrimitive() || !item.getAsJsonPrimitive().isString()) {
                return false;
            }
            into.add(item.getAsString());
        }
        return true;
    }

    static boolean sameEntry(String a, String b, boolean caseInsensitive) {
        return normalize(a, caseInsensitive).equals(normalize(b, caseInsensitive));
    }

    private static String normalize(String value, boolean caseInsensitive) {
        String normalized = value.trim().replace('\\', '/');
        while (normalized.length() > 1 && normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return caseInsensitive ? normalized.toLowerCase(Locale.ROOT) : normalized;
    }

    /** Returns null for a file that exists but cannot be parsed as a JSON object, so it is never overwritten. */
    private static JsonObject readConfig(Path file) throws IOException {
        if (!Files.exists(file)) {
            return new JsonObject();
        }
        String text = Files.readString(file, StandardCharsets.UTF_8);
        if (!text.isEmpty() && text.charAt(0) == '﻿') {
            text = text.substring(1);
        }
        if (text.isBlank()) {
            return new JsonObject();
        }
        try {
            JsonElement parsed = JsonParser.parseString(text);
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static void writeAtomically(Path file, String content) throws IOException {
        Files.createDirectories(file.getParent());
        Path temp = Files.createTempFile(file.getParent(), "config", ".tmp");
        try {
            Files.writeString(temp, content + "\n", StandardCharsets.UTF_8);
            try {
                Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temp);
        }
    }
}
