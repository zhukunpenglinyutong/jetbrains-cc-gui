package com.github.claudecodegui.provider.grok;

import com.github.claudecodegui.bridge.NodeDetector;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Append-only ledger of per-turn Grok ACP usage observed by the plugin.
 * Source of truth for token totals in Usage Statistics (history files lack tokens).
 * Stored at {@code ~/.codemoss/grok-usage-ledger.jsonl}.
 */
public final class GrokUsageLedger {

    private static final Logger LOG = Logger.getInstance(GrokUsageLedger.class);
    private static final Gson GSON = new Gson();

    private final Path ledgerPath;
    private final ReentrantLock lock = new ReentrantLock();

    public GrokUsageLedger() {
        this(Paths.get(NodeDetector.resolveHomeForFileOps(), ".codemoss", "grok-usage-ledger.jsonl"));
    }

    GrokUsageLedger(Path ledgerPath) {
        this.ledgerPath = ledgerPath;
    }

    public static final class Entry {
        public String sessionId;
        public String model;
        public String cwd;
        public long timestamp;
        public long inputTokens;
        public long outputTokens;
        public long totalTokens;
    }

    /** Aggregated totals for one session (sum of recorded turns). */
    public static final class SessionTotals {
        public long inputTokens;
        public long outputTokens;
        public long totalTokens;
        public int turnCount;
        public long lastTimestamp;
        public String model;
        public String cwd;
    }

    /**
     * Record one ACP usage snapshot for a session turn (best-effort, never throws).
     */
    public void record(String sessionId, String model, String cwd, JsonObject usage) {
        if (sessionId == null || sessionId.isBlank() || usage == null) {
            return;
        }
        // Prefer snake_case (canonical after normalize); camelCase remains fallback.
        JsonObject u = GrokContextUsageBuilder.normalizeUsageToSnakeCase(usage);
        if (u == null) {
            u = usage;
        }
        long input = firstLong(u, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens");
        long output = firstLong(u, "output_tokens", "outputTokens", "completion_tokens", "completionTokens");
        long thought = firstLong(u, "thought_tokens", "thoughtTokens");
        long total = firstLong(u, "total_tokens", "totalTokens");
        if (total <= 0 && (input > 0 || output > 0 || thought > 0)) {
            total = input + output + thought;
        }
        if (input <= 0 && output <= 0 && total <= 0) {
            return;
        }

        Entry entry = new Entry();
        entry.sessionId = sessionId.trim();
        entry.model = model != null ? model : "";
        entry.cwd = cwd != null ? cwd : "";
        entry.timestamp = System.currentTimeMillis();
        entry.inputTokens = Math.max(0, input);
        entry.outputTokens = Math.max(0, output);
        entry.totalTokens = Math.max(0, total);

        lock.lock();
        try {
            Path parent = ledgerPath.getParent();
            if (parent != null) {
                Files.createDirectories(parent);
            }
            try (BufferedWriter w = Files.newBufferedWriter(
                    ledgerPath,
                    StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE,
                    StandardOpenOption.APPEND)) {
                w.write(GSON.toJson(entry));
                w.newLine();
            }
        } catch (IOException e) {
            LOG.warn("[GrokUsageLedger] failed to append: " + e.getMessage());
        } finally {
            lock.unlock();
        }
    }

    public Map<String, SessionTotals> aggregateBySession() {
        Map<String, SessionTotals> map = new HashMap<>();
        lock.lock();
        try {
            if (!Files.isRegularFile(ledgerPath)) {
                return map;
            }
            try (BufferedReader r = Files.newBufferedReader(ledgerPath, StandardCharsets.UTF_8)) {
                String line;
                while ((line = r.readLine()) != null) {
                    if (line.isBlank()) {
                        continue;
                    }
                    try {
                        Entry e = GSON.fromJson(line, Entry.class);
                        if (e == null || e.sessionId == null || e.sessionId.isBlank()) {
                            continue;
                        }
                        SessionTotals t = map.computeIfAbsent(e.sessionId, k -> new SessionTotals());
                        // Prefer explicit in/out as turn deltas; pure total_tokens is often
                        // cumulative context size — take max so mid-turn [USAGE] does not inflate.
                        if (e.inputTokens > 0 || e.outputTokens > 0) {
                            t.inputTokens += Math.max(0, e.inputTokens);
                            t.outputTokens += Math.max(0, e.outputTokens);
                            long delta = e.totalTokens > 0
                                    ? e.totalTokens
                                    : (e.inputTokens + e.outputTokens);
                            t.totalTokens += Math.max(0, delta);
                        } else if (e.totalTokens > t.totalTokens) {
                            t.totalTokens = e.totalTokens;
                        }
                        t.turnCount++;
                        if (e.timestamp > t.lastTimestamp) {
                            t.lastTimestamp = e.timestamp;
                        }
                        if (e.model != null && !e.model.isBlank()) {
                            t.model = e.model;
                        }
                        if (e.cwd != null && !e.cwd.isBlank()) {
                            t.cwd = e.cwd;
                        }
                    } catch (Exception ignored) {
                        // skip bad line
                    }
                }
            }
        } catch (IOException e) {
            LOG.warn("[GrokUsageLedger] failed to read: " + e.getMessage());
        } finally {
            lock.unlock();
        }
        return map;
    }

    /** Package-visible for tests. */
    List<Entry> readAllEntriesForTest() {
        List<Entry> out = new ArrayList<>();
        if (!Files.isRegularFile(ledgerPath)) {
            return out;
        }
        try (BufferedReader r = Files.newBufferedReader(ledgerPath, StandardCharsets.UTF_8)) {
            String line;
            while ((line = r.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }
                try {
                    Entry e = GSON.fromJson(line, Entry.class);
                    if (e != null) {
                        out.add(e);
                    }
                } catch (Exception ignored) {
                }
            }
        } catch (IOException ignored) {
        }
        return out;
    }

    private static long readLong(JsonObject o, String key) {
        if (o == null || !o.has(key) || o.get(key).isJsonNull()) {
            return 0;
        }
        try {
            return Math.max(0, o.get(key).getAsLong());
        } catch (Exception e) {
            return 0;
        }
    }

    /** First positive long among keys (ACP camelCase + OpenAI snake_case). */
    private static long firstLong(JsonObject o, String... keys) {
        if (o == null || keys == null) {
            return 0;
        }
        for (String key : keys) {
            long n = readLong(o, key);
            if (n > 0) {
                return n;
            }
        }
        return 0;
    }
}
