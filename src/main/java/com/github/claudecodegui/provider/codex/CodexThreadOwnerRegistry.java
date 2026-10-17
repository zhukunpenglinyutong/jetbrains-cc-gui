package com.github.claudecodegui.provider.codex;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Coordinates native Codex thread writers across bridge instances in one IDE process.
 *
 * <p>The native app-server writer lock protects the on-disk rollout, while this
 * registry prevents a second chat window from accidentally becoming the logical
 * owner before it reaches that lock. Read-only viewers do not claim a lease.</p>
 */
public final class CodexThreadOwnerRegistry {

    private static final Map<String, Lease> LEASES = new ConcurrentHashMap<>();
    private static final Map<String, String> ROOTS = new ConcurrentHashMap<>();

    private CodexThreadOwnerRegistry() {
    }

    /**
     * Claim or renew a writable lease for a thread.
     *
     * @param scope normalized Codex home/runtime scope
     * @param threadId native thread id
     * @param ownerId bridge owner id
     * @return claim result
     */
    public static ClaimResult claim(String scope, String threadId, String ownerId) {
        if (threadId == null || threadId.trim().isEmpty()
                || ownerId == null || ownerId.trim().isEmpty()) {
            return ClaimResult.invalid();
        }
        String key = key(scope, threadId);
        Lease candidate = new Lease(ownerId, 1);
        Lease existing = LEASES.compute(key, (ignored, current) -> {
            if (current == null || current.ownerId.equals(ownerId)) {
                return current == null ? candidate : new Lease(ownerId, current.count + 1);
            }
            return current;
        });
        if (existing.ownerId.equals(ownerId)) {
            return ClaimResult.acquired(existing.count, ownerId);
        }
        return ClaimResult.conflict(existing.ownerId);
    }

    /**
     * Claim a root and descendant as one logical writer lease.
     *
     * @param scope normalized Codex home/runtime scope
     * @param rootThreadId root thread id
     * @param threadId root or descendant thread id
     * @param ownerId bridge owner id
     * @return claim result for the requested thread
     */
    public static ClaimResult claimRelation(
            String scope,
            String rootThreadId,
            String threadId,
            String ownerId
    ) {
        ClaimResult root = claim(scope, rootThreadId, ownerId);
        if (!root.acquired()) {
            return root;
        }
        if (rootThreadId == null || rootThreadId.equals(threadId)) {
            return root;
        }
        ClaimResult child = claim(scope, threadId, ownerId);
        if (child.acquired()) {
            ROOTS.put(key(scope, threadId), key(scope, rootThreadId));
        }
        if (!child.acquired()) {
            release(scope, rootThreadId, ownerId);
        }
        return child;
    }

    /**
     * Release one lease owned by the supplied bridge.
     *
     * @param scope normalized Codex home/runtime scope
     * @param threadId native thread id
     * @param ownerId bridge owner id
     */
    public static void release(String scope, String threadId, String ownerId) {
        if (threadId == null || ownerId == null) {
            return;
        }
        String key = key(scope, threadId);
        LEASES.computeIfPresent(key, (ignored, current) -> {
            if (!current.ownerId.equals(ownerId)) {
                return current;
            }
            return current.count <= 1 ? null : new Lease(ownerId, current.count - 1);
        });
    }

    /**
     * Release every lease for one thread owned by a bridge.
     *
     * @param scope normalized Codex home/runtime scope
     * @param threadId native thread id
     * @param ownerId bridge owner id
     */
    public static void releaseAll(String scope, String threadId, String ownerId) {
        if (threadId == null || ownerId == null) {
            return;
        }
        String key = key(scope, threadId);
        LEASES.computeIfPresent(key, (ignored, current) ->
                current.ownerId.equals(ownerId) ? null : current);
    }

    /**
     * Release every root and descendant lease belonging to an owner.
     *
     * @param ownerId bridge owner id
     */
    public static void releaseOwner(String ownerId) {
        if (ownerId == null) {
            return;
        }
        LEASES.entrySet().removeIf(entry -> entry.getValue().ownerId.equals(ownerId));
        ROOTS.keySet().removeIf(thread -> !LEASES.containsKey(thread));
    }

    /** Release a root and its known descendants after their native writer drains. */
    public static void releaseRelation(String scope, String rootThreadId, String ownerId) {
        String rootKey = key(scope, rootThreadId);
        LEASES.entrySet().removeIf(entry -> entry.getValue().ownerId.equals(ownerId)
                && (entry.getKey().equals(rootKey) || rootKey.equals(ROOTS.get(entry.getKey()))));
        ROOTS.keySet().removeIf(thread -> !LEASES.containsKey(thread));
    }

    /**
     * Return the current owner for a scoped thread.
     *
     * @param scope normalized Codex home/runtime scope
     * @param threadId native thread id
     * @return owner id, or null when unclaimed
     */
    public static String ownerOf(String scope, String threadId) {
        Lease lease = LEASES.get(key(scope, threadId));
        return lease == null ? null : lease.ownerId;
    }

    private static String key(String scope, String threadId) {
        return String.valueOf(scope) + "\u0000" + threadId;
    }

    private record Lease(String ownerId, int count) {
    }

    /** Result of a lease claim. */
    public record ClaimResult(boolean acquired, boolean valid, int leaseCount, String ownerId) {
        static ClaimResult acquired(int count, String ownerId) {
            return new ClaimResult(true, true, count, ownerId);
        }

        static ClaimResult conflict(String ownerId) {
            return new ClaimResult(false, true, 0, ownerId);
        }

        static ClaimResult invalid() {
            return new ClaimResult(false, false, 0, null);
        }
    }
}
