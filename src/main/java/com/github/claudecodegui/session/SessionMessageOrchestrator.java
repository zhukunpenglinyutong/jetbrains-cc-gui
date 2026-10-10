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
import java.util.List;
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

                // The turn the live window currently starts at. A page load overwrites
                // claudeHistoryFromTurn with its own start, but a merged transcript keeps
                // the older live prefix, so this value has to survive the load (see the
                // merge branch below).
                int windowStartTurnBeforeLoad = claudeHistoryFromTurn;

                List<JsonObject> serverMessages;
                boolean pagedClaudeLoad;
                if ("claude".equals(requestedProvider)) {
                    ClaudeHistoryLoad historyLoad = loadClaudeSessionWithPagination(requestedSessionId, requestedCwd);
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
                    List<ClaudeSession.Message> currentMessages = state.getMessagesReference();
                    // A new row added during this read belongs to newer live work.
                    // Metadata patches keep the same row identities and remain valid.
                    if (!currentMessages.equals(messagesBeforeLoad)) {
                        return;
                    }
                    // A page load only carries the newest turns, so a transcript that
                    // already holds more turns than one page is legitimately longer
                    // than what came back. Align the page to the live tail and keep
                    // the older live prefix instead of rejecting the reload — see
                    // mergeLoadedPageWithLivePrefix.
                    List<ClaudeSession.Message> mergedMessages = "codex".equals(requestedProvider)
                            ? CodexHistoryMerger.reconcile(loadedMessages, currentMessages) : pagedClaudeLoad
                            ? mergeLoadedPageWithLivePrefix(loadedMessages, currentMessages)
                            : null;
                    if (mergedMessages != null) {
                        if (!"codex".equals(requestedProvider) && !MessageStructure.structuralBlockKeys(mergedMessages)
                                .containsAll(MessageStructure.structuralBlockKeys(currentMessages))) {
                            LOG.warn("Ignoring history page that would remove live structural blocks");
                            return;
                        }
                        keptOlderLivePrefix = true;
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
                    state.replaceMessages(loadedMessages);
                    state.setError(null);
                    callbackMessages = state.getMessagesSnapshot();
                    restoreTokenUsage(serverMessages);
                    callbackFacade.notifyMessageUpdate(callbackMessages);
                    if (keptOlderLivePrefix && pagedClaudeLoad) {
                        // The merge kept turns the page no longer carries, so the
                        // window still starts where it started before this load. The
                        // load already announced the page's own start; announce the
                        // real one or the frontend's "load earlier" cursor would step
                        // past the kept turns and re-request them as duplicates.
                        claudeHistoryFromTurn = windowStartTurnBeforeLoad;
                        callbackFacade.notifyClaudeHistoryPageInfo(
                                requestedSessionId,
                                claudeHistoryFromTurn,
                                claudeHistoryTotalTurns,
                                claudeHistoryHasMore,
                                false,
                                claudeHistorySessionTitle);
                    }
                }
            } catch (SessionHistoryNotFoundException e) {
                // A missing history file is an explicit stale-session signal, so unlike
                // the stale-result guards above it clears the live transcript.
                synchronized (state.getMessageStateLock()) {
                    if (!ownsHistoryLoad(loadingToken, requestedSessionId, requestedCwd, requestedProvider)) {
                        return;
                    }
                    state.setSessionId(null);
                    state.clearMessages();
                    state.setError(null);
                    callbackFacade.notifyMessageUpdate(state.getMessagesSnapshot());
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

        ClaudeHistoryLoad(List<JsonObject> messages, boolean paged) {
            this.messages = messages;
            this.paged = paged;
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
                if (page.has("messages")) {
                    JsonArray messagesArray = page.getAsJsonArray("messages");
                    for (JsonElement msg : messagesArray) {
                        messages.add(msg.getAsJsonObject());
                    }
                }
                // Save pagination metadata for scroll-based loading
                claudeHistoryFromTurn = page.get("fromTurn").getAsInt();
                claudeHistoryTotalTurns = page.get("totalTurns").getAsInt();
                claudeHistoryHasMore = page.get("hasMore").getAsBoolean();
                String sessionTitle = extractSessionTitle(page);
                claudeHistorySessionTitle = sessionTitle;
                LOG.info("Loaded Claude session page: " + messages.size() + " messages"
                        + ", fromTurn=" + claudeHistoryFromTurn
                        + ", toTurn=" + page.get("toTurn").getAsInt()
                        + ", totalTurns=" + claudeHistoryTotalTurns
                        + ", hasMore=" + claudeHistoryHasMore);
                // Notify frontend of pagination metadata (plus the CLI-derived
                // session title so the header does not depend on this page's
                // message span)
                callbackFacade.notifyClaudeHistoryPageInfo(sessionId, claudeHistoryFromTurn, claudeHistoryTotalTurns, claudeHistoryHasMore,
                        page.has("cursorReset") && page.get("cursorReset").getAsBoolean(), sessionTitle);
                return new ClaudeHistoryLoad(messages, true);
            }
        } catch (Exception e) {
            LOG.warn("Paginated session load failed, falling back to full history: " + e.getMessage());
        }

        // Fallback: full history load (legacy behavior)
        LOG.info("Using full-history fallback for Claude session: " + sessionId);
        claudeHistoryFromTurn = 0;
        claudeHistoryTotalTurns = 0;
        claudeHistoryHasMore = false;
        return new ClaudeHistoryLoad(
                historyAccess.getProviderSessionMessages("claude", sessionId, cwd), false);
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
     */
    public CompletableFuture<Void> loadEarlierClaudeHistoryPage(String sessionId, String cwd, int beforeTurn) {
        return CompletableFuture.runAsync(() -> {
            try {
                JsonObject page = historyAccess.getProviderSessionMessagesPage(sessionId, cwd, beforeTurn, 30);
                if (page == null || !page.has("success") || !page.get("success").getAsBoolean()) {
                    String error = page != null && page.has("error") && !page.get("error").isJsonNull()
                            ? page.get("error").getAsString()
                            : "History page query failed";
                    LOG.warn("Failed to load earlier Claude history page: " + error);
                    callbackFacade.notifyClaudeHistoryPageError(sessionId, error);
                    return;
                }

                List<ClaudeSession.Message> newMessages = new ArrayList<>();
                if (page.has("messages")) {
                    for (JsonElement msg : page.getAsJsonArray("messages")) {
                        ClaudeSession.Message message = messageParser.parseServerMessage(msg.getAsJsonObject());
                        if (message != null) {
                            newMessages.add(message);
                        }
                    }
                }

                boolean cursorReset = page.has("cursorReset") && page.get("cursorReset").getAsBoolean();
                claudeHistoryFromTurn = page.get("fromTurn").getAsInt();
                claudeHistoryHasMore = page.get("hasMore").getAsBoolean();
                claudeHistoryTotalTurns = page.get("totalTurns").getAsInt();

                if (cursorReset) {
                    // The page holds the latest turns, not earlier ones — replacing
                    // is the only non-duplicating option.
                    state.replaceMessages(newMessages);
                    LOG.info("Claude history cursor reset; replaced transcript with latest page: "
                            + newMessages.size() + " messages, totalTurns=" + claudeHistoryTotalTurns);
                } else {
                    state.prependMessages(newMessages);
                    LOG.info("Prepended Claude history page: " + newMessages.size() + " messages"
                            + ", fromTurn=" + claudeHistoryFromTurn
                            + ", hasMore=" + claudeHistoryHasMore);
                }
                callbackFacade.notifyMessageUpdate(state.getMessages());
                callbackFacade.notifyClaudeHistoryPageInfo(sessionId, claudeHistoryFromTurn, claudeHistoryTotalTurns, claudeHistoryHasMore, cursorReset,
                        extractSessionTitle(page));
            } catch (Exception e) {
                LOG.error("Failed to load earlier Claude history page: " + e.getMessage(), e);
                callbackFacade.notifyClaudeHistoryPageError(sessionId, e.getMessage());
            }
        });
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
     * <p>Anchor the page to the live tail by uuid. Only when the newest
     * history-reproducible live message is found inside the page is the page
     * known to be at least as new as the live list; the live messages above that
     * anchor are older turns the page no longer carries, and they are kept
     * verbatim. A page that does not carry the live tail is lagging (the writer
     * may still be mid-append) and returns null so the caller's guards reject it
     * as before.</p>
     *
     * @param loadedMessages  the freshly loaded page
     * @param currentMessages the live transcript
     * @return the merged transcript, or null when the page cannot be aligned
     */
    private static List<ClaudeSession.Message> mergeLoadedPageWithLivePrefix(
            List<ClaudeSession.Message> loadedMessages,
            List<ClaudeSession.Message> currentMessages
    ) {
        int anchorIndex = lastHistoryBackedIndex(currentMessages);
        if (anchorIndex <= 0) {
            // Nothing older to keep, or no live row to align the page against.
            return null;
        }
        String anchorUuid = historyMessageUuid(currentMessages.get(anchorIndex));
        if (anchorUuid == null) {
            return null;
        }
        int loadedAnchorIndex = indexOfHistoryUuid(loadedMessages, anchorUuid);
        if (loadedAnchorIndex < 0) {
            return null;
        }

        List<ClaudeSession.Message> merged = new ArrayList<>(
                anchorIndex + loadedMessages.size() - loadedAnchorIndex);
        merged.addAll(currentMessages.subList(0, anchorIndex));
        merged.addAll(loadedMessages.subList(loadedAnchorIndex, loadedMessages.size()));
        return merged;
    }

    /**
     * Index of the newest live message a history read can reproduce, or -1.
     *
     * @param messages live transcript
     * @return the index of the newest history-reproducible message
     */
    private static int lastHistoryBackedIndex(List<ClaudeSession.Message> messages) {
        for (int i = messages.size() - 1; i >= 0; i--) {
            if (MessageParser.isHistoryReproducible(messages.get(i))) {
                return i;
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
