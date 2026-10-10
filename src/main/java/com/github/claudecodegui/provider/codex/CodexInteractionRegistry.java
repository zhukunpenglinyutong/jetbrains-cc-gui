package com.github.claudecodegui.provider.codex;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Tracks native reverse requests until the matching UI decision is written back.
 *
 * <p>RPC identity is kept separate from approval and item identity. A page
 * reload only changes the page token; it never resets a native deadline or
 * removes a pending interaction.</p>
 */
public final class CodexInteractionRegistry {

    private final Map<String, Entry> pending = new ConcurrentHashMap<>();
    private final Map<String, String> pageTokens = new ConcurrentHashMap<>();
    private final Map<String, Tombstone> resolvedTombstones = new ConcurrentHashMap<>();
    private final AtomicLong deliverySequence = new AtomicLong();

    /** Register a native reverse request. */
    public Entry register(
            JsonElement rpcId,
            String method,
            String channelId,
            String sessionEpoch,
            String runtimeGeneration,
            String rootThreadId,
            String threadId,
            String turnId,
            String itemId,
            JsonObject params,
            long deadlineAt
    ) {
        String interactionKey = key(rpcId, channelId, sessionEpoch, runtimeGeneration);
        Entry entry = new Entry(
                interactionKey, rpcId, method, channelId, sessionEpoch, runtimeGeneration,
                rootThreadId, threadId, turnId, itemId,
                params == null ? new JsonObject() : params.deepCopy(), deadlineAt,
                this.deliverySequence.incrementAndGet());
        this.pending.put(entry.interactionKey(), entry);
        this.pageTokens.put(entry.interactionKey(), UUID.randomUUID().toString());
        this.resolvedTombstones.remove(entry.interactionKey());
        return entry;
    }

    /** Return a pending request without consuming it. */
    public Entry get(JsonElement rpcId) {
        for (Entry entry : this.pending.values()) {
            if (same(entry.rpcId(), rpcId)) {
                return entry;
            }
        }
        return null;
    }

    /** Match a reverse request inside its channel and native runtime generation. */
    public Entry get(JsonElement rpcId, String channelId, String epoch, String generation) {
        for (Entry entry : this.pending.values()) {
            if (same(entry.rpcId(), rpcId) && same(entry.channelId(), channelId)
                    && same(entry.sessionEpoch(), epoch) && same(entry.runtimeGeneration(), generation)) {
                return entry;
            }
        }
        return null;
    }

    /** Return a pending request by its opaque runtime-scoped key. */
    public Entry get(String interactionKey) {
        return interactionKey == null ? null : this.pending.get(interactionKey);
    }

    /** Resolve a request once; late/duplicate decisions return false. */
    public boolean resolve(JsonElement rpcId) {
        Entry entry = get(rpcId);
        return entry != null && resolve(entry.interactionKey());
    }

    /** Resolve a request once by its opaque runtime-scoped key. */
    public boolean resolve(String interactionKey) {
        if (interactionKey == null) {
            return false;
        }
        Entry removed = this.pending.remove(interactionKey);
        String token = this.pageTokens.remove(interactionKey);
        if (removed != null) {
            this.resolvedTombstones.put(interactionKey, new Tombstone(
                    token, removed.deliverySequence(), System.currentTimeMillis()));
            if (this.resolvedTombstones.size() > 2048) {
                String oldestKey = this.resolvedTombstones.entrySet().stream()
                        .min(Map.Entry.comparingByValue(Comparator.comparingLong(Tombstone::resolvedAt)))
                        .map(Map.Entry::getKey)
                        .orElse(null);
                if (oldestKey != null) {
                    this.resolvedTombstones.remove(oldestKey);
                }
            }
        }
        return removed != null;
    }

