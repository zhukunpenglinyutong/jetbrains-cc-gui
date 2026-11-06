package com.github.claudecodegui.session;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Backfills the transcript uuids of live-streamed assistant messages after a
 * turn ends. Streaming replies are synthesized from deltas by the bridge, so
 * their raw carries no uuid — and without one the chat cannot offer per-message
 * forks. The CLI assigns the row uuid when it appends the transcript, so after
 * the turn each uuid-less assistant message is resolved against the recent
 * transcript rows by text and stamped, mirroring the user-message sync that
 * powers rewind.
 */
class AssistantUuidBackfiller {

    private static final Logger LOG = Logger.getInstance(AssistantUuidBackfiller.class);
    private static final int MAX_UUID_SYNC_RETRIES = 3;
    /** Extra transcript rows fetched beyond the unresolved count, so rows filtered out of the chat view cannot starve a match. */
    private static final int UUID_SYNC_ROW_MARGIN = 5;

    /**
     * A dedicated daemon executor instead of ForkJoinPool.commonPool: one attempt
     * can block up to a 30s bridge timeout, three attempts with backoff can hold a
     * worker for ~90s, and commonPool starvation would stall unrelated parallel
     * streams. Single-threaded on purpose — backfills are rare and serialize
     * naturally.
     */
    private static final ExecutorService UUID_SYNC_EXECUTOR = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "claude-assistant-uuid-backfill");
        thread.setDaemon(true);
        return thread;
    });

    private final SessionState state;
    private final SessionMessageOrchestrator.SessionHistoryAccess historyAccess;
    private final SessionCallbackFacade callbackFacade;
    private final long retryDelayMs;

    AssistantUuidBackfiller(SessionState state,
                            SessionMessageOrchestrator.SessionHistoryAccess historyAccess,
                            SessionCallbackFacade callbackFacade,
                            long retryDelayMs) {
        this.state = state;
        this.historyAccess = historyAccess;
        this.callbackFacade = callbackFacade;
        this.retryDelayMs = retryDelayMs;
    }

    /** Skip non-Claude providers and turns that left nothing to resolve; else retry on the backfill executor. */
    CompletableFuture<Void> syncAfterSend() {
        String provider = state.getProvider();
        if ("codex".equals(provider) || SessionProviderRouter.isCliProvider(provider)) {
            return CompletableFuture.completedFuture(null);
        }
        if (findUnresolvedAssistantMessages().isEmpty()) {
            return CompletableFuture.completedFuture(null);
        }
        return CompletableFuture.runAsync(this::updateUuids, UUID_SYNC_EXECUTOR);
    }

    void updateUuids() {
        String sessionId = state.getSessionId();
        String cwd = state.getCwd();
        if (sessionId == null || sessionId.isEmpty()) {
            return;
        }

        for (int attempt = 1; attempt <= MAX_UUID_SYNC_RETRIES; attempt++) {
            List<ClaudeSession.Message> unresolved = findUnresolvedAssistantMessages();
            if (unresolved.isEmpty()) {
                return;
            }

            try {
                JsonArray rows = historyAccess.getRecentClaudeAssistantMessages(
                        sessionId, cwd, unresolved.size() + UUID_SYNC_ROW_MARGIN);
                if (rows == null) {
                    // Transcript tail still being written; retry after a beat.
                    if (attempt < MAX_UUID_SYNC_RETRIES) {
                        sleep(retryDelayMs(attempt));
                    }
                    continue;
                }

                int patchedCount = 0;
                int unresolvedAtScan = 0;
                List<String[]> pendingNotifications = new ArrayList<>();
                java.util.Set<String> usedUuids = new java.util.HashSet<>();
                synchronized (state.getMessageStateLock()) {
                    // The rows above belong to the session captured on entry. If the
                    // user switched sessions during the retries, this loop would stamp
                    // the new session's messages with the old session's uuids — a fork
                    // point that does not exist in the new transcript. Abandon instead.
                    if (!sessionId.equals(state.getSessionId())) {
                        return;
                    }
                    // Rows already claimed by an earlier stamp (user-message sync or a
                    // previous backfill run) must never match again: a duplicate reply
                    // text would otherwise steal the older row's uuid and fork from the
                    // wrong turn. UUIDs are CLI-global, so excluding every uuid already
                    // stamped on a live message is safe and costs one list scan.
                    for (ClaudeSession.Message msg : state.getMessagesReference()) {
                        if (msg.raw != null && msg.raw.has("uuid")
                                && msg.raw.get("uuid").isJsonPrimitive()) {
                            usedUuids.add(msg.raw.get("uuid").getAsString());
                        }
                    }
                    // Re-read under the lock: a concurrent append could have added
                    // messages after the lockless pre-check.
                    List<ClaudeSession.Message> locked = findUnresolvedAssistantMessages();
                    unresolvedAtScan = locked.size();
                    for (ClaudeSession.Message localMsg : locked) {
                        String matchedUuid = findRowUuidByText(rows, localMsg.content, usedUuids);
                        if (matchedUuid == null) {
                            continue;
                        }
                        if (localMsg.raw == null) {
                            localMsg.raw = new JsonObject();
                        }
                        localMsg.raw.addProperty("uuid", matchedUuid);
                        patchedCount++;
                        pendingNotifications.add(new String[]{
                                localMsg.content != null ? localMsg.content : "", matchedUuid});
                    }
                }
                if (patchedCount > 0) {
                    LOG.info("[Fork] Backfilled " + patchedCount + " streamed assistant message uuid(s)");
                    for (String[] notification : pendingNotifications) {
                        callbackFacade.notifyAssistantMessageUuidPatched(notification[0], notification[1]);
                    }
                }
                // Every message this round scanned is now stamped: return at once so
                // the shared backfill executor is not slept for an attempt that would
                // find no work. A partial patch must not end the sync while messages
                // stay unresolved — that would drop both the remaining retry budget
                // and the final diagnosis below — so it falls through to the retry.
                if (patchedCount > 0 && patchedCount == unresolvedAtScan) {
                    return;
                }
                if (attempt < MAX_UUID_SYNC_RETRIES) {
                    sleep(retryDelayMs(attempt));
                }
            } catch (Exception e) {
                LOG.warn("[Fork] Failed to backfill assistant message uuids (attempt "
                        + attempt + "): " + e.getMessage());
                if (attempt < MAX_UUID_SYNC_RETRIES) {
                    sleep(retryDelayMs(attempt));
                }
            }
        }

        // Every retry was spent without a match: surface it instead of silently
        // leaving those replies without a fork button, which is impossible to
        // diagnose from the UI alone.
        List<ClaudeSession.Message> remaining = findUnresolvedAssistantMessages();
        if (!remaining.isEmpty()) {
            LOG.warn("[Fork] " + remaining.size()
                    + " assistant message(s) still have no transcript uuid; first: "
                    + describeWithoutContent(remaining.get(0).content));
        }
    }

    /**
     * Backoff between backfill attempts.
     *
     * <p>The CLI appends the transcript row only after it flushes the turn, and each
     * attempt spawns a fresh bridge process to read the tail, so a flat short delay
     * spends the whole budget before the row exists. Doubling from the injected base
     * (250ms in production) gives 250ms + 500ms of waiting across the two gaps, which
     * is roughly 1.7s wall clock once the three bridge spawns are counted. Tests
     * inject 0, which collapses to no waiting.
     */
    private long retryDelayMs(int attempt) {
        return this.retryDelayMs * (1L << (attempt - 1));
    }

    /** Length and hash instead of the text itself: transcript content stays out of the IDE log. */
    private static String describeWithoutContent(String text) {
        if (text == null || text.isEmpty()) {
            return "(no text)";
        }
        return text.length() + " chars, hash " + Integer.toHexString(text.hashCode());
    }

    /**
     * Assistant messages still missing a transcript uuid, oldest first. Only
     * text-bearing ones are collected: the per-message fork button renders on
     * copyable (text) replies, so rows without text never need a uuid.
     */
    private List<ClaudeSession.Message> findUnresolvedAssistantMessages() {
        synchronized (state.getMessageStateLock()) {
            List<ClaudeSession.Message> messages = state.getMessagesReference();
            List<ClaudeSession.Message> unresolved = new ArrayList<>();
            for (ClaudeSession.Message msg : messages) {
                if (msg.type != ClaudeSession.Message.Type.ASSISTANT) {
                    continue;
                }
                if (msg.raw != null && msg.raw.has("uuid") && !msg.raw.get("uuid").isJsonNull()) {
                    continue;
                }
                if (msg.content == null || msg.content.isEmpty()) {
                    continue;
                }
                unresolved.add(msg);
            }
            return unresolved;
        }
    }

    /**
     * Find a recent assistant row whose joined text equals the local message's
     * streamed text. Rows already consumed by a previous match are skipped via
     * usedUuids so duplicate texts cannot share one uuid.
     *
     * <p>An exact match is attempted first, which keeps duplicate replies pairing
     * up in order. The transcript reader joins a row's text blocks with {@code '\n'}
     * ({@code extractTextContent} in session-service.js), while the streamed
     * accumulator appends them back-to-back, so a reply split across text /
     * thinking / tool blocks only matches once whitespace is ignored — that is
     * the second pass.
     */
    private static String findRowUuidByText(JsonArray rows, String text, Set<String> usedUuids) {
        if (text == null || text.isEmpty()) {
            return null;
        }
        String exact = findRowUuid(rows, text, usedUuids, false);
        return exact != null ? exact : findRowUuid(rows, text, usedUuids, true);
    }

    private static String findRowUuid(JsonArray rows, String text, Set<String> usedUuids,
                                      boolean ignoreWhitespace) {
        String needle = ignoreWhitespace ? stripWhitespace(text) : text;
        for (JsonElement element : rows) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject row = element.getAsJsonObject();
            JsonElement uuidElement = row.get("uuid");
            JsonElement textElement = row.get("text");
            if (uuidElement == null || !uuidElement.isJsonPrimitive()
                    || textElement == null || !textElement.isJsonPrimitive()) {
                continue;
            }
            String uuid = uuidElement.getAsString();
            if (usedUuids.contains(uuid)) {
                continue;
            }
            String candidate = textElement.getAsString();
            String haystack = ignoreWhitespace ? stripWhitespace(candidate) : candidate;
            if (needle.equals(haystack)) {
                usedUuids.add(uuid);
                return uuid;
            }
        }
        return null;
    }

    /** Drop every whitespace character so the two concatenation styles compare equal. */
    private static String stripWhitespace(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        StringBuilder stripped = null;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (Character.isWhitespace(c)) {
                if (stripped == null) {
                    stripped = new StringBuilder(value.length());
                    stripped.append(value, 0, i);
                }
            } else if (stripped != null) {
                stripped.append(c);
            }
        }
        return stripped == null ? value : stripped.toString();
    }

    private static void sleep(long delayMs) {
        if (delayMs <= 0) {
            return;
        }
        try {
            Thread.sleep(delayMs);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
