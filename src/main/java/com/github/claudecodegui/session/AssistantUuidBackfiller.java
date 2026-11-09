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
import java.util.concurrent.atomic.AtomicInteger;

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

    /**
     * Only Claude turns backfill: the resolver queries the Claude CLI's session
     * JSONL, and only that transcript carries the row uuids it matches against.
     * An exclusion list (codex + the CLI bridge ids) silently grew stale when
     * the independent Grok/ZCode SDK providers landed — their uuid-less replies
     * would each trigger three Claude queries plus retry delays — so gate
     * positively on the one provider this resolver serves. Skips turns that
     * left nothing to resolve; else retries on the backfill executor.
     */
    CompletableFuture<Void> syncAfterSend() {
        if (!"claude".equals(state.getProvider())) {
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
                    // Row cursor shared by every message of this scan: rows and
                    // messages are both oldest first, so a match may only move
                    // forward. See findRowUuidByText.
                    AtomicInteger rowCursor = new AtomicInteger();
                    for (ClaudeSession.Message localMsg : locked) {
                        String matchedUuid = findRowUuidByText(rows, localMsg.content, usedUuids, rowCursor);
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
     * Find the transcript row uuid for one streamed reply, preserving row/reply
     * order across exact and whitespace-insensitive matching.
     *
     * <p>Messages and rows are both oldest first (transcripts are append-only),
     * and {@code cursor} carries the next unconsumed row index across the whole
     * scan. Each message claims the earliest row from the cursor whose text
     * equals the reply once whitespace is stripped. One order-preserving
     * predicate replaces the previous exact-first-then-normalized full-table
     * passes per message: those let an older message's exact match consume a
     * newer row while the older, whitespace-differing row fell through to a
     * younger message — two replies "ab" against rows "a\nb" then "ab" both
     * received the other's uuid, anchoring each fork at the wrong turn.
     *
     * <p>When no single row matches, the auto-continuation fallback joins the
     * consecutive rows the CLI persists for one streamed reply continued past
     * an output-token limit. The uuid returned is the window's LAST row — the
     * one representing the reply's end, which is where a fork must cut.
     *
     * <p>Rows already consumed by a previous match are skipped via {@code
     * usedUuids} so duplicate texts cannot share one uuid. The transcript
     * reader joins a row's text blocks with {@code '\n'} ({@code
     * extractTextContent} in session-service.js) while the streamed accumulator
     * appends them back-to-back, so all comparisons ignore whitespace; every
     * exact match is therefore also a whitespace-insensitive one, and the
     * earliest such row is the right anchor.
     */
    private static String findRowUuidByText(JsonArray rows, String text, Set<String> usedUuids,
                                            AtomicInteger cursor) {
        if (text == null || text.isEmpty()) {
            return null;
        }
        String needle = stripWhitespace(text);
        if (needle.isEmpty()) {
            // Whitespace-only content can only bogus-match an empty row.
            return null;
        }
        for (int i = cursor.get(); i < rows.size(); i++) {
            JsonObject row = asTextRow(rows.get(i));
            if (row == null) {
                continue;
            }
            String uuid = row.get("uuid").getAsString();
            if (usedUuids.contains(uuid)) {
                continue;
            }
            if (needle.equals(stripWhitespace(row.get("text").getAsString()))) {
                usedUuids.add(uuid);
                cursor.set(i + 1);
                return uuid;
            }
        }
        StringBuilder joined = new StringBuilder();
        for (int i = cursor.get(); i < rows.size(); i++) {
            JsonObject row = asTextRow(rows.get(i));
            if (row == null) {
                continue;
            }
            String uuid = row.get("uuid").getAsString();
            if (usedUuids.contains(uuid)) {
                // The window may not span a row another reply already owns.
                break;
            }
            joined.append(stripWhitespace(row.get("text").getAsString()));
            if (needle.equals(joined.toString())) {
                usedUuids.add(uuid);
                cursor.set(i + 1);
                return uuid;
            }
            if (joined.length() > needle.length()) {
                break;
            }
        }
        return null;
    }

    /** A row carrying both a uuid and a text primitive, or null when it is not one. */
    private static JsonObject asTextRow(JsonElement element) {
        if (!element.isJsonObject()) {
            return null;
        }
        JsonObject row = element.getAsJsonObject();
        JsonElement uuidElement = row.get("uuid");
        JsonElement textElement = row.get("text");
        return uuidElement != null && uuidElement.isJsonPrimitive()
                && textElement != null && textElement.isJsonPrimitive()
                ? row
                : null;
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
