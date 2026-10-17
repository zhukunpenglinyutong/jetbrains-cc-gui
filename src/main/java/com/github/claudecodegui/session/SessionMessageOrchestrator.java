package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.SettingsHandler;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.provider.common.SessionHistoryIncompleteException;
import com.github.claudecodegui.provider.common.SessionHistoryNotFoundException;
import com.github.claudecodegui.util.TokenUsageUtils;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;

/**
 * Owns session-history loading and post-send message reconciliation.
 */
public class SessionMessageOrchestrator {

    private static final Logger LOG = Logger.getInstance(SessionMessageOrchestrator.class);
    private static final int MAX_UUID_SYNC_RETRIES = 3;

    public interface SessionHistoryAccess {
        List<JsonObject> getProviderSessionMessages(String provider, String sessionId, String cwd);

        JsonObject getLatestClaudeUserMessage(String sessionId, String cwd);

        /**
         * Load a page of Claude session history (turn-based pagination).
         * Returns null when the provider does not support pagination or the
         * query fails; the caller should fall back to getProviderSessionMessages.
         */
        default JsonObject getProviderSessionMessagesPage(String sessionId, String cwd, Integer beforeTurn, int limit) {
            return null;
        }
    }

    @FunctionalInterface
    public interface UsageDisplay {
        void show(int usedTokens, int maxTokens);
    }

    private final SessionState state;
    private final MessageParser messageParser;
    private final SessionCallbackFacade callbackFacade;
    private final SessionHistoryAccess historyAccess;
    private final UsageDisplay usageDisplay;
    private final long initialUuidSyncDelayMs;
    private final long uuidRetryDelayMs;

    // Claude history pagination state
    private volatile int claudeHistoryFromTurn = 0;
    private volatile int claudeHistoryTotalTurns = 0;
    private volatile boolean claudeHistoryHasMore = false;
    private volatile String claudeHistorySessionTitle = null;
    /**
     * Guard earlier-page commits against a transcript replaced while their read was in flight.
     * A plain long on purpose: every read and write happens inside
     * {@code synchronized (state.getMessageStateLock())}, so the message lock already
     * provides visibility and atomicity — do not read or write it outside that lock.
     */
    private long claudeHistoryVersion;

