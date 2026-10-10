package com.github.claudecodegui.session;

import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.provider.common.SessionHistoryNotFoundException;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for loading provider history and restoring session-side derived state.
 */
public class SessionMessageOrchestratorTest {

    private Application previousApplication;

    /** Keep streamed status changes independent of a running IDE. */
    @Before
    public void stubNotificationDispatch() {
        previousApplication = ApplicationManager.getApplication();
        Application application = (Application) Proxy.newProxyInstance(Application.class.getClassLoader(),
                new Class<?>[]{Application.class}, (proxy, method, arguments) -> {
                    if (method.getReturnType() == boolean.class) {
                        return false;
                    }
                    return null;
                });
        ApplicationManager.setApplication(application);
    }

    /** Leave subsequent tests with the application they started with. */
    @After
    public void restoreApplication() {
        ApplicationManager.setApplication(previousApplication);
    }

    @Test
    public void updateUserMessageUuidsBackfillsMatchingLatestClaudeUserMessage() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-1");
        state.setCwd("/workspace");

        JsonObject localRaw = new JsonObject();
        ClaudeSession.Message localUserMessage = new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "Explain this diff", localRaw);
        state.addMessage(localUserMessage);

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.latestClaudeUserMessage = createHistoryUserMessage("uuid-123", "Explain this diff");

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.updateUserMessageUuids();

        assertEquals(1, historyAccess.latestClaudeUserMessageRequests.get());
        assertTrue(localUserMessage.raw.has("uuid"));
        assertEquals("uuid-123", localUserMessage.raw.get("uuid").getAsString());
        assertEquals(0, callback.messageUpdates.size());
        assertEquals(List.of("Explain this diff|uuid-123"), callback.messageUuidPatches);
    }

    @Test
    public void updateUserMessageUuidsSkipsLookupWhenAllUserMessagesAlreadyHaveUuid() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-1");
        state.setCwd("/workspace");

        JsonObject localRaw = new JsonObject();
        localRaw.addProperty("uuid", "existing-uuid");
        state.addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "Explain this diff", localRaw));

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.updateUserMessageUuids();

        assertEquals(0, historyAccess.latestClaudeUserMessageRequests.get());
    }

    @Test
    public void loadFromServerParsesHistoryAndClearsLoadingState() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setModel("claude-sonnet-4-6");
        state.setSessionId("session-2");
        state.setCwd("/workspace");

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.providerHistory = List.of(
                createProviderMessage("user", "Show me the latest error"),
                createProviderMessage("assistant", "The stack trace points to SessionSendService.")
        );

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.loadFromServer().join();

        assertEquals(1, historyAccess.providerHistoryRequests.get());
        assertFalse(state.isLoading());
        assertEquals(2, state.getMessages().size());
        assertEquals(ClaudeSession.Message.Type.USER, state.getMessages().get(0).type);
        assertEquals(ClaudeSession.Message.Type.ASSISTANT, state.getMessages().get(1).type);
        assertEquals("The stack trace points to SessionSendService.", state.getMessages().get(1).content);
        assertEquals(1, callback.messageUpdates.size());
        assertTrue(callback.stateChanges.contains("false:false:null"));
    }

    @Test
    public void loadFromServerClearsSessionIdWhenHistoryIsMissing() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("expired-session");
        state.setCwd("/workspace");

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.providerHistoryFailure = new SessionHistoryNotFoundException(
                "expired-session", "/workspace");
        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                new SessionCallbackFacade(null),
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.loadFromServer().join();

        assertNull(state.getSessionId());
        assertTrue(state.getMessages().isEmpty());
        assertFalse(state.isLoading());
        assertNull(state.getError());
    }

    @Test
    public void loadFromServerDoesNotEraseLiveMessagesWhenHistoryIsEmpty() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-empty-response");
        state.setCwd("/workspace");
        state.addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "live answer"));

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.providerHistory = List.of();
        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                new SessionCallbackFacade(null),
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.loadFromServer().join();

        assertEquals(1, state.getMessages().size());
        assertEquals("live answer", state.getMessages().get(0).content);
        assertFalse(state.isLoading());
    }

    @Test
    public void loadFromServerAcceptsHistoryShorterThanLiveLocallySynthesizedRows() {
        // A failed turn appends an ERROR bubble that is never persisted, so the live
        // list is permanently longer than the history. Counting it would make every
        // later reload look stale and the error bubble would never clear.
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-with-error-bubble");
        state.setCwd("/workspace");
        state.addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "live prompt"));
        state.addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.ERROR, "request failed"));

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.providerHistory = List.of(createProviderMessage("user", "live prompt"));
        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                new SessionCallbackFacade(null),
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.loadFromServer().join();

        assertEquals(1, state.getMessages().size());
        assertEquals("live prompt", state.getMessages().get(0).content);
    }

    @Test
    public void loadFromServerAcceptsHistoryWhenLiveListHasParserFilteredRows() {
        // The live handlers admit rows the history parser permanently filters —
        // the "No response requested." assistant placeholder and command-tag user
        // rows. Counting them as history-backed makes the live list permanently
        // one longer than any load, so every reload is rejected as stale.
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-with-placeholder");
        state.setCwd("/workspace");
        state.addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "live prompt"));
        state.addMessage(new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT, "No response requested.", new JsonObject()));

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.providerHistory = List.of(createProviderMessage("user", "live prompt"));
        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                new SessionCallbackFacade(null),
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.loadFromServer().join();

        // The placeholder row is gone: the load was applied, not rejected as stale.
        assertEquals(1, state.getMessages().size());
        assertEquals("live prompt", state.getMessages().get(0).content);
    }

    @Test
    public void loadFromServerDoesNotShrinkLiveMessagesWhenHistoryLags() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-lagging-response");
        state.setCwd("/workspace");
        state.addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "live prompt"));
        state.addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "live answer"));

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.providerHistory = List.of(createProviderMessage("user", "old prompt"));
        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                new SessionCallbackFacade(null),
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.loadFromServer().join();

        assertEquals(2, state.getMessages().size());
        assertEquals("live prompt", state.getMessages().get(0).content);
        assertEquals("live answer", state.getMessages().get(1).content);
    }

    @Test
    public void loadFromServerDoesNotEraseLiveToolBlocksWhenHistoryLags() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-lagging-tools");
        state.setCwd("/workspace");

        JsonObject toolUse = new JsonObject();
        toolUse.addProperty("type", "tool_use");
        toolUse.addProperty("id", "tool-1");
        toolUse.addProperty("name", "Bash");
        JsonArray liveContent = new JsonArray();
        liveContent.add(toolUse);
        JsonObject liveMessage = new JsonObject();
        liveMessage.add("content", liveContent);
        JsonObject liveRaw = new JsonObject();
        liveRaw.add("message", liveMessage);
        state.addMessage(new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT, "", liveRaw));

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.providerHistory = List.of(createProviderMessage("assistant", "stale text"));
        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                new SessionCallbackFacade(null),
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.loadFromServer().join();

        assertEquals(1, state.getMessages().size());
        JsonArray restoredContent = state.getMessages().get(0).raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");
        assertEquals("tool_use", restoredContent.get(0).getAsJsonObject()
                .get("type").getAsString());
    }

    @Test
    public void loadFromServerAdmitsTheLatestPageWhenLiveHoldsMoreTurnsThanOnePage() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-long");
        state.setCwd("/workspace");

        // Live transcript: the 30-turn page opened earlier plus the turn appended since.
        for (int turn = 1; turn <= 31; turn++) {
            state.addMessage(liveMessage(ClaudeSession.Message.Type.USER, "prompt " + turn, turn));
            state.addMessage(liveMessage(ClaudeSession.Message.Type.ASSISTANT, "answer " + turn, turn));
        }

        // The transcript now carries one more turn; the paginated reload only ever
        // returns the latest 30 turns, so the newest turn arrives without the
        // oldest one the live list still holds.
        List<JsonObject> latestPage = new ArrayList<>();
        for (int turn = 3; turn <= 32; turn++) {
            latestPage.add(createProviderMessage("user", "prompt " + turn, "uuid-" + turn + "-user"));
            latestPage.add(createProviderMessage("assistant", "answer " + turn, "uuid-" + turn + "-assistant"));
        }
        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.messagesPage = createHistoryPage(latestPage, 2, 32, 32, true, false);

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);
        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.loadFromServer().join();

        List<ClaudeSession.Message> messages = state.getMessages();
        assertTrue(
                "the turn that landed while the page was open must reach the transcript",
                messages.stream().anyMatch(m -> "answer 32".equals(m.content))
        );
        assertTrue(
                "turns the page no longer carries must stay in the transcript",
                messages.stream().anyMatch(m -> "prompt 1".equals(m.content))
        );
        // Every turn from 1 to 32, exactly once.
        assertEquals(64, messages.size());
        // The load announces the page's own start, then the merge corrects the
        // cursor back to the window the kept prefix actually starts at, or the
        // frontend's "load earlier" would re-request the kept turns.
        assertEquals(2, callback.claudeHistoryPageInfos.size());
        assertEquals("session-long|2|32|true|false|null", callback.claudeHistoryPageInfos.get(0));
        assertEquals("session-long|0|32|true|false|null", callback.claudeHistoryPageInfos.get(1));
    }

    @Test
    public void loadFromServerStillRejectsAPageThatLagsBehindTheLiveTail() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-lagging-page");
        state.setCwd("/workspace");

        // The live transcript already holds turn 2, which the JSONL has not written yet.
        state.addMessage(liveMessage(ClaudeSession.Message.Type.USER, "prompt 1", 1));
        state.addMessage(liveMessage(ClaudeSession.Message.Type.ASSISTANT, "answer 1", 1));
        state.addMessage(liveMessage(ClaudeSession.Message.Type.USER, "prompt 2", 2));
        state.addMessage(liveMessage(ClaudeSession.Message.Type.ASSISTANT, "answer 2", 2));

        List<JsonObject> stalePage = new ArrayList<>();
        stalePage.add(createProviderMessage("user", "prompt 1", "uuid-1-user"));
        stalePage.add(createProviderMessage("assistant", "answer 1", "uuid-1-assistant"));
        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.messagesPage = createHistoryPage(stalePage, 0, 1, 1, false, false);

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);
        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.loadFromServer().join();

        List<ClaudeSession.Message> messages = state.getMessages();
        assertEquals(4, messages.size());
        assertEquals("answer 2", messages.get(3).content);
        // The load itself announced the page; the rejected merge must not send a
        // cursor correction on top of it.
        assertEquals(1, callback.claudeHistoryPageInfos.size());
    }

    private static ClaudeSession.Message liveMessage(ClaudeSession.Message.Type type, String content, int turn) {
        JsonObject raw = new JsonObject();
        raw.addProperty("uuid", "uuid-" + turn + "-" + (type == ClaudeSession.Message.Type.USER ? "user" : "assistant"));
        return new ClaudeSession.Message(type, content, raw);
    }

    /**
     * The live [TOOL_RESULT] bubble ClaudeMessageHandler.handleToolResult builds:
     * a synthesized raw without the uuid the JSONL row carries.
     */
    private static ClaudeSession.Message liveSynthesizedToolResult(String toolUseId) {
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_result");
        block.addProperty("tool_use_id", toolUseId);
        block.addProperty("content", "background output");

        JsonArray content = new JsonArray();
        content.add(block);
        JsonObject message = new JsonObject();
        message.add("content", content);
        JsonObject raw = new JsonObject();
        raw.addProperty("type", "user");
        raw.add("message", message);
        return new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "[tool_result]", raw);
    }

    /**
     * The live assistant row a streaming text-only turn synthesizes from deltas:
     * no [MESSAGE] ever carried it, so the raw has no uuid.
     */
    private static ClaudeSession.Message liveSynthesizedAssistant(String text) {
        JsonObject block = new JsonObject();
        block.addProperty("type", "text");
        block.addProperty("text", text);

        JsonArray content = new JsonArray();
        content.add(block);
        JsonObject message = new JsonObject();
        message.add("content", content);
        JsonObject raw = new JsonObject();
        raw.addProperty("type", "assistant");
        raw.add("message", message);
        return new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, text, raw);
    }

    /**
     * The JSONL user row carrying a tool_result, the shape the history page
     * returns for what the live side also renders as the [TOOL_RESULT] bubble.
     */
    private static JsonObject providerToolResultMessage(String uuid, String toolUseId) {
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_result");
        block.addProperty("tool_use_id", toolUseId);
        block.addProperty("content", "background output");

        JsonArray content = new JsonArray();
        content.add(block);
        JsonObject message = new JsonObject();
        message.add("content", content);
        JsonObject serverMessage = new JsonObject();
        serverMessage.addProperty("type", "user");
        serverMessage.addProperty("uuid", uuid);
        serverMessage.add("message", message);
        return serverMessage;
    }

    /** Reconcile uuid-less duplicates only once their persisted counterparts are available. */
    @Test
    public void loadFromServerAnchorsTheMergePastUuidlessLiveSyntheticRows() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-synthetic-tail");
        state.setCwd("/workspace");

        // Live tail of a background-command turn: the [TOOL_RESULT] bubble is
        // added twice (once by the [MESSAGE] path with the SDK uuid, once by the
        // [TOOL_RESULT] path without one) and a streaming text-only turn ends
        // with an assistant row synthesized from deltas, also without a uuid.
        // Anchoring on the tail must skip the uuid-less rows and align on the
        // newest uuid-carrying one instead, or every paginated reload of a long
        // session is rejected by the staleness guards.
        state.addMessage(liveMessage(ClaudeSession.Message.Type.USER, "prompt 1", 1));
        state.addMessage(liveMessage(ClaudeSession.Message.Type.ASSISTANT, "answer 1", 1));
        state.addMessage(liveMessage(ClaudeSession.Message.Type.USER, "prompt 2", 2));
        state.addMessage(liveUuidBackedToolResult("uuid-2-tr", "tool-2"));
        state.addMessage(liveSynthesizedToolResult("tool-2"));
        state.addMessage(liveSynthesizedAssistant("answer 2"));

        // The page carries the same turns with the uuids the JSONL rows hold,
        // including the final assistant text the live side never saw a uuid for.
        List<JsonObject> latestPage = new ArrayList<>();
        latestPage.add(createProviderMessage("user", "prompt 1", "uuid-1-user"));
        latestPage.add(createProviderMessage("assistant", "answer 1", "uuid-1-assistant"));
        latestPage.add(createProviderMessage("user", "prompt 2", "uuid-2-user"));
        latestPage.add(providerToolResultMessage("uuid-2-tr", "tool-2"));
        latestPage.add(createProviderMessage("assistant", "answer 2", "uuid-2-assistant"));
        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.messagesPage = createHistoryPage(latestPage, 0, 5, 5, false, false);

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);
        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.loadFromServer().join();

        List<ClaudeSession.Message> messages = state.getMessages();
        assertTrue(
                "the background turn's final text must reach the transcript",
                messages.stream().anyMatch(m -> "answer 2".equals(m.content))
        );
        assertTrue(
                "turns the page no longer carries must stay in the transcript",
                messages.stream().anyMatch(m -> "prompt 1".equals(m.content))
        );
        // Live prefix through the uuid-anchored tool_result row, then the page
        // from the anchor onwards. The duplicate synthetic bubble is replaced by
        // the page's uuid-carrying row.
        assertEquals(5, messages.size());
        assertEquals(2, callback.claudeHistoryPageInfos.size());
        assertEquals("session-synthetic-tail|0|5|false|false|null", callback.claudeHistoryPageInfos.get(0));
        assertEquals("session-synthetic-tail|0|5|false|false|null", callback.claudeHistoryPageInfos.get(1));
    }

    /**
     * Reject lagging pages even when an earlier uuid anchor is present.
     */
    @Test
    public void loadFromServerProtectsUuidlessLiveTextFromLaggingPages() {
        for (String persistedTail : List.of("", "latest")) {
            SessionState state = new SessionState();
            state.setProvider("claude");
            state.setSessionId("session-unwritten-tail");
            state.setCwd("/workspace");
            state.addMessage(liveMessage(ClaudeSession.Message.Type.USER, "prompt", 1));
            state.addMessage(liveMessage(ClaudeSession.Message.Type.ASSISTANT, "anchor", 1));
            state.addMessage(liveSynthesizedAssistant("latest complete answer"));

            List<JsonObject> stalePage = new ArrayList<>();
            stalePage.add(createProviderMessage("user", "older prompt", "older-user"));
            stalePage.add(createProviderMessage("assistant", "older answer", "older-assistant"));
            stalePage.add(createProviderMessage("user", "prompt", "uuid-1-user"));
            stalePage.add(createProviderMessage("assistant", "anchor", "uuid-1-assistant"));
            if (!persistedTail.isEmpty()) {
                stalePage.add(createProviderMessage("assistant", persistedTail, "persisted-tail"));
            }
            RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
            historyAccess.messagesPage = createHistoryPage(stalePage, 0, 2, 2, false, false);
            SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                    state, new MessageParser(), new SessionCallbackFacade(null), historyAccess,
                    (used, max) -> { }, 0, 0);

            orchestrator.loadFromServer().join();

            assertEquals(3, state.getMessages().size());
            assertEquals("latest complete answer", state.getMessages().get(2).content);
        }
    }

    /** Accept complete streamed blocks despite the history display's added separators. */
    @Test
    public void loadFromServerAcceptsCompleteMultiBlockStreamsAndNewReports() {
        for (String firstBlock : List.of("First paragraph.", "First line.\nSecond line.")) {
            for (boolean flatHistoryContent : List.of(false, true)) {
                SessionState state = new SessionState();
                state.setProvider("claude");
                state.setSessionId("session-multi-block");
                state.setCwd("/workspace");
                MessageParser parser = new MessageParser();
                JsonObject user = createProviderMessage("user", "prompt", "user-uuid");
                state.addMessage(parser.parseServerMessage(user));
                ClaudeSession.Message live = streamAssistantText(state, firstBlock, "Final paragraph.");
                assertEquals(firstBlock + "Final paragraph.", live.content);
                assertFalse(live.raw.has("uuid"));

                JsonObject persisted = live.raw.deepCopy();
                persisted.addProperty("uuid", "assistant-uuid");
                if (flatHistoryContent) {
                    persisted.add("content", persisted.remove("message").getAsJsonObject().get("content"));
                }
                assertEquals(firstBlock + "\nFinal paragraph.", parser.parseServerMessage(persisted).content);
                RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
                historyAccess.messagesPage = createHistoryPage(List.of(user, persisted,
                        createProviderMessage("assistant", "New background report.", "report-uuid")), 0, 1, 1, false, false);
                RecordingCallback callback = new RecordingCallback();
                SessionCallbackFacade facade = new SessionCallbackFacade(null);
                facade.setCallback(callback);
                SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                        state, parser, facade, historyAccess, (used, max) -> { }, 0, 0);

                orchestrator.loadFromServer().join();

                assertEquals(3, state.getMessages().size());
                assertEquals(firstBlock + "\nFinal paragraph.", state.getMessages().get(1).content);
                assertEquals("assistant-uuid", state.getMessages().get(1).raw.get("uuid").getAsString());
                assertEquals("New background report.", state.getMessages().get(2).content);
                assertEquals(1, callback.messageUpdates.size());
                assertFalse(state.isLoading());
            }
        }
    }

    /** Keep every live block while the writer catches up, then allow a complete retry. */
    @Test
    public void loadFromServerProtectsMultiBlockStreamsUntilAllTextIsPersisted() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-partial-blocks");
        state.setCwd("/workspace");
        MessageParser parser = new MessageParser();
        JsonObject user = createProviderMessage("user", "prompt", "user-uuid");
        state.addMessage(parser.parseServerMessage(user));
        ClaudeSession.Message live = streamAssistantText(state, "First paragraph.", "Final paragraph.");
        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade facade = new SessionCallbackFacade(null);
        facade.setCallback(callback);
        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state, parser, facade, historyAccess, (used, max) -> { }, 0, 0);
        JsonObject persisted = live.raw.deepCopy();
        persisted.addProperty("uuid", "assistant-uuid");
        JsonObject missingBlock = persisted.deepCopy();
        missingBlock.getAsJsonObject("message").getAsJsonArray("content").remove(1);
        JsonObject truncatedBlock = persisted.deepCopy();
        truncatedBlock.getAsJsonObject("message").getAsJsonArray("content").get(1).getAsJsonObject()
                .addProperty("text", "Final");

        for (List<JsonObject> partialPage : List.of(List.of(user), List.of(user, missingBlock), List.of(user, truncatedBlock))) {
            historyAccess.messagesPage = createHistoryPage(partialPage, 0, 1, 1, false, false);
            orchestrator.loadFromServer().join();

            assertEquals(2, state.getMessages().size());
            assertEquals("First paragraph.Final paragraph.", state.getMessages().get(1).content);
            assertFalse(state.getMessages().get(1).raw.has("uuid"));
            assertTrue(callback.messageUpdates.isEmpty());
            assertFalse(state.isLoading());
        }

        historyAccess.messagesPage = createHistoryPage(List.of(user, persisted), 0, 1, 1, false, false);
        orchestrator.loadFromServer().join();

        assertEquals("First paragraph.\nFinal paragraph.", state.getMessages().get(1).content);
        assertEquals("assistant-uuid", state.getMessages().get(1).raw.get("uuid").getAsString());
        assertEquals(1, callback.messageUpdates.size());
    }

    /** A newline inside a block is real content and must survive history reconciliation. */
    @Test
    public void loadFromServerProtectsEmbeddedNewlinesInMultiBlockStreams() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-multi-line-blocks");
        state.setCwd("/workspace");
        MessageParser parser = new MessageParser();
        JsonObject user = createProviderMessage("user", "prompt", "user-uuid");
        state.addMessage(parser.parseServerMessage(user));
        ClaudeSession.Message live = streamAssistantText(state, "First line.\nSecond line.", "Final paragraph.");
        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade facade = new SessionCallbackFacade(null);
        facade.setCallback(callback);
        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state, parser, facade, historyAccess, (used, max) -> { }, 0, 0);

        for (String changedText : List.of("First line.Second line.", "First line. Second line.")) {
            JsonObject persisted = live.raw.deepCopy();
            persisted.addProperty("uuid", "assistant-uuid");
            persisted.getAsJsonObject("message").getAsJsonArray("content").get(0).getAsJsonObject()
                    .addProperty("text", changedText);
            historyAccess.messagesPage = createHistoryPage(List.of(user, persisted), 0, 1, 1, false, false);

            orchestrator.loadFromServer().join();

            assertEquals(2, state.getMessages().size());
            assertEquals("First line.\nSecond line.Final paragraph.", state.getMessages().get(1).content);
            assertFalse(state.getMessages().get(1).raw.has("uuid"));
            assertTrue(callback.messageUpdates.isEmpty());
            assertFalse(state.isLoading());
        }
    }

    /** CLI transcripts give each completed block its own UUID, even within one reply. */
    @Test
    public void loadFromServerWelcomesCliReplyBlocksPersistedAsSeparateRows() {
        for (String thinking : List.of("", "Consider both paragraphs.\nKeep their order.")) {
            SessionState state = new SessionState();
            state.setProvider("claude");
            state.setSessionId("session-cli-blocks");
            state.setCwd("/workspace");
            MessageParser parser = new MessageParser();
            JsonObject user = createProviderMessage("user", "prompt", "user-uuid");
            state.addMessage(parser.parseServerMessage(user));
            ClaudeSession.Message live = streamAssistantReply(state, thinking, "First line.\nSecond line.", "Final paragraph.");
            assertFalse(live.raw.has("uuid"));
            List<JsonObject> persisted = persistCliReplyBlocks(live, "msg-reply");
            List<JsonObject> page = new ArrayList<>(List.of(user));
            page.addAll(persisted);
            page.add(createProviderMessage("assistant", "New background report.", "report-uuid"));
            RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
            historyAccess.messagesPage = createHistoryPage(page, 0, 1, 1, false, false);
            RecordingCallback callback = new RecordingCallback();
            SessionCallbackFacade facade = new SessionCallbackFacade(null);
            facade.setCallback(callback);
            SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                    state, parser, facade, historyAccess, (used, max) -> { }, 0, 0);

            orchestrator.loadFromServer().join();

            assertEquals(page.size(), state.getMessages().size());
            for (int i = 0; i < persisted.size(); i++) {
                assertEquals(persisted.get(i), state.getMessages().get(i + 1).raw);
            }
            assertEquals("New background report.", state.getMessages().get(page.size() - 1).content);
            assertEquals(1, callback.messageUpdates.size());
            assertFalse(state.isLoading());
        }
    }

    /** A split reply is complete only after its thinking and every text row reach history. */
    @Test
    public void loadFromServerKeepsLiveReplyUntilEveryCliRowIsWritten() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-cli-partial-blocks");
        state.setCwd("/workspace");
        MessageParser parser = new MessageParser();
        JsonObject user = createProviderMessage("user", "prompt", "user-uuid");
        state.addMessage(parser.parseServerMessage(user));
        ClaudeSession.Message live = streamAssistantReply(state, "Complete thought.", "First paragraph.", "Final paragraph.");
        List<JsonObject> persisted = persistCliReplyBlocks(live, "msg-reply");
        JsonObject truncatedTail = persisted.get(2).deepCopy();
        truncatedTail.getAsJsonObject("message").getAsJsonArray("content").get(0).getAsJsonObject()
                .addProperty("text", "Final");
        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade facade = new SessionCallbackFacade(null);
        facade.setCallback(callback);
        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state, parser, facade, historyAccess, (used, max) -> { }, 0, 0);

        for (List<JsonObject> partialReply : List.of(persisted.subList(0, 1), persisted.subList(0, 2),
                persisted.subList(1, 3), List.of(persisted.get(0), persisted.get(2)),
                List.of(persisted.get(0), persisted.get(1), truncatedTail))) {
            List<JsonObject> page = new ArrayList<>(List.of(user));
            page.addAll(partialReply);
            historyAccess.messagesPage = createHistoryPage(page, 0, 1, 1, false, false);

            orchestrator.loadFromServer().join();

            assertEquals(2, state.getMessages().size());
            assertEquals("First paragraph.Final paragraph.", state.getMessages().get(1).content);
            assertFalse(state.getMessages().get(1).raw.has("uuid"));
            assertEquals("Complete thought.", state.getMessages().get(1).raw.getAsJsonObject("message")
                    .getAsJsonArray("content").get(0).getAsJsonObject().get("thinking").getAsString());
            assertTrue(callback.messageUpdates.isEmpty());
            assertFalse(state.isLoading());
        }

        List<JsonObject> completePage = new ArrayList<>(List.of(user));
        completePage.addAll(persisted);
        historyAccess.messagesPage = createHistoryPage(completePage, 0, 1, 1, false, false);
        orchestrator.loadFromServer().join();

        assertEquals(4, state.getMessages().size());
        assertEquals(persisted.get(2), state.getMessages().get(3).raw);
        assertEquals(1, callback.messageUpdates.size());
    }

    /** Automatic continuation changes reply IDs without starting another live streaming row. */
    @Test
    public void loadFromServerWelcomesCliContinuationWithinOneUserRequest() {
        for (boolean includesMetaPrompt : List.of(false, true)) {
            SessionState state = new SessionState();
            state.setProvider("claude");
            state.setSessionId("session-cli-continuation");
            state.setCwd("/workspace");
            MessageParser parser = new MessageParser();
            JsonObject user = createProviderMessage("user", "prompt", "user-uuid");
            state.addMessage(parser.parseServerMessage(user));
            ClaudeSession.Message live = streamAssistantReply(state, "Complete thought.", "First paragraph.", "Final paragraph.");
            List<JsonObject> persisted = persistCliReplyBlocks(live, "msg-reply");
            persisted.get(2).getAsJsonObject("message").addProperty("id", "msg-continuation");
            JsonObject truncatedTail = persisted.get(2).deepCopy();
            truncatedTail.getAsJsonObject("message").getAsJsonArray("content").get(0).getAsJsonObject()
                    .addProperty("text", "Final");
            List<JsonObject> prefix = new ArrayList<>(List.of(user,
                    createProviderMessage("assistant", "Earlier background report.", "earlier-report-uuid"),
                    persisted.get(0), persisted.get(1)));
            if (includesMetaPrompt) {
                JsonObject metaPrompt = createProviderMessage("user", "Output token limit hit. Resume directly.", "meta-uuid");
                metaPrompt.addProperty("isMeta", true);
                prefix.add(metaPrompt);
            }
            RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
            RecordingCallback callback = new RecordingCallback();
            SessionCallbackFacade facade = new SessionCallbackFacade(null);
            facade.setCallback(callback);
            SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                    state, parser, facade, historyAccess, (used, max) -> { }, 0, 0);

            for (List<JsonObject> tail : List.of(List.<JsonObject>of(), List.of(truncatedTail))) {
                List<JsonObject> page = new ArrayList<>(prefix);
                page.addAll(tail);
                historyAccess.messagesPage = createHistoryPage(page, 0, 2, 2, false, false);
                orchestrator.loadFromServer().join();

                assertEquals(List.of("prompt", "First paragraph.Final paragraph."),
                        state.getMessages().stream().map(message -> message.content).toList());
                assertFalse(state.getMessages().get(1).raw.has("uuid"));
                assertTrue(callback.messageUpdates.isEmpty());
                assertFalse(state.isLoading());
            }

            List<JsonObject> completePage = new ArrayList<>(prefix);
            completePage.add(persisted.get(2));
            completePage.add(createProviderMessage("assistant", "New background report.", "report-uuid"));
            historyAccess.messagesPage = createHistoryPage(completePage, 0, 2, 2, false, false);
            orchestrator.loadFromServer().join();

            assertEquals(6, state.getMessages().size());
            assertEquals("Earlier background report.", state.getMessages().get(1).content);
            for (int i = 0; i < persisted.size(); i++) {
                assertEquals(persisted.get(i), state.getMessages().get(i + 2).raw);
            }
            assertEquals("New background report.", state.getMessages().get(5).content);
            assertEquals(1, callback.messageUpdates.size());
            assertFalse(state.isLoading());
        }
    }

    /** A user prompt starts another live request, even when reply IDs happen to agree. */
    @Test
    public void loadFromServerRefusesToBorrowCliTextAcrossUserRequests() {
        for (boolean sameReplyId : List.of(false, true)) {
            SessionState state = new SessionState();
            state.setProvider("claude");
            state.setSessionId("session-cli-unrelated-replies");
            state.setCwd("/workspace");
            MessageParser parser = new MessageParser();
            JsonObject user = createProviderMessage("user", "prompt", "user-uuid");
            state.addMessage(parser.parseServerMessage(user));
            ClaudeSession.Message live = streamAssistantText(state, "First paragraph.", "Final paragraph.");
            List<JsonObject> persisted = persistCliReplyBlocks(live, "msg-reply");
            List<JsonObject> page = new ArrayList<>(List.of(user, persisted.get(0)));
            page.add(createProviderMessage("user", "Next prompt.", "next-user-uuid"));
            if (!sameReplyId) {
                persisted.get(1).getAsJsonObject("message").addProperty("id", "msg-other-reply");
            }
            // Repeated wording in a later request must not stand in for the missing live reply.
            JsonObject repeatedOpening = persisted.get(0).deepCopy();
            repeatedOpening.addProperty("uuid", "next-reply-opening");
            repeatedOpening.getAsJsonObject("message").addProperty("id",
                    persisted.get(1).getAsJsonObject("message").get("id").getAsString());
            page.add(repeatedOpening);
            page.add(persisted.get(1));
            RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
            historyAccess.messagesPage = createHistoryPage(page, 0, 1, 1, false, false);
            RecordingCallback callback = new RecordingCallback();
            SessionCallbackFacade facade = new SessionCallbackFacade(null);
            facade.setCallback(callback);
            SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                    state, parser, facade, historyAccess, (used, max) -> { }, 0, 0);

            orchestrator.loadFromServer().join();

            assertEquals(2, state.getMessages().size());
            assertEquals("First paragraph.Final paragraph.", state.getMessages().get(1).content);
            assertFalse(state.getMessages().get(1).raw.has("uuid"));
            assertTrue(callback.messageUpdates.isEmpty());
            assertFalse(state.isLoading());
        }
    }

    private static List<JsonObject> persistCliReplyBlocks(ClaudeSession.Message live, String replyId) {
        List<JsonObject> rows = new ArrayList<>();
        for (JsonElement block : live.raw.getAsJsonObject("message").getAsJsonArray("content")) {
            JsonObject row = live.raw.deepCopy();
            row.addProperty("uuid", replyId + "-block-" + rows.size());
            JsonObject message = row.getAsJsonObject("message");
            message.addProperty("id", replyId);
            JsonArray content = new JsonArray();
            content.add(block.deepCopy());
            message.add("content", content);
            rows.add(row);
        }
        return rows;
    }

    private static ClaudeSession.Message streamAssistantText(SessionState state, String... blocks) {
        return streamAssistantReply(state, "", blocks);
    }

    private static ClaudeSession.Message streamAssistantReply(SessionState state, String thinking, String... blocks) {
        ClaudeMessageHandler handler = new ClaudeMessageHandler(null, state, new CallbackHandler(),
                new MessageParser(), new MessageMerger(), new Gson());
        handler.onMessage("stream_start", "");
        if (!thinking.isEmpty()) {
            handler.onMessage("block_reset", "");
            handler.onMessage("thinking_delta", thinking);
        }
        for (String block : blocks) {
            handler.onMessage("block_reset", "");
            handler.onMessage("content_delta", block);
        }
        handler.onMessage("stream_end", "");
        List<ClaudeSession.Message> messages = state.getMessages();
        return messages.get(messages.size() - 1);
    }

    /**
     * A first-row anchor can replace duplicate synthetic bubbles too.
     */
    @Test
    public void loadFromServerReconcilesSyntheticRowsAfterTheFirstLiveAnchor() {
        for (boolean includesOlderHistory : List.of(false, true)) {
            SessionState state = new SessionState();
            state.setProvider("claude");
            state.setSessionId("session-first-anchor");
            state.setCwd("/workspace");
            state.addMessage(liveUuidBackedToolResult("uuid-tr", "tool"));
            state.addMessage(liveSynthesizedToolResult("tool"));
            state.addMessage(liveSynthesizedAssistant("answer"));
            RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
            List<JsonObject> pageMessages = new ArrayList<>();
            if (includesOlderHistory) {
                pageMessages.add(createProviderMessage("user", "older prompt", "uuid-older"));
            }
            pageMessages.addAll(List.of(
                    providerToolResultMessage("uuid-tr", "tool"),
                    createProviderMessage("assistant", "answer", "uuid-answer")));
            historyAccess.messagesPage = createHistoryPage(pageMessages, 2, 3, 3, true, false);
            RecordingCallback callback = new RecordingCallback();
            SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
            callbackFacade.setCallback(callback);
            SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                    state, new MessageParser(), callbackFacade, historyAccess,
                    (used, max) -> { }, 0, 0);

            orchestrator.loadFromServer().join();

            assertEquals(includesOlderHistory ? 3 : 2, state.getMessages().size());
            if (includesOlderHistory) {
                assertEquals("older prompt", state.getMessages().get(0).content);
            }
            assertEquals("answer", state.getMessages().get(state.getMessages().size() - 1).content);
            assertEquals(List.of("session-first-anchor|2|3|true|false|null"), callback.claudeHistoryPageInfos);
        }
    }

    /** Protect thinking that has not reached history without blocking a complete persisted reply. */
    @Test
    public void loadFromServerProtectsUuidlessThinkingUntilTheWriterCatchesUp() {
        for (String persistedThinking : List.of("", "latest", "latest complete thought")) {
            SessionState state = new SessionState();
            state.setProvider("claude");
            state.setSessionId("session-unwritten-thinking");
            state.setCwd("/workspace");
            state.addMessage(liveMessage(ClaudeSession.Message.Type.USER, "prompt", 1));
            state.addMessage(liveMessage(ClaudeSession.Message.Type.ASSISTANT, "anchor", 1));
            ClaudeSession.Message liveThinking = liveSynthesizedAssistant("");
            JsonObject thinking = new JsonObject();
            thinking.addProperty("type", "thinking");
            thinking.addProperty("thinking", "latest complete thought");
            liveThinking.raw.getAsJsonObject("message").getAsJsonArray("content").add(thinking);
            state.addMessage(liveThinking);

            JsonObject persisted = createProviderMessage("assistant", "", "persisted-thinking");
            JsonObject persistedBlock = thinking.deepCopy();
            persistedBlock.addProperty("thinking", persistedThinking);
            persisted.getAsJsonObject("message").getAsJsonArray("content").add(persistedBlock);
            RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
            historyAccess.messagesPage = createHistoryPage(List.of(
                    createProviderMessage("user", "prompt", "uuid-1-user"),
                    createProviderMessage("assistant", "anchor", "uuid-1-assistant"), persisted), 0, 1, 1, false, false);
            SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                    state, new MessageParser(), new SessionCallbackFacade(null), historyAccess,
                    (used, max) -> { }, 0, 0);

            orchestrator.loadFromServer().join();

            assertEquals(3, state.getMessages().size());
            ClaudeSession.Message tail = state.getMessages().get(2);
            assertEquals("latest complete thought", tail.raw.getAsJsonObject("message").getAsJsonArray("content")
                    .get(1).getAsJsonObject().get("thinking").getAsString());
            assertEquals(persistedThinking.equals("latest complete thought"), tail.raw.has("uuid"));
        }
    }

    /**
     * The [MESSAGE]-path tool_result bubble: SDK-echoed, so the raw carries the
     * uuid the JSONL row holds.
     */
    private static ClaudeSession.Message liveUuidBackedToolResult(String uuid, String toolUseId) {
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_result");
        block.addProperty("tool_use_id", toolUseId);
        block.addProperty("content", "background output");

        JsonArray content = new JsonArray();
        content.add(block);
        JsonObject message = new JsonObject();
        message.add("content", content);
        JsonObject raw = new JsonObject();
        raw.addProperty("type", "user");
        raw.addProperty("uuid", uuid);
        raw.add("message", message);
        return new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "[tool_result]", raw);
    }

    @Test
    public void loadFromServerPreservesANewLiveRowAddedWhileReading() throws Exception {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-live-append");
        state.setCwd("/workspace");
        state.addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "before"));

        CountDownLatch historyRead = new CountDownLatch(1);
        CountDownLatch releaseHistory = new CountDownLatch(1);
        SessionMessageOrchestrator.SessionHistoryAccess historyAccess = new SessionMessageOrchestrator.SessionHistoryAccess() {
            @Override
            public List<JsonObject> getProviderSessionMessages(String provider, String sessionId, String cwd) {
                historyRead.countDown();
                try {
                    assertTrue(releaseHistory.await(5, TimeUnit.SECONDS));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return List.of(
                        createProviderMessage("user", "before"),
                        createProviderMessage("assistant", "answer"));
            }

            @Override
            public JsonObject getLatestClaudeUserMessage(String sessionId, String cwd) {
                return null;
            }
        };
        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);
        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        var load = orchestrator.loadFromServer();
        assertTrue(historyRead.await(5, TimeUnit.SECONDS));
        // A read that started earlier cannot account for a newly submitted row.
        state.addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "live append"));
        releaseHistory.countDown();
        load.join();

        assertEquals(List.of("before", "live append"),
                state.getMessages().stream().map(message -> message.content).toList());
        assertFalse("the load must clear the loading flag it claimed", state.isLoading());
        assertTrue(callback.stateChanges.contains("false:false:null"));
    }

    @Test
    public void loadFromServerStillClearsLoadingWhenTheSessionChangesUnderIt() throws Exception {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-switched-away");
        state.setCwd("/workspace");

        CountDownLatch historyRead = new CountDownLatch(1);
        CountDownLatch releaseHistory = new CountDownLatch(1);
        SessionMessageOrchestrator.SessionHistoryAccess historyAccess = new SessionMessageOrchestrator.SessionHistoryAccess() {
            @Override
            public List<JsonObject> getProviderSessionMessages(String provider, String sessionId, String cwd) {
                historyRead.countDown();
                try {
                    assertTrue(releaseHistory.await(5, TimeUnit.SECONDS));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return List.of(createProviderMessage("assistant", "for the old session"));
            }

            @Override
            public JsonObject getLatestClaudeUserMessage(String sessionId, String cwd) {
                return null;
            }
        };
        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                new SessionCallbackFacade(null),
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        var load = orchestrator.loadFromServer();
        assertTrue(historyRead.await(5, TimeUnit.SECONDS));
        state.setSessionId("session-opened-instead");
        releaseHistory.countDown();
        load.join();

        // The result is discarded, but the spinner it started must not be left
        // behind: nothing else will clear it.
        assertFalse(state.isLoading());
    }

    /**
     * Verifies history recovery prefers the context window retained in provider usage
     * metadata and forwards it through the session callback.
     */
    @Test
    public void loadFromServerRestoresProviderReportedContextWindow() {
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.setModel("gpt-5.6-sol");
        state.setSessionId("session-codex-usage");
        state.setCwd("/workspace");

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);
        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        JsonObject assistant = createProviderMessage("assistant", "Recovered answer");
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 12000);
        usage.addProperty("output_tokens", 345);
        usage.addProperty("model_context_window", 258400);
        assistant.getAsJsonObject("message").add("usage", usage);
        historyAccess.providerHistory = List.of(assistant);

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                null, state, new MessageParser(), callbackFacade, historyAccess);

        orchestrator.loadFromServer().join();

        assertEquals(List.of("12000:258400"), callback.usageUpdates);
    }

    /**
     * Verifies providers without session-specific capacity retain the existing static
     * model-limit fallback when a real usage numerator is present.
     */
    @Test
    public void loadFromServerFallsBackToStaticModelContextWindow() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setModel("claude-sonnet-4-6");
        state.setSessionId("session-claude-usage");
        state.setCwd("/workspace");

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);
        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        JsonObject assistant = createProviderMessage("assistant", "Recovered answer");
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 12000);
        usage.addProperty("output_tokens", 345);
        assistant.getAsJsonObject("message").add("usage", usage);
        historyAccess.providerHistory = List.of(assistant);

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                null, state, new MessageParser(), callbackFacade, historyAccess);

        orchestrator.loadFromServer().join();

        assertEquals(List.of("12000:200000"), callback.usageUpdates);
    }

    /**
     * Verifies history without provider usage does not publish a synthetic zero/static
     * snapshot before trusted metadata becomes available.
     */
    @Test
    public void loadFromServerDoesNotPublishSyntheticUsageWithoutProviderSnapshot() {
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.setModel("gpt-5.6-sol");
        state.setSessionId("session-without-usage");
        state.setCwd("/workspace");

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);
        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.providerHistory = List.of(
                createProviderMessage("assistant", "Recovered answer without usage"));

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                null, state, new MessageParser(), callbackFacade, historyAccess);

        orchestrator.loadFromServer().join();

        assertTrue(callback.usageUpdates.isEmpty());
    }

    @Test
    public void loadFromServerPreservesNormalizedCodexToolBlocks() {
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.setSessionId("session-codex-tools");
        state.setCwd("/workspace");

        JsonObject toolUse = new JsonObject();
        toolUse.addProperty("type", "tool_use");
        toolUse.addProperty("id", "call-1");
        toolUse.addProperty("name", "glob");
        JsonObject input = new JsonObject();
        input.addProperty("command", "rg TODO");
        toolUse.add("input", input);

        JsonArray rawContent = new JsonArray();
        rawContent.add(toolUse);
        JsonObject normalizedRaw = new JsonObject();
        normalizedRaw.add("content", rawContent);
        normalizedRaw.addProperty("role", "assistant");

        JsonObject envelope = new JsonObject();
        envelope.addProperty("type", "assistant");
        envelope.addProperty("content", "Tool: glob");
        envelope.add("raw", normalizedRaw);

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.providerHistory = List.of(envelope);
        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                new SessionCallbackFacade(null),
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.loadFromServer().join();

        assertEquals(1, state.getMessages().size());
        ClaudeSession.Message restored = state.getMessages().get(0);
        assertEquals("Tool: glob", restored.content);
        assertFalse(restored.raw.has("raw"));
        assertEquals("tool_use", restored.raw.getAsJsonArray("content")
                .get(0).getAsJsonObject().get("type").getAsString());
    }

    @Test
    public void syncUserMessageUuidsShortCircuitsForCodexProvider() {
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.setSessionId("session-3");

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.syncUserMessageUuidsAfterSend().join();

        assertEquals(0, historyAccess.latestClaudeUserMessageRequests.get());
    }

    @Test
    public void loadFromServerSetsErrorWhenHistoryAccessThrows() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setModel("claude-sonnet-4-6");
        state.setSessionId("session-4");
        state.setCwd("/workspace");

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);

        SessionMessageOrchestrator.SessionHistoryAccess failingAccess =
                new SessionMessageOrchestrator.SessionHistoryAccess() {
                    @Override
                    public List<JsonObject> getProviderSessionMessages(String provider, String sessionId, String cwd) {
                        throw new RuntimeException("connection refused");
                    }

                    @Override
                    public JsonObject getLatestClaudeUserMessage(String sessionId, String cwd) {
                        return null;
                    }
                };

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                failingAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        // LOG.error() in IntelliJ test framework throws AssertionError,
        // which causes the CompletableFuture to complete exceptionally.
        try {
            orchestrator.loadFromServer().join();
        } catch (Exception ignored) {
            // Expected: LOG.error inside catch block triggers AssertionError in test logger
        }

        assertFalse(state.isLoading());
        assertEquals("connection refused", state.getError());
        assertTrue(callback.stateChanges.contains("false:false:connection refused"));
    }

    @Test
    public void loadFromServerReturnsImmediatelyWhenNoSessionId() {
        SessionState state = new SessionState();
        // sessionId is null by default

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.loadFromServer().join();

        assertEquals(0, historyAccess.providerHistoryRequests.get());
        assertFalse(state.isLoading());
        assertNull(state.getError());
    }

    @Test
    public void extractMessageContentForMatchingHandlesStringContent() {
        SessionState state = new SessionState();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        // String content format
        JsonObject message = new JsonObject();
        message.addProperty("content", "hello world");
        JsonObject msg = new JsonObject();
        msg.add("message", message);

        assertEquals("hello world", orchestrator.extractMessageContentForMatching(msg));

        // Missing message field
        assertNull(orchestrator.extractMessageContentForMatching(new JsonObject()));

        // Missing content field
        JsonObject emptyMessage = new JsonObject();
        JsonObject msgWithEmptyMessage = new JsonObject();
        msgWithEmptyMessage.add("message", emptyMessage);
        assertNull(orchestrator.extractMessageContentForMatching(msgWithEmptyMessage));
    }

    private JsonObject createHistoryUserMessage(String uuid, String text) {
        JsonObject contentBlock = new JsonObject();
        contentBlock.addProperty("type", "text");
        contentBlock.addProperty("text", text);

        JsonArray content = new JsonArray();
        content.add(contentBlock);

        JsonObject message = new JsonObject();
        message.add("content", content);

        JsonObject historyMessage = new JsonObject();
        historyMessage.addProperty("type", "user");
        historyMessage.addProperty("uuid", uuid);
        historyMessage.add("message", message);
        return historyMessage;
    }

    private JsonObject createProviderMessage(String type, String text) {
        return createProviderMessage(type, text, null);
    }

    private JsonObject createProviderMessage(String type, String text, String uuid) {
        JsonObject contentBlock = new JsonObject();
        contentBlock.addProperty("type", "text");
        contentBlock.addProperty("text", text);

        JsonArray content = new JsonArray();
        content.add(contentBlock);

        JsonObject message = new JsonObject();
        message.add("content", content);

        JsonObject serverMessage = new JsonObject();
        serverMessage.addProperty("type", type);
        serverMessage.add("message", message);
        if (uuid != null) {
            serverMessage.addProperty("uuid", uuid);
        }
        return serverMessage;
    }

    @Test
    public void olderHistoryReadCannotOverwriteTheNewerResult() throws Exception {
        for (boolean missing : List.of(false, true)) {
            SessionState state = new SessionState();
            state.setSessionId("session-race");
            CountDownLatch firstRead = new CountDownLatch(1);
            CountDownLatch releaseFirst = new CountDownLatch(1);
            AtomicInteger reads = new AtomicInteger();
            SessionMessageOrchestrator.SessionHistoryAccess access = new SessionMessageOrchestrator.SessionHistoryAccess() {
                @Override
                public List<JsonObject> getProviderSessionMessages(String provider, String sessionId, String cwd) {
                    if (reads.incrementAndGet() == 1) {
                        firstRead.countDown();
                        try {
                            assertTrue(releaseFirst.await(5, TimeUnit.SECONDS));
                        } catch (InterruptedException e) {
                            throw new AssertionError(e);
                        }
                        if (missing) {
                            throw new SessionHistoryNotFoundException(sessionId, cwd);
                        }
                        return List.of(createProviderMessage("assistant", "older answer"));
                    }
                    return List.of(createProviderMessage("assistant", "newer answer"));
                }

                @Override
                public JsonObject getLatestClaudeUserMessage(String sessionId, String cwd) {
                    return null;
                }
            };
            SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(state,
                    new MessageParser(), new SessionCallbackFacade(null), access, (used, max) -> { }, 0, 0);
            var first = orchestrator.loadFromServer();
            try {
                assertTrue(firstRead.await(5, TimeUnit.SECONDS));
                orchestrator.loadFromServer().join();
            } finally {
                releaseFirst.countDown();
            }
            first.join();
            assertEquals("session-race", state.getSessionId());
            assertEquals("newer answer", state.getMessages().get(0).content);
            assertFalse(state.isLoading());
        }
    }

    @Test
    public void loadingReleaseCannotClearAnotherOperationsClaim() {
        SessionState state = new SessionState();
        Object first = new Object();
        Object second = new Object();
        state.claimLoading(first);
        state.claimLoading(second);
        assertFalse(state.releaseLoading(first));
        assertTrue(state.isLoading());
        assertTrue(state.releaseLoading(second));
        assertFalse(state.isLoading());
    }

    @Test
    public void historyAcceptsNormalizedToolPayloadsThatSerializeToFewerCharacters() {
        SessionState state = new SessionState();
        state.setSessionId("normalized-tool");
        JsonObject history = createProviderMessage("assistant", "done");
        JsonObject tool = new JsonObject();
        tool.addProperty("type", "tool_use");
        tool.addProperty("id", "tool-1");
        tool.addProperty("name", "Bash");
        history.getAsJsonObject("message").getAsJsonArray("content").add(tool);
        JsonObject live = history.deepCopy();
        live.getAsJsonObject("message").getAsJsonArray("content").get(1).getAsJsonObject()
                .addProperty("presentation", "metadata omitted by persistence");
        state.addMessage(new MessageParser().parseServerMessage(live));
        RecordingHistoryAccess access = new RecordingHistoryAccess();
        access.providerHistory = List.of(history);
        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(state,
                new MessageParser(), new SessionCallbackFacade(null), access, (used, max) -> { }, 0, 0);
        orchestrator.loadFromServer().join();
        assertFalse(state.getMessages().get(0).raw.getAsJsonObject("message")
                .getAsJsonArray("content").get(1).getAsJsonObject().has("presentation"));
    }

    @Test
    public void loadEarlierClaudeHistoryPagePrependsOlderTurns() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-page");
        state.setCwd("/workspace");
        state.addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "newer question", new JsonObject()));

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.messagesPage = createHistoryPage(
                List.of(createProviderMessage("user", "older question"),
                        createProviderMessage("assistant", "older answer")),
                0, 2, 4, true, false, "Renamed in CLI");

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state, new MessageParser(), callbackFacade, historyAccess, (used, max) -> { }, 0, 0);

        orchestrator.loadEarlierClaudeHistoryPage("session-page", "/workspace", 2).join();

        List<ClaudeSession.Message> messages = state.getMessages();
        assertEquals(3, messages.size());
        assertEquals("older question", messages.get(0).content);
        assertEquals("older answer", messages.get(1).content);
        assertEquals("newer question", messages.get(2).content);
        assertEquals(List.of("session-page|0|4|true|false|Renamed in CLI"), callback.claudeHistoryPageInfos);
        assertTrue(callback.claudeHistoryPageErrors.isEmpty());
    }

    @Test
    public void loadEarlierClaudeHistoryPageReplacesTranscriptOnCursorReset() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-page");
        state.setCwd("/workspace");
        state.addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "live question", new JsonObject()));

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);

        // The server rejected the stale cursor and answered with the LATEST page:
        // prepending it would duplicate every live message, so the transcript
        // must be replaced instead.
        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.messagesPage = createHistoryPage(
                List.of(createProviderMessage("user", "live question"),
                        createProviderMessage("assistant", "live answer")),
                0, 2, 2, false, true);

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state, new MessageParser(), callbackFacade, historyAccess, (used, max) -> { }, 0, 0);

        orchestrator.loadEarlierClaudeHistoryPage("session-page", "/workspace", 99).join();

        List<ClaudeSession.Message> messages = state.getMessages();
        assertEquals(2, messages.size());
        assertEquals("live question", messages.get(0).content);
        assertEquals("live answer", messages.get(1).content);
        assertEquals(List.of("session-page|0|2|false|true|null"), callback.claudeHistoryPageInfos);
    }

    @Test
    public void loadEarlierClaudeHistoryPageNotifiesErrorWhenQueryFails() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-page");
        state.setCwd("/workspace");
        state.addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "live question", new JsonObject()));

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);

        // messagesPage stays null: the bridge query failed.
        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state, new MessageParser(), callbackFacade, historyAccess, (used, max) -> { }, 0, 0);

        orchestrator.loadEarlierClaudeHistoryPage("session-page", "/workspace", 2).join();

        assertEquals(1, state.getMessages().size());
        assertEquals(1, callback.claudeHistoryPageErrors.size());
        assertTrue(callback.claudeHistoryPageErrors.get(0).startsWith("session-page|"));
        assertTrue(callback.claudeHistoryPageInfos.isEmpty());
    }

    private static JsonObject createHistoryPage(List<JsonObject> messages, int fromTurn, int toTurn,
                                                int totalTurns, boolean hasMore, boolean cursorReset) {
        return createHistoryPage(messages, fromTurn, toTurn, totalTurns, hasMore, cursorReset, null);
    }

    private static JsonObject createHistoryPage(List<JsonObject> messages, int fromTurn, int toTurn,
                                                int totalTurns, boolean hasMore, boolean cursorReset, String sessionTitle) {
        JsonObject page = new JsonObject();
        page.addProperty("success", true);
        JsonArray array = new JsonArray();
        for (JsonObject message : messages) {
            array.add(message);
        }
        page.add("messages", array);
        page.addProperty("fromTurn", fromTurn);
        page.addProperty("toTurn", toTurn);
        page.addProperty("totalTurns", totalTurns);
        page.addProperty("hasMore", hasMore);
        page.addProperty("cursorReset", cursorReset);
        if (sessionTitle != null) {
            page.addProperty("sessionTitle", sessionTitle);
        }
        return page;
    }

    private static final class RecordingHistoryAccess implements SessionMessageOrchestrator.SessionHistoryAccess {
        private final AtomicInteger providerHistoryRequests = new AtomicInteger();
        private final AtomicInteger latestClaudeUserMessageRequests = new AtomicInteger();
        private List<JsonObject> providerHistory = List.of();
        private RuntimeException providerHistoryFailure;
        private JsonObject latestClaudeUserMessage;
        private JsonObject messagesPage;

        @Override
        public List<JsonObject> getProviderSessionMessages(String provider, String sessionId, String cwd) {
            providerHistoryRequests.incrementAndGet();
            if (providerHistoryFailure != null) {
                throw providerHistoryFailure;
            }
            return providerHistory;
        }

        @Override
        public JsonObject getLatestClaudeUserMessage(String sessionId, String cwd) {
            latestClaudeUserMessageRequests.incrementAndGet();
            return latestClaudeUserMessage;
        }

        @Override
        public JsonObject getProviderSessionMessagesPage(String sessionId, String cwd, Integer beforeTurn, int limit) {
            return messagesPage;
        }
    }

    private static final class RecordingCallback implements ClaudeSession.SessionCallback {
        private final List<List<ClaudeSession.Message>> messageUpdates = new ArrayList<>();
        private final List<String> stateChanges = new ArrayList<>();
        private final List<String> messageUuidPatches = new ArrayList<>();
        private final List<String> usageUpdates = new ArrayList<>();
        private final List<String> claudeHistoryPageInfos = new ArrayList<>();
        private final List<String> claudeHistoryPageErrors = new ArrayList<>();

        @Override
        public void onMessageUpdate(List<ClaudeSession.Message> messages) {
            messageUpdates.add(messages);
        }

        @Override
        public void onStateChange(boolean busy, boolean loading, String error) {
            stateChanges.add(busy + ":" + loading + ":" + error);
        }

        @Override
        public void onUsageUpdate(int usedTokens, int maxTokens) {
            usageUpdates.add(usedTokens + ":" + maxTokens);
        }

        @Override
        public void onUserMessageUuidPatched(String content, String uuid) {
            messageUuidPatches.add(content + "|" + uuid);
        }

        @Override
        public void onClaudeHistoryPageInfo(String sessionId, int fromTurn, int totalTurns, boolean hasMore, boolean cursorReset, String sessionTitle) {
            claudeHistoryPageInfos.add(sessionId + "|" + fromTurn + "|" + totalTurns + "|" + hasMore + "|" + cursorReset + "|" + sessionTitle);
        }

        @Override
        public void onClaudeHistoryPageError(String sessionId, String message) {
            claudeHistoryPageErrors.add(sessionId + "|" + message);
        }

        @Override
        public void onSessionIdReceived(String sessionId) {
        }

        @Override
        public void onPermissionRequested(PermissionRequest request) {
        }

        @Override
        public void onThinkingStatusChanged(boolean isThinking) {
        }

        @Override
        public void onSlashCommandsReceived(List<String> slashCommands) {
        }

        @Override
        public void onNodeLog(String log) {
        }

        @Override
        public void onSummaryReceived(String summary) {
        }
    }
}