    /** Remove every pending interaction owned by a runtime session. */
    public void clearSession(String channelId, String sessionEpoch) {
        this.pending.entrySet().removeIf(entry -> same(channelId, entry.getValue().channelId())
                && same(sessionEpoch, entry.getValue().sessionEpoch()));
        // Interaction keys are prefixed with channelId\0epoch\0 (see key()), so
        // orphaned tokens and tombstones are cleared for THIS session only —
        // tombstones of other channels still guard their close acknowledgements.
        String sessionPrefix = String.valueOf(channelId) + "\u0000" + String.valueOf(sessionEpoch) + "\u0000";
        this.pageTokens.keySet().removeIf(interactionKey -> !this.pending.containsKey(interactionKey)
                && interactionKey.startsWith(sessionPrefix));
        this.resolvedTombstones.keySet().removeIf(interactionKey -> !this.pending.containsKey(interactionKey)
                && interactionKey.startsWith(sessionPrefix));
    }

    /** Clear all entries during bridge disposal. */
    public void clear() {
        this.pending.clear();
        this.pageTokens.clear();
        this.resolvedTombstones.clear();
    }

    /** Issue a fresh page token for a pending interaction. */
    public String issuePageToken(String interactionKey) {
        if (interactionKey == null || !this.pending.containsKey(interactionKey)) {
            return null;
        }
        String token = UUID.randomUUID().toString();
        this.pageTokens.put(interactionKey, token);
        return token;
    }

    /** Return the current page token for a pending interaction. */
    public String pageToken(String interactionKey) {
        return interactionKey == null ? null : this.pageTokens.get(interactionKey);
    }

    /** Check whether a page token still addresses the current dialog instance. */
    public boolean matchesPageToken(String interactionKey, String token) {
        return token != null && token.equals(pageToken(interactionKey));
    }

    /** Record a page show/close acknowledgement for the current delivery. */
    public boolean acknowledge(String interactionKey, String token, long sequence, String phase) {
        Entry entry = get(interactionKey);
        if (entry != null) {
            return token != null && token.equals(pageToken(interactionKey))
                    && sequence >= entry.deliverySequence()
                    && ("show".equals(phase) || "close".equals(phase));
        }
        Tombstone tombstone = this.resolvedTombstones.get(interactionKey);
        return tombstone != null && token != null && token.equals(tombstone.dialogToken())
                && sequence >= tombstone.deliverySequence()
                && "close".equals(phase);
    }

    /** Return whether a resolved interaction is retained as a stale-response tombstone. */
    public boolean hasResolvedTombstone(String interactionKey) {
        return interactionKey != null && this.resolvedTombstones.containsKey(interactionKey);
    }

    /** Return pending interactions for a page replay in creation order. */
    public List<Entry> snapshot(String channelId) {
        List<Entry> entries = new ArrayList<>();
        for (Entry entry : this.pending.values()) {
            if (same(channelId, entry.channelId())) {
                entries.add(entry);
            }
        }
        entries.sort(Comparator.comparingLong(Entry::deliverySequence));
        return entries;
    }

    private static boolean same(String left, String right) {
        return left == null ? right == null : left.equals(right);
    }

    private static boolean same(JsonElement left, JsonElement right) {
        return left == null ? right == null : left.equals(right);
    }

    private static String key(
            JsonElement rpcId,
            String channelId,
            String sessionEpoch,
            String runtimeGeneration
    ) {
        return String.valueOf(channelId) + "\u0000"
                + String.valueOf(sessionEpoch) + "\u0000"
                + String.valueOf(runtimeGeneration) + "\u0000"
                + (rpcId == null ? "null" : rpcId.toString());
    }

    /** Immutable native interaction identity. */
    public record Entry(
            String interactionKey,
            JsonElement rpcId,
            String method,
            String channelId,
            String sessionEpoch,
            String runtimeGeneration,
            String rootThreadId,
            String threadId,
            String turnId,
            String itemId,
            JsonObject params,
            long deadlineAt,
            long deliverySequence
    ) {
    }

    private record Tombstone(String dialogToken, long deliverySequence, long resolvedAt) {
    }
}