    public SessionMessageOrchestrator(
            Project project,
            SessionState state,
            MessageParser messageParser,
            SessionCallbackFacade callbackFacade,
            SessionHistoryAccess historyAccess
    ) {
        this(
                state,
                messageParser,
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                    if (project != null) {
                        ClaudeNotifier.setTokenUsage(project, usedTokens, maxTokens);
                    }
                    callbackFacade.notifyUsageUpdate(usedTokens, maxTokens);
                },
                100,
                50
        );
    }

    SessionMessageOrchestrator(
            SessionState state,
            MessageParser messageParser,
            SessionCallbackFacade callbackFacade,
            SessionHistoryAccess historyAccess,
            UsageDisplay usageDisplay,
            long initialUuidSyncDelayMs,
            long uuidRetryDelayMs
    ) {
        this.state = state;
        this.messageParser = messageParser;
        this.callbackFacade = callbackFacade;
        this.historyAccess = historyAccess;
        this.usageDisplay = usageDisplay;
        this.initialUuidSyncDelayMs = initialUuidSyncDelayMs;
        this.uuidRetryDelayMs = uuidRetryDelayMs;
    }

    public CompletableFuture<Void> syncUserMessageUuidsAfterSend() {
        String provider = state.getProvider();
        if ("codex".equals(provider)
                || SessionProviderRouter.isCliProvider(provider)
                || findLatestUnresolvedUserMessage() == null) {
            return CompletableFuture.completedFuture(null);
        }

        return CompletableFuture.runAsync(() -> {
            sleep(initialUuidSyncDelayMs);
            updateUserMessageUuids();
        });
    }

    void updateUserMessageUuids() {
        String sessionId = state.getSessionId();
        String cwd = state.getCwd();

        if (sessionId == null || sessionId.isEmpty()) {
            return;
        }

        if (findLatestUnresolvedUserMessage() == null) {
            return;
        }

        for (int attempt = 1; attempt <= MAX_UUID_SYNC_RETRIES; attempt++) {
            try {
                JsonObject latestClaudeUserMessage = historyAccess.getLatestClaudeUserMessage(sessionId, cwd);
                if (latestClaudeUserMessage == null) {
                    if (attempt < MAX_UUID_SYNC_RETRIES) {
                        sleep(uuidRetryDelayMs);
                        continue;
                    }
                    return;
                }

                String patchedContent = null;
                String patchedUuid = null;
                synchronized (state.getMessageStateLock()) {
                    // One lock window covers the patch and the read-back: a non-null
                    // return already guarantees the uuid was stamped.
                    ClaudeSession.Message matchedMessage = patchMatchingUserMessage(latestClaudeUserMessage);
                    if (matchedMessage != null) {
                        patchedContent = matchedMessage.content != null ? matchedMessage.content : "";
                        patchedUuid = matchedMessage.raw.get("uuid").getAsString();
                    }
                }
                if (patchedUuid != null) {
                    callbackFacade.notifyUserMessageUuidPatched(patchedContent, patchedUuid);
                    return;
                }

                if (attempt < MAX_UUID_SYNC_RETRIES) {
                    sleep(uuidRetryDelayMs);
                }
            } catch (Exception e) {
                LOG.warn("[Rewind] Failed to update user message UUIDs (attempt " + attempt + "): " + e.getMessage());
                if (attempt < MAX_UUID_SYNC_RETRIES) {
                    sleep(uuidRetryDelayMs);
                }
            }
        }
    }

    /** Load provider history without letting obsolete reads replace a newer transcript. */
    public CompletableFuture<Void> loadFromServer() {
        String requestedSessionId = state.getSessionId();
        if (requestedSessionId == null) {
            return CompletableFuture.completedFuture(null);
        }
        String requestedCwd = state.getCwd();
        String requestedProvider = state.getProvider();
        Object loadingToken = new Object();
        List<ClaudeSession.Message> messagesBeforeLoad;
        synchronized (state.getMessageStateLock()) {
            messagesBeforeLoad = state.getMessages();
            state.claimLoading(loadingToken);
            callbackFacade.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
        }

        return CompletableFuture.runAsync(() -> {
            try {
                LOG.info("Loading session from server: sessionId=" + requestedSessionId + ", cwd=" + requestedCwd);

                List<JsonObject> serverMessages;
                boolean pagedClaudeLoad;
                ClaudeHistoryLoad historyLoad = null;
                if ("claude".equals(requestedProvider)) {
                    historyLoad = this.loadClaudeSessionWithPagination(requestedSessionId, requestedCwd);
                    serverMessages = historyLoad.messages;
                    pagedClaudeLoad = historyLoad.paged;
                } else {
                    serverMessages = historyAccess.getProviderSessionMessages(
                            requestedProvider, requestedSessionId, requestedCwd);
                    pagedClaudeLoad = false;
                }
                if (serverMessages == null) {
                    throw new IllegalStateException("Session history provider returned no response");
                }

                LOG.debug("Received " + serverMessages.size() + " messages from server");
                List<ClaudeSession.Message> loadedMessages = new ArrayList<>(serverMessages.size());
                for (JsonObject msg : serverMessages) {
                    ClaudeSession.Message message = messageParser.parseServerMessage(msg);
                    if (message != null) {
                        loadedMessages.add(message);
                    }
                }

                List<ClaudeSession.Message> callbackMessages;
                // Measure the freshly parsed history before taking the state lock:
                // the list is thread-local to this load, so its structural walk must
                // not extend the lock window that streaming callbacks contend on.
                Set<String> loadedStructure = MessageStructure.structuralBlockKeys(loadedMessages);
                boolean keptOlderLivePrefix = false;
                synchronized (state.getMessageStateLock()) {
                    if (!ownsHistoryLoad(loadingToken, requestedSessionId, requestedCwd, requestedProvider)) {
                        LOG.info("Ignoring history result for a session that changed while loading");
                        return;
                    }
                    // Safety checks must see buffered stream deltas before replacement materializes them.
                    List<ClaudeSession.Message> currentMessages = this.state.getMessages();
                    // A new row added during this read belongs to newer live work.
                    // Metadata patches keep the same row identities and remain valid.
                    if (!currentMessages.equals(messagesBeforeLoad)) {
                        return;
                    }
                    // The anchor walk backs every Claude guard below; run it once per commit.
                    int alignedAnchorIndex = "claude".equals(requestedProvider)
                            ? lastAlignedHistoryIndex(loadedMessages, currentMessages) : -1;
                    // A full fallback can lag the writer just like a page; neither may erase live narrative.
                    if ("claude".equals(requestedProvider)
                            && !historyKeepsLiveNarrative(loadedMessages, currentMessages, alignedAnchorIndex)) {
                        LOG.warn("Ignoring history result that has not persisted the live narrative");
                        return;
                    }
                    // A page load only carries the newest turns, so a transcript that
                    // already holds more turns than one page is legitimately longer
                    // than what came back. Align the page to the live tail and keep
                    // the older live prefix instead of rejecting the reload — see
                    // mergeLoadedPageWithLivePrefix.
                    List<ClaudeSession.Message> mergedMessages = "codex".equals(requestedProvider)
                            ? CodexHistoryMerger.reconcile(loadedMessages, currentMessages) : pagedClaudeLoad
                            ? mergeLoadedPageWithLivePrefix(loadedMessages, currentMessages, alignedAnchorIndex)
                            : null;
                    if (mergedMessages != null) {
                        if (!"codex".equals(requestedProvider) && !MessageStructure.structuralBlockKeys(mergedMessages)
                                .containsAll(MessageStructure.structuralBlockKeys(currentMessages))) {
                            LOG.warn("Ignoring history page that would remove live structural blocks");
                            return;
                        }
                        keptOlderLivePrefix = pagedClaudeLoad && alignedAnchorIndex > 0;
                        loadedMessages = mergedMessages;
                    } else {
                        int liveHistoryBacked = countHistoryBackedMessages(currentMessages);
                        if (liveHistoryBacked > 0 && loadedMessages.size() < liveHistoryBacked) {
                            LOG.warn("Ignoring stale shorter history result: loaded="
                                    + loadedMessages.size() + ", live=" + liveHistoryBacked);
                            return;
                        }
                        if (!historyPreservesCurrentStructure(loadedStructure, currentMessages)) {
                            LOG.warn("Ignoring history result that would remove live structural blocks");
                            return;
                        }
                    }

                    // Replace only after the complete response has been parsed and all
                    // ownership checks pass. A failed or partial read must never clear
                    // the live list first and leave the UI with a shorter transcript.
                    this.state.replaceMessages(loadedMessages);
                    this.state.setError(null);
                    if (historyLoad != null) {
                        this.claudeHistoryVersion++;
                        // The cursor belongs to the accepted transcript. Rejected or obsolete
                        // reads must not move it past messages that are still on screen.
                        if (!keptOlderLivePrefix) {
                            this.claudeHistoryFromTurn = historyLoad.fromTurn;
                        }
                        this.claudeHistoryTotalTurns = historyLoad.totalTurns;
                        this.claudeHistoryHasMore = historyLoad.hasMore && this.claudeHistoryFromTurn > 0;
                        this.claudeHistorySessionTitle = historyLoad.sessionTitle;
                        // A full fallback retires the frontend's old cursor too, or scrolling
                        // would prepend already-loaded turns into the complete transcript.
                        this.callbackFacade.notifyClaudeHistoryPageInfo(
                                requestedSessionId,
                                this.claudeHistoryFromTurn,
                                this.claudeHistoryTotalTurns,
                                this.claudeHistoryHasMore,
                                historyLoad.cursorReset || !pagedClaudeLoad,
                                this.claudeHistorySessionTitle);
                    }
                    callbackMessages = this.state.getMessagesSnapshot();
                    this.restoreTokenUsage(serverMessages);
                    this.callbackFacade.notifyMessageUpdate(callbackMessages);
                }
            } catch (SessionHistoryNotFoundException e) {
                // A missing history file is an explicit stale-session signal, so unlike
                // the stale-result guards above it clears the live transcript.
                synchronized (state.getMessageStateLock()) {
                    if (!ownsHistoryLoad(loadingToken, requestedSessionId, requestedCwd, requestedProvider)) {
                        return;
                    }
                    this.retireMissingHistory();
                }
                LOG.warn("Session history is unavailable; cleared stale session ID: " + e.getMessage());
            } catch (SessionHistoryIncompleteException e) {
                synchronized (state.getMessageStateLock()) {
                    if (!ownsHistoryLoad(loadingToken, requestedSessionId, requestedCwd, requestedProvider)) {
                        return;
                    }
                    // An initial history open has no live transcript to keep. Let
                    // its caller offer a retry instead of reporting an empty success.
                    if (state.getMessagesReference().isEmpty()) {
                        throw new CompletionException(e);
                    }
                }
                LOG.info("Session history is still being written; keeping the live transcript: "
                        + e.getMessage());
            } catch (Exception e) {
                synchronized (state.getMessageStateLock()) {
                    if (!ownsHistoryLoad(loadingToken, requestedSessionId, requestedCwd, requestedProvider)) {
                        return;
                    }
                    state.setError(e.getMessage());
                }
                LOG.error("Error loading session: " + e.getMessage(), e);
                throw new CompletionException(e);
            } finally {
                synchronized (state.getMessageStateLock()) {
                    if (state.releaseLoading(loadingToken)) {
                        callbackFacade.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
                    }
                }
            }
        });
    }

    /**
     * A Claude history read and whether it came back as a page.
     *
     * <p>Only a page needs the live prefix merged back in: it carries the newest
     * turns alone, while the fallback read is the whole transcript and already
     * covers everything the live list holds.</p>
     */
    private static final class ClaudeHistoryLoad {
        private final List<JsonObject> messages;
        private final boolean paged;
        private final int fromTurn;
        private final int totalTurns;
        private final boolean hasMore;
        private final boolean cursorReset;
        private final String sessionTitle;

        private ClaudeHistoryLoad(List<JsonObject> messages, JsonObject page) {
            this.messages = messages;
            this.paged = page != null;
            this.fromTurn = page != null ? requirePageInt(page, "fromTurn") : 0;
            this.totalTurns = page != null ? requirePageInt(page, "totalTurns") : 0;
            this.hasMore = page != null && requirePageBoolean(page, "hasMore");
            this.cursorReset = page != null && page.has("cursorReset") && page.get("cursorReset").getAsBoolean();
            this.sessionTitle = page != null ? extractSessionTitle(page) : null;
        }

        /**
         * A missing pagination field must fail with a nameable error instead of an
         * NPE whose null message reaches the frontend's error toast.
         */
        private static int requirePageInt(JsonObject page, String key) {
            if (!page.has(key)) {
                throw new IllegalStateException("Claude history page is missing " + key);
            }
            return page.get(key).getAsInt();
        }

        private static boolean requirePageBoolean(JsonObject page, String key) {
            if (!page.has(key)) {
                throw new IllegalStateException("Claude history page is missing " + key);
            }
            return page.get(key).getAsBoolean();
        }
    }

    /**
     * Load Claude session history with turn-based pagination.
     * Falls back to the legacy full-history load when the paginated query
     * fails or returns invalid data, so a broken cursor never leaves the
     * user with an empty chat.
     */
    private ClaudeHistoryLoad loadClaudeSessionWithPagination(String sessionId, String cwd) {
        // Try the paginated path first: latest page only, then prepend earlier
        // pages as the user scrolls up.
        try {
            JsonObject page = historyAccess.getProviderSessionMessagesPage(sessionId, cwd, null, 30);
            if (page != null && page.has("success") && page.get("success").getAsBoolean()) {
                List<JsonObject> messages = new ArrayList<>();
                for (JsonElement msg : requireClaudeHistoryMessages(page)) {
                    messages.add(msg.getAsJsonObject());
                }
                ClaudeHistoryLoad load = new ClaudeHistoryLoad(messages, page);
                LOG.info("Loaded Claude session page: " + messages.size() + " messages"
                        + ", fromTurn=" + load.fromTurn
                        + ", toTurn=" + (page.has("toTurn") ? page.get("toTurn").getAsInt() : -1)
                        + ", totalTurns=" + load.totalTurns
                        + ", hasMore=" + load.hasMore);
                return load;
            }
        } catch (SessionHistoryNotFoundException e) {
            // A missing transcript is a stale-session signal, not a page
            // failure: rethrow so the caller clears the session ID instead of
            // falling back to the full-history read, which would only raise
            // the same exception after a second bridge round-trip.
            throw e;
        } catch (Exception e) {
            LOG.warn("Paginated session load failed, falling back to full history: " + e.getMessage());
        }

        // Fallback: full history load (legacy behavior)
        LOG.info("Using full-history fallback for Claude session: " + sessionId);
        return new ClaudeHistoryLoad(
                this.historyAccess.getProviderSessionMessages("claude", sessionId, cwd), null);
    }

    /**
     * Load an earlier page of Claude history and prepend it to the current session.
     * Called when the user scrolls to the top of the message list.
     *
     * <p>When the server reports {@code cursorReset} (the requested cursor no
     * longer matches the history, e.g. new turns arrived after the client
     * computed it), the returned page is the latest one — the transcript is
     * replaced, never prepended, or every visible message would duplicate.</p>
     *
     * <p>Any failure notifies the frontend so its loading indicator clears.</p>
     * <p>Missing history retires the session identity and cached transcript.</p>
     */
    public CompletableFuture<Void> loadEarlierClaudeHistoryPage(String sessionId, String cwd, int beforeTurn) {
        long requestedVersion;
        List<ClaudeSession.Message> messageOwnersBeforeRead;
        List<ClaudeSession.Message> messagesBeforeRead;
        synchronized (this.state.getMessageStateLock()) {
            if (!this.recognizesClaudeHistorySession(sessionId, cwd)) {
                return CompletableFuture.completedFuture(null);
            }
            // Before the first accepted load publishes a cursor (version 0) the Java
            // side cannot validate the frontend's restored cursor. While a load is in
            // flight, prepending an older page would break its identity guard and
            // silently discard the newest page, so the request must wait; without an
            // in-flight load a prepend lands before the next read captures its snapshot.
            // Version 0 therefore only admits a restored-window cursor that beat the
            // initial load's claim — a milliseconds-wide race the next full reload heals.
            if (beforeTurn != this.claudeHistoryFromTurn
                    && (this.claudeHistoryVersion > 0 || this.state.isLoading())) {
                this.callbackFacade.notifyClaudeHistoryPageError(sessionId, "History cursor is obsolete; retry the earlier page");
                return CompletableFuture.completedFuture(null);
            }
            requestedVersion = this.claudeHistoryVersion;
            messageOwnersBeforeRead = this.state.getMessages();
            // Streams grow existing rows in place, so identities alone cannot protect a reset.
            messagesBeforeRead = this.state.getMessagesSnapshot();
        }
        return CompletableFuture.runAsync(() -> {
            try {
                JsonObject page = this.historyAccess.getProviderSessionMessagesPage(sessionId, cwd, beforeTurn, 30);
                if (page == null || !page.has("success") || !page.get("success").getAsBoolean()) {
                    String error = page != null && page.has("error") && !page.get("error").isJsonNull()
                            ? page.get("error").getAsString()
                            : "History page query failed";
                    LOG.warn("Failed to load earlier Claude history page: " + error);
                    synchronized (this.state.getMessageStateLock()) {
                        if (this.recognizesClaudeHistorySession(sessionId, cwd)
                                && requestedVersion == this.claudeHistoryVersion) {
                            this.callbackFacade.notifyClaudeHistoryPageError(sessionId, error);
                        }
                    }
                    return;
                }

                List<ClaudeSession.Message> newMessages = new ArrayList<>();
                for (JsonElement msg : requireClaudeHistoryMessages(page)) {
                    ClaudeSession.Message message = this.messageParser.parseServerMessage(msg.getAsJsonObject());
                    if (message != null) {
                        newMessages.add(message);
                    }
                }
                ClaudeHistoryLoad historyLoad = new ClaudeHistoryLoad(List.of(), page);
                Set<String> loadedStructure = MessageStructure.structuralBlockKeys(newMessages);
                synchronized (this.state.getMessageStateLock()) {
                    if (!this.recognizesClaudeHistorySession(sessionId, cwd)
                            || requestedVersion != this.claudeHistoryVersion) {
                        // The winning commit already settled the old page's spinner. Its late
                        // reply must not settle a newer request or report an obsolete failure.
                        return;
                    }
                    // The cursor is meaningful only for the transcript that requested it.
                    // Flush buffered deltas before checking whether a reset could erase them.
                    List<ClaudeSession.Message> currentMessages = this.state.getMessages();
                    boolean keepsReadTranscript = currentMessages.size() >= messageOwnersBeforeRead.size()
                            && currentMessages.subList(0, messageOwnersBeforeRead.size()).equals(messageOwnersBeforeRead);
                    // A reset can lag an already-visible reply or tool even when no new delta arrived during IO.
                    boolean safeToReset = !historyLoad.cursorReset
                            || historyHasNotChangedSinceRead(messagesBeforeRead, currentMessages)
                            && historyKeepsLiveNarrative(newMessages, currentMessages,
                                    lastAlignedHistoryIndex(newMessages, currentMessages))
                            && historyPreservesCurrentStructure(loadedStructure, currentMessages);
                    if (!keepsReadTranscript || !safeToReset) {
                        this.callbackFacade.notifyClaudeHistoryPageError(sessionId, "History changed while loading; retry the earlier page");
                        return;
                    }
                    if (historyLoad.cursorReset) {
                        this.state.replaceMessages(newMessages);
                    } else {
                        this.state.prependMessages(newMessages);
                    }
                    this.claudeHistoryVersion++;
                    this.claudeHistoryFromTurn = historyLoad.fromTurn;
                    this.claudeHistoryHasMore = historyLoad.hasMore && historyLoad.fromTurn > 0;
                    this.claudeHistoryTotalTurns = historyLoad.totalTurns;
                    this.claudeHistorySessionTitle = historyLoad.sessionTitle;
                    this.callbackFacade.notifyMessageUpdate(this.state.getMessagesSnapshot());
                    this.callbackFacade.notifyClaudeHistoryPageInfo(sessionId, this.claudeHistoryFromTurn,
                            this.claudeHistoryTotalTurns, this.claudeHistoryHasMore, historyLoad.cursorReset,
                            this.claudeHistorySessionTitle);
                }
            } catch (SessionHistoryNotFoundException e) {
                synchronized (this.state.getMessageStateLock()) {
                    if (!this.recognizesClaudeHistorySession(sessionId, cwd)
                            || requestedVersion != this.claudeHistoryVersion) {
                        return;
                    }
                    // Settle the old page before its identity disappears from the frontend.
                    this.callbackFacade.notifyClaudeHistoryPageError(sessionId, e.getMessage());
                    this.retireMissingHistory();
                }
                LOG.warn("Session history is unavailable; cleared stale session ID: " + e.getMessage());
            } catch (Exception e) {
                LOG.warn("Failed to load earlier Claude history page: " + e.getMessage(), e);
                synchronized (this.state.getMessageStateLock()) {
                    if (this.recognizesClaudeHistorySession(sessionId, cwd)
                            && requestedVersion == this.claudeHistoryVersion) {
                        this.callbackFacade.notifyClaudeHistoryPageError(sessionId, e.getMessage());
                    }
                }
            }
        });
    }

    /** Called under the message-state lock so identity and transcript retire together. */
    private void retireMissingHistory() {
        this.state.setSessionId(null);
        this.state.clearMessages();
        this.state.setError(null);
        this.callbackFacade.notifySessionIdReceived("");
        this.callbackFacade.notifyMessageUpdate(this.state.getMessagesSnapshot());
    }

    private static JsonArray requireClaudeHistoryMessages(JsonObject page) {
        JsonElement messages = page.get("messages");
        // Only an explicit array proves an empty page; missing bodies cannot advance its cursor.
        if (messages == null || !messages.isJsonArray()) {
            throw new IllegalStateException("Claude history page is missing a messages array");
        }
        return messages.getAsJsonArray();
    }

    private static boolean historyHasNotChangedSinceRead(List<ClaudeSession.Message> before, List<ClaudeSession.Message> current) {
        if (before.size() != current.size()) {
            return false;
        }
        for (int index = 0; index < before.size(); index++) {
            ClaudeSession.Message captured = before.get(index);
            ClaudeSession.Message live = current.get(index);
            if (captured.type != live.type || !Objects.equals(captured.content, live.content)
                    || !Objects.equals(captured.raw, live.raw)) {
                return false;
            }
        }
        return true;
    }

    private boolean recognizesClaudeHistorySession(String sessionId, String cwd) {
        return "claude".equals(this.state.getProvider())
                && Objects.equals(sessionId, this.state.getSessionId())
                && Objects.equals(cwd, this.state.getCwd());
    }


    /**
     * Rebuild the transcript from the older live prefix a freshly loaded page no
     * longer covers.
     *
     * <p>Pagination loads only the newest page, while the live transcript keeps
     * every turn loaded since the session was opened plus the turns appended
     * since. Once a session grows past one page the live list is therefore
     * legitimately longer than any single page, and the staleness guards — built
     * to stop a lagging read from shrinking the transcript — would reject every
     * reload. The newest turns would then never appear: a background agent's
     * report lands in the JSONL while the open session keeps showing the old
     * transcript, and reloading in place does not help either, because the same
     * guard rejects that too. Only navigating away and back (which rebuilds the
     * session with an empty live list) shows the content.</p>
     *
     * <p>Anchor the page to an independently covered UUID row, preferably the
     * latest human request. Streaming assistant rows can aggregate several
     * history entries under one tool snapshot's UUID, so that UUID alone does
     * not identify a safe replacement boundary. The caller verifies the text,
     * thinking and structure following the selected anchor before replacing it.</p>
     *
     * @param loadedMessages  the freshly loaded page
     * @param currentMessages the live transcript
     * @param anchorIndex     the pre-computed {@link #lastAlignedHistoryIndex} for these lists
     * @return the merged transcript, or null when the page cannot be aligned
     */
    private static List<ClaudeSession.Message> mergeLoadedPageWithLivePrefix(
            List<ClaudeSession.Message> loadedMessages,
            List<ClaudeSession.Message> currentMessages,
            int anchorIndex
    ) {
        if (anchorIndex < 0) {
            return null;
        }
        // The anchorIndex contract (a lastAlignedHistoryIndex result) guarantees the
        // anchor row carries a uuid that also exists in the loaded page.
        String anchorUuid = historyMessageUuid(currentMessages.get(anchorIndex));
        int loadedAnchorIndex = indexOfHistoryUuid(loadedMessages, anchorUuid);
        if (anchorIndex == 0) {
            // No older live prefix exists, so retain the entire page and its original cursor.
            return loadedMessages;
        }

        List<ClaudeSession.Message> merged = new ArrayList<>(
                anchorIndex + loadedMessages.size() - loadedAnchorIndex);
        merged.addAll(currentMessages.subList(0, anchorIndex));
        merged.addAll(loadedMessages.subList(loadedAnchorIndex, loadedMessages.size()));
        return merged;
    }

    /**
     * Require all live text and thinking after a safe anchor to survive a history replacement.
     * Structural blocks have a separate identity guard; their synthetic display labels
     * cannot establish whether the writer has persisted the newest narrative.
     */
    private static boolean historyKeepsLiveNarrative(
            List<ClaudeSession.Message> loadedMessages,
            List<ClaudeSession.Message> currentMessages,
            int anchorIndex
    ) {
        int loadedAnchorIndex = anchorIndex < 0 ? -1
                : indexOfHistoryUuid(loadedMessages, historyMessageUuid(currentMessages.get(anchorIndex)));
        // An image-only send or an unpatched first request can have no UUID at all.
        // Row counts still cannot prove that its streamed reply has reached disk.
        int nextLoadedIndex = loadedAnchorIndex + 1;
        for (int i = anchorIndex + 1; i < currentMessages.size(); i++) {
            ClaudeSession.Message live = currentMessages.get(i);
            if (!MessageParser.isHistoryReproducible(live)) {
                continue;
            }
            boolean syntheticResult = isHistoryToolResult(live);
            String text = historyTextContent(live);
            boolean carriesText = !text.isBlank() && !syntheticResult;
            String thinking = historyThinkingContent(live);
            if (syntheticResult || !carriesText && thinking.isEmpty() && live.type != ClaudeSession.Message.Type.USER) {
                continue;
            }
            boolean matched = false;
            while (nextLoadedIndex < loadedMessages.size()) {
                ClaudeSession.Message loaded = loadedMessages.get(nextLoadedIndex++);
                if (isHistoryToolResult(loaded)) {
                    continue;
                }
                if (loaded.type != live.type) {
                    // Repeated wording in a later request cannot prove this reply was persisted.
                    if (live.type == ClaudeSession.Message.Type.ASSISTANT
                            && loaded.type == ClaudeSession.Message.Type.USER) {
                        break;
                    }
                    continue;
                }
                StringBuilder loadedText = new StringBuilder(historyTextContent(loaded));
                StringBuilder loadedThinking = new StringBuilder(historyThinkingContent(loaded));
                // Automatic continuation changes API reply IDs within one live streaming row.
                // Stop once this row is covered so later live rows retain their own history.
                while (loaded.type == ClaudeSession.Message.Type.ASSISTANT && nextLoadedIndex < loadedMessages.size()
                        && (loadedMessages.get(nextLoadedIndex).type == ClaudeSession.Message.Type.ASSISTANT
                        || isHistoryToolResult(loadedMessages.get(nextLoadedIndex)))
                        && (carriesText && !loadedText.toString().startsWith(text)
                        || !loadedThinking.toString().startsWith(thinking))) {
                    // An unrelated row must not consume the rows that could cover the live reply.
                    String candidateText = loadedText.toString();
                    String candidateThinking = loadedThinking.toString();
                    if (carriesText && !text.startsWith(candidateText) && !candidateText.startsWith(text)
                            || !thinking.startsWith(candidateThinking) && !candidateThinking.startsWith(thinking)) {
                        break;
                    }
                    ClaudeSession.Message sibling = loadedMessages.get(nextLoadedIndex++);
                    if (!isHistoryToolResult(sibling)) {
                        loadedText.append(historyTextContent(sibling));
                        loadedThinking.append(historyThinkingContent(sibling));
                    }
                }
                if ((!carriesText || loadedText.toString().startsWith(text))
                        && loadedThinking.toString().startsWith(thinking)) {
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                return false;
            }
        }
        return true;
    }

    /** Compare raw text without display-only block separators, preserving embedded newlines. */
    private static String historyTextContent(ClaudeSession.Message message) {
        JsonArray blocks = MessageStructure.findContentArray(message.raw);
        StringBuilder text = new StringBuilder();
        if (blocks != null) {
            for (JsonElement element : blocks) {
                if (element.isJsonPrimitive() && element.getAsJsonPrimitive().isString()) {
                    text.append(element.getAsString());
                } else if (element.isJsonObject()) {
                    JsonObject block = element.getAsJsonObject();
                    if (block.has("type") && block.get("type").isJsonPrimitive()
                            && "text".equals(block.get("type").getAsString())) {
                        JsonElement body = block.get("text");
                        if (body != null && body.isJsonPrimitive() && body.getAsJsonPrimitive().isString()) {
                            text.append(body.getAsString());
                        }
                    }
                }
            }
        }
        if (text.length() > 0) {
            return text.toString();
        }
        // Locally created rows and legacy payloads may carry only display text.
        return message.content != null ? message.content : "";
    }

    /** Preserve streamed thinking too, since the display content contains only ordinary text. */
    private static String historyThinkingContent(ClaudeSession.Message message) {
        JsonArray blocks = MessageStructure.findContentArray(message.raw);
        StringBuilder thinking = new StringBuilder();
        if (blocks != null) {
            for (JsonElement element : blocks) {
                if (!element.isJsonObject()) {
                    continue;
                }
                JsonObject block = element.getAsJsonObject();
                if (block.has("type") && block.get("type").isJsonPrimitive()
                        && "thinking".equals(block.get("type").getAsString())) {
                    JsonElement body = block.has("thinking") ? block.get("thinking") : block.get("text");
                    if (body != null && body.isJsonPrimitive() && body.getAsJsonPrimitive().isString()) {
                        thinking.append(body.getAsString());
                    }
                }
            }
        }
        return thinking.toString();
    }

    /** Tool receipts share the USER transport role without starting another human request. */
    private static boolean isHistoryToolResult(ClaudeSession.Message message) {
        return message.type == ClaudeSession.Message.Type.USER && "[tool_result]".equals(message.content)
                && MessageStructure.structuralBlockKeys(List.of(message)).stream().anyMatch(key -> key.startsWith("tool_result:"));
    }

    /**
     * Find an independently covered row that can anchor a history replacement.
     *
     * <p>A live assistant can aggregate several persisted rows while carrying only
     * the latest tool snapshot's UUID. Prefer its human request so a reload brings
     * back the complete reply, not just that final snapshot. Older payloads without
     * a request UUID may still align against a fully covered assistant row, or
     * a leading receipt when the live transcript starts partway through a turn.</p>
     */
    private static int lastAlignedHistoryIndex(List<ClaudeSession.Message> loadedMessages,
                                               List<ClaudeSession.Message> currentMessages) {
        // A full fallback can be large; probing every candidate must not repeatedly walk it under the state lock.
        Map<String, ClaudeSession.Message> loadedByUuid = new HashMap<>();
        for (ClaudeSession.Message loaded : loadedMessages) {
            String uuid = historyMessageUuid(loaded);
            if (uuid != null) {
                loadedByUuid.putIfAbsent(uuid, loaded);
            }
        }
        for (boolean humanRequest : List.of(true, false)) {
            for (int index = currentMessages.size() - 1; index >= 0; index--) {
                ClaudeSession.Message live = currentMessages.get(index);
                if (!MessageParser.isHistoryReproducible(live)
                        || isHistoryToolResult(live) && (humanRequest || index > 0)
                        || humanRequest && live.type != ClaudeSession.Message.Type.USER) {
                    continue;
                }
                String uuid = historyMessageUuid(live);
                ClaudeSession.Message loaded = uuid == null ? null : loadedByUuid.get(uuid);
                if (loaded == null) {
                    continue;
                }
                if (loaded.type == live.type && historyTextContent(loaded).startsWith(historyTextContent(live))
                        && historyThinkingContent(loaded).startsWith(historyThinkingContent(live))
                        && MessageStructure.structuralBlockKeys(List.of(loaded))
                        .containsAll(MessageStructure.structuralBlockKeys(List.of(live)))) {
                    return index;
                }
            }
        }
        return -1;
    }

    /**
     * Read the CLI-assigned uuid of a live message, or null when it has none.
     *
     * <p>User rows are stamped with their uuid only once the SDK echoes the send
     * back (see ClaudeMessageHandler), so a message can legitimately carry none;
     * such a row cannot anchor a merge.</p>
     *
     * @param message a live or loaded message
     * @return the uuid, or null
     */
    private static String historyMessageUuid(ClaudeSession.Message message) {
        JsonObject raw = message.raw;
        if (raw == null || !raw.has("uuid") || raw.get("uuid").isJsonNull()) {
            return null;
        }
        return raw.get("uuid").getAsString();
    }

    /**
     * Index of the message carrying the given uuid, or -1.
     *
     * @param messages candidate messages
     * @param uuid     the uuid to find
     * @return the index, or -1
     */
    private static int indexOfHistoryUuid(List<ClaudeSession.Message> messages, String uuid) {
        for (int i = 0; i < messages.size(); i++) {
            if (uuid.equals(historyMessageUuid(messages.get(i)))) {
                return i;
            }
        }
        return -1;
    }

    /**
     * Count the live messages a history read can legitimately reproduce.
     *
     * <p>The staleness guard compares the loaded history against the live list, but
     * the live list also carries rows a history read can never reproduce:
     * locally-synthesized rows (an ERROR bubble added by a failed turn, a SYSTEM
     * notice) and rows the history parser permanently filters (the
     * {@code "No response requested."} assistant placeholder, command-tag user
     * rows — both admitted by the live handlers). Counting any of them would make
     * the history permanently shorter than the live list, so the guard would
     * reject every later reload and a failed turn's error bubble would never
     * clear. Only rows {@link MessageParser#isHistoryReproducible} accepts are
     * counted.</p>
     *
     * @param messages live transcript
     * @return how many messages a history read could reproduce
     */
    private static int countHistoryBackedMessages(List<ClaudeSession.Message> messages) {
        int count = 0;
        for (ClaudeSession.Message message : messages) {
            if (MessageParser.isHistoryReproducible(message)) {
                count++;
            }
        }
        return count;
    }

    /**
     * Read the CLI-derived session title carried by a page payload, or null
     * when the bridge did not include one (legacy payload shape or empty
     * transcript); keeps both pagination notify sites on one extraction path.
     */
    private static String extractSessionTitle(JsonObject page) {
        return page.has("sessionTitle") && !page.get("sessionTitle").isJsonNull()
                ? page.get("sessionTitle").getAsString()
                : null;
    }

    private boolean ownsHistoryLoad(Object token, String sessionId, String cwd, String provider) {
        return state.ownsLoading(token)
                && Objects.equals(sessionId, state.getSessionId())
                && Objects.equals(cwd, state.getCwd())
                && Objects.equals(provider, state.getProvider());
    }

    /**
     * Reject missing live structure, but allow persisted payloads to be normalized.
     * Serialized size cannot distinguish a truncated block from a valid shorter one.
     */
    private static boolean historyPreservesCurrentStructure(
            Set<String> loadedStructure,
            List<ClaudeSession.Message> currentMessages
    ) {
        return loadedStructure.containsAll(MessageStructure.structuralBlockKeys(currentMessages));
    }

    /**
     * Stamp the matching unresolved local user message with the history row uuid.
     * Caller must hold the message-state lock: this walks and mutates the live list.
     */
    private ClaudeSession.Message patchMatchingUserMessage(JsonObject historyMessage) {
        if (!historyMessage.has("type") || !"user".equals(historyMessage.get("type").getAsString())) {
            return null;
        }
        if (!historyMessage.has("uuid") || historyMessage.get("uuid").isJsonNull()) {
            return null;
        }

        String historyContent = extractMessageContentForMatching(historyMessage);
        if (historyContent == null || historyContent.isEmpty()) {
            return null;
        }

        String uuid = historyMessage.get("uuid").getAsString();
        List<ClaudeSession.Message> localMessages = state.getMessagesReference();
        for (int i = localMessages.size() - 1; i >= 0; i--) {
            ClaudeSession.Message localMsg = localMessages.get(i);
            if (localMsg.type != ClaudeSession.Message.Type.USER) {
                continue;
            }
            if (localMsg.raw != null && localMsg.raw.has("uuid") && !localMsg.raw.get("uuid").isJsonNull()) {
                continue;
            }
            if (!historyContent.equals(localMsg.content)) {
                continue;
            }

            if (localMsg.raw == null) {
                localMsg.raw = createDefaultUserRaw(localMsg.content);
            }
            localMsg.raw.addProperty("uuid", uuid);
            return localMsg;
        }

        return null;
    }

    static JsonObject createDefaultUserRaw(String content) {
        JsonObject raw = new JsonObject();
        JsonObject message = new JsonObject();
        JsonArray contentArray = new JsonArray();
        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", content != null ? content : "");
        contentArray.add(textBlock);
        message.add("content", contentArray);
        raw.add("message", message);
        return raw;
    }

    /**
     * Return the newest user message still missing a uuid. Self-locking so the
     * lockless pre-checks at the call sites — which merely decide whether the
     * async uuid sync is worth starting — stay race-free against concurrent
     * message appends.
     */
    private ClaudeSession.Message findLatestUnresolvedUserMessage() {
        synchronized (state.getMessageStateLock()) {
            List<ClaudeSession.Message> messages = state.getMessagesReference();
            for (int i = messages.size() - 1; i >= 0; i--) {
                ClaudeSession.Message message = messages.get(i);
                if (message.type != ClaudeSession.Message.Type.USER) {
                    continue;
                }
                if (message.content == null || message.content.isEmpty() || "[tool_result]".equals(message.content)) {
                    continue;
                }
                if (message.raw == null) {
                    return message;
                }
                if (!message.raw.has("uuid") || message.raw.get("uuid").isJsonNull()) {
                    return message;
                }
            }
            return null;
        }
    }

    String extractMessageContentForMatching(JsonObject msg) {
        if (!msg.has("message") || !msg.get("message").isJsonObject()) {
            return null;
        }
        JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content")) {
            return null;
        }

        JsonElement contentElement = message.get("content");
        if (contentElement.isJsonPrimitive()) {
            return contentElement.getAsString();
        }

        if (contentElement.isJsonArray()) {
            JsonArray contentArray = contentElement.getAsJsonArray();
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < contentArray.size(); i++) {
                JsonElement element = contentArray.get(i);
                if (!element.isJsonObject()) {
                    continue;
                }
                JsonObject block = element.getAsJsonObject();
                if (block.has("type") && "text".equals(block.get("type").getAsString()) && block.has("text")) {
                    if (sb.length() > 0) {
                        sb.append("\n");
                    }
                    sb.append(block.get("text").getAsString());
                }
            }
            return sb.toString();
        }

        return null;
    }

    private void restoreTokenUsage(List<JsonObject> serverMessages) {
        try {
            JsonObject lastUsage = TokenUsageUtils.findLastUsageFromRawMessages(serverMessages, state.getProvider());
            if (lastUsage == null) {
                return;
            }

            int usedTokens = TokenUsageUtils.extractContextTokens(lastUsage, state.getProvider());
            int fallbackMaxTokens = SettingsHandler.getModelContextLimit(
                    state.getProvider(), state.getModel());
            int maxTokens = TokenUsageUtils.extractMaxTokens(lastUsage, fallbackMaxTokens);
            usageDisplay.show(usedTokens, maxTokens);
            LOG.debug("Restored token usage from history: " + usedTokens + " / " + maxTokens);
        } catch (Exception e) {
            LOG.warn("Failed to extract token usage from history: " + e.getMessage());
        }
    }

    private void sleep(long delayMs) {
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
