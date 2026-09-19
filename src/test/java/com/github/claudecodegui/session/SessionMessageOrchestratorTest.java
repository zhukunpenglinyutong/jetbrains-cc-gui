package com.github.claudecodegui.session;

import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.provider.common.SessionHistoryNotFoundException;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

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
                0, 2, 4, true, false);

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state, new MessageParser(), callbackFacade, historyAccess, (used, max) -> { }, 0, 0);

        orchestrator.loadEarlierClaudeHistoryPage("session-page", "/workspace", 2).join();

        List<ClaudeSession.Message> messages = state.getMessages();
        assertEquals(3, messages.size());
        assertEquals("older question", messages.get(0).content);
        assertEquals("older answer", messages.get(1).content);
        assertEquals("newer question", messages.get(2).content);
        assertEquals(List.of("session-page|0|4|true|false"), callback.claudeHistoryPageInfos);
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
        assertEquals(List.of("session-page|0|2|false|true"), callback.claudeHistoryPageInfos);
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
        public void onClaudeHistoryPageInfo(String sessionId, int fromTurn, int totalTurns, boolean hasMore, boolean cursorReset) {
            claudeHistoryPageInfos.add(sessionId + "|" + fromTurn + "|" + totalTurns + "|" + hasMore + "|" + cursorReset);
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
