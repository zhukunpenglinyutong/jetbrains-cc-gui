package com.github.claudecodegui.handler;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.io.IOException;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class CodexStorageDeletionTest {
    @Test
    public void storageHandlerDoesNotClaimEitherLegacyHistoryAction() {
        CodexStorageHandler handler = new CodexStorageHandler(null);
        assertFalse(handler.handle("delete_session", "legacy-session"));
        assertFalse(handler.handle("delete_sessions", "[\"legacy-session\"]"));
        assertTrue(Arrays.asList(CodexStorageHandler.TYPES).contains("delete_ai_storage_sessions"));
    }

    @Test
    public void storageDeletionRejectsTheRunningTargetWithoutInterruptingIt() {
        RecordingSession session = new RecordingSession("target", "codex", true);
        IOException error = assertThrows(IOException.class, () -> CodexStorageHandler.requireIdleSession(session, List.of("target")));
        assertEquals("SESSION_RUNNING", error.getMessage());
        assertFalse(session.interrupted);
    }

    @Test
    public void idleAndUnrelatedSessionsDoNotBlockStorageDeletion() throws Exception {
        CodexStorageHandler.requireIdleSession(null, List.of("target"));
        CodexStorageHandler.requireIdleSession(new RecordingSession("target", "codex", false), List.of("target"));
        CodexStorageHandler.requireIdleSession(new RecordingSession("other", "codex", true), List.of("target"));
        CodexStorageHandler.requireIdleSession(new RecordingSession("target", "claude", true), List.of("target"));
    }

    @Test
    public void historyOriginIsExplicitAndInvalidOriginsCannotSelectTheScopedPath() throws Exception {
        assertFalse(CodexStorageHandler.historyDeletionRequested(new JsonObject()));
        assertFalse(CodexStorageHandler.historyDeletionRequested(JsonParser.parseString("{\"origin\":\"storage\"}").getAsJsonObject()));
        assertTrue(CodexStorageHandler.historyDeletionRequested(JsonParser.parseString("{\"origin\":\"history\"}").getAsJsonObject()));
        for (String value : List.of("null", "true", "1", "{}", "[]", "\"unknown\"")) {
            IOException error = assertThrows(IOException.class, () -> CodexStorageHandler.historyDeletionRequested(
                    JsonParser.parseString("{\"origin\":" + value + "}").getAsJsonObject()));
            assertEquals("INVALID_STORAGE_REQUEST", error.getMessage());
        }
    }

    @Test
    public void invalidOperationIdentityCannotReleaseAnIdleNativeOwner() {
        var bridge = new HoldingReleaseBridge();
        try {
            var request = JsonParser.parseString(
                    "{\"origin\":\"history\",\"operationId\":\"invalid\",\"sessionIds\":[\"target\"]}").getAsJsonObject();
            var error = assertThrows(IOException.class, () -> CodexStorageHandler.deleteSessionData(
                    request, null, new RecordingSession("target", "codex", false), bridge));
            assertEquals("INVALID_STORAGE_REQUEST", error.getMessage());
            assertEquals(null, bridge.releasedId);
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void historyDeletionWaitsForTheIdleNativeOwnerToReleaseWithoutSendingAnInterrupt() throws Exception {
        var bridge = new HoldingReleaseBridge();
        try {
            var session = new RecordingSession("target", "codex", false);
            AtomicBoolean deletionStarted = new AtomicBoolean();
            var deletion = CodexStorageHandler.releaseIdleHistorySession(session, List.of("target"), bridge)
                    .thenRun(() -> deletionStarted.set(true));
            assertEquals("target", bridge.releasedId);
            assertFalse(session.interrupted);
            assertFalse(deletion.isDone());
            assertFalse(deletionStarted.get());
            bridge.release.complete(new JsonObject());
            deletion.join();
            assertTrue(deletionStarted.get());
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void historyDeletionDoesNotReleaseARunningOrUnrelatedOwner() throws Exception {
        var bridge = new HoldingReleaseBridge();
        try {
            assertThrows(IOException.class, () -> CodexStorageHandler.releaseIdleHistorySession(
                    new RecordingSession("target", "codex", true), List.of("target"), bridge));
            CodexStorageHandler.releaseIdleHistorySession(new RecordingSession("other", "codex", true), List.of("target"), bridge).join();
            CodexStorageHandler.releaseIdleHistorySession(new RecordingSession("target", "claude", false), List.of("target"), bridge).join();
            assertEquals(null, bridge.releasedId);
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void rejectedNativeReleaseCannotStartHistoryDeletion() throws Exception {
        var bridge = new HoldingReleaseBridge();
        try {
            AtomicBoolean deletionStarted = new AtomicBoolean();
            var deletion = CodexStorageHandler.releaseIdleHistorySession(
                    new RecordingSession("target", "codex", false), List.of("target"), bridge)
                    .thenRun(() -> deletionStarted.set(true));
            JsonObject failure = new JsonObject();
            failure.addProperty("error", "fixture release failed");
            bridge.release.complete(failure);
            assertThrows(java.util.concurrent.CompletionException.class, deletion::join);
            assertFalse(deletionStarted.get());
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void anExceptionalNativeBusyRefusalIsNormalizedBeforeAnyDeletion() throws Exception {
        var bridge = new HoldingReleaseBridge();
        try {
            AtomicBoolean deletionStarted = new AtomicBoolean();
            var session = new RecordingSession("target", "codex", false);
            var deletion = CodexStorageHandler.releaseIdleHistorySession(session, List.of("target"), bridge)
                    .thenRun(() -> deletionStarted.set(true));
            var nativeFailure = new RuntimeException("Codex session has pending work and cannot be deleted");
            bridge.release.completeExceptionally(nativeFailure);
            var error = assertThrows(java.util.concurrent.CompletionException.class, deletion::join);
            assertTrue(error.getCause() instanceof IOException);
            assertEquals("SESSION_RUNNING", error.getCause().getMessage());
            assertEquals(nativeFailure, error.getCause().getCause());
            assertEquals("SESSION_RUNNING", com.github.claudecodegui.storage.CodexStorageMaintenance.errorCode(error));
            assertFalse(deletionStarted.get());
            assertFalse(session.interrupted);
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void anIdleReadOnlyViewCannotUnloadAnUnknownNativeWriter() throws Exception {
        var bridge = new HoldingReleaseBridge();
        bridge.owned = false;
        try {
            CodexStorageHandler.releaseIdleHistorySession(new RecordingSession("target", "codex", false), List.of("target"), bridge).join();
            assertEquals(null, bridge.releasedId);
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void bothStorageAndHistoryDeletionWaitForAnIdleNativeRelease() {
        for (String origin : List.of("storage", "history")) {
            var bridge = new HoldingReleaseBridge();
            try {
                JsonObject failure = new JsonObject();
                failure.addProperty("error", "SESSION_RUNNING");
                bridge.release.complete(failure);
                var session = new RecordingSession("target", "codex", false);
                var request = new JsonObject();
                request.addProperty("origin", origin);
                request.addProperty("operationId", java.util.UUID.randomUUID().toString());
                request.add("sessionIds", JsonParser.parseString("[\"target\"]"));
                var error = assertThrows(java.util.concurrent.CompletionException.class,
                        () -> CodexStorageHandler.deleteSessionData(request, null, session, bridge));
                assertEquals("SESSION_RUNNING", error.getCause().getMessage());
                assertEquals("target", bridge.releasedId);
                assertFalse(session.interrupted);
            } finally {
                bridge.cleanupAllProcesses();
            }
        }
    }

    @Test
    public void anOwnedQuestionCannotBeUnloadedEvenWhenTheVisibleBusyFlagHasCleared() {
        var bridge = new HoldingReleaseBridge();
        var session = new RecordingSession("target", "codex", false);
        var state = session.getState();
        state.setProvider("codex");
        state.setRestoredSessionId("target");
        state.beginTurn();
        state.setBusy(false);
        var answer = new CompletableFuture<Void>();
        var execution = state.getExecutionState();
        execution.bindInteraction(execution.currentTurn(), com.github.claudecodegui.session.SessionExecutionState.WaitReason.QUESTION, answer);
        try {
            var error = assertThrows(IOException.class, () -> CodexStorageHandler.releaseIdleHistorySession(session, List.of("target"), bridge));
            assertEquals("SESSION_RUNNING", error.getMessage());
            assertEquals(null, bridge.releasedId);
            assertFalse(session.interrupted);
        } finally {
            answer.complete(null);
            state.setBusy(false);
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void aChangedBindingOrNewTurnCannotContinueDeletionAfterAnUnfinishedRelease() throws Exception {
        for (String changed : List.of("session", "provider", "channel", "busy")) {
            var bridge = new HoldingReleaseBridge();
            try {
                var session = new RecordingSession("target", "codex", false);
                var deletion = CodexStorageHandler.releaseIdleHistorySession(session, List.of("target"), bridge);
                switch (changed) {
                    case "session" -> session.id = "new-target";
                    case "provider" -> session.provider = "claude";
                    case "channel" -> session.channel = "new-channel";
                    case "busy" -> session.busy = true;
                    default -> throw new AssertionError(changed);
                }
                bridge.release.complete(new JsonObject());
                var error = assertThrows(java.util.concurrent.CompletionException.class, deletion::join);
                assertEquals(changed.equals("busy") ? "SESSION_RUNNING" : "SELECTED_DATA_CHANGED", error.getCause().getMessage());
                assertFalse(session.interrupted);
            } finally {
                bridge.cleanupAllProcesses();
            }
        }
    }

    @Test
    public void storageTargetsRequireABoundedArrayOfSafeSessionIds() throws Exception {
        JsonObject request = JsonParser.parseString("{\"sessionIds\":[\"session-1\",\"session-2\"]}").getAsJsonObject();
        assertEquals(List.of("session-1", "session-2"), CodexStorageHandler.deletionTargets(request));
        for (String invalid : List.of("{}", "{\"sessionIds\":null}", "{\"sessionIds\":\"one\"}",
                "{\"sessionIds\":[]}", "{\"sessionIds\":[1]}", "{\"sessionIds\":[{}]}", "{\"sessionIds\":[\"../outside\"]}")) {
            assertThrows(IOException.class, () -> CodexStorageHandler.deletionTargets(JsonParser.parseString(invalid).getAsJsonObject()));
        }
        JsonArray tooMany = new JsonArray();
        for (int index = 0; index <= 1000; index++) {
            tooMany.add("session-" + index);
        }
        request.add("sessionIds", tooMany);
        assertThrows(IOException.class, () -> CodexStorageHandler.deletionTargets(request));
    }

    @Test
    public void metadataFailureStillAttemptsBothIndependentStorageCleanups() {
        AtomicBoolean titleAttempted = new AtomicBoolean();
        NodeJsServiceCaller caller = new NodeJsServiceCaller(null) {
            @Override
            public String callNodeJsFavoritesService(String functionName, String sessionId) throws Exception {
                throw new IOException("fixture");
            }

            @Override
            public String callNodeJsDeleteTitle(String sessionId) {
                titleAttempted.set(true);
                return "{\"success\":true}";
            }
        };
        assertFalse(CodexStorageHandler.cleanupSessionMetadata(caller, "session-1"));
        assertTrue(titleAttempted.get());
    }

    @Test
    public void storageMetadataReceiptRequiresSuccessfulServiceResponses() {
        for (String titleResult : List.of("{\"success\":true}", "{\"success\":false}", "{}", "invalid")) {
            NodeJsServiceCaller caller = new NodeJsServiceCaller(null) {
                @Override
                public String callNodeJsFavoritesService(String functionName, String sessionId) {
                    return "true";
                }

                @Override
                public String callNodeJsDeleteTitle(String sessionId) {
                    return titleResult;
                }
            };
            assertEquals(titleResult.equals("{\"success\":true}"), CodexStorageHandler.cleanupSessionMetadata(caller, "session-1"));
        }
    }

    private static class HoldingReleaseBridge extends CodexSDKBridge {
        private final CompletableFuture<JsonObject> release = new CompletableFuture<>();
        private String releasedId;
        private boolean owned = true;

        @Override public boolean ownsCodexThread(String threadId) { return owned; }

        @Override
        public CompletableFuture<JsonObject> releaseIdleCodexThread(String channelId, String cwd, String threadId) {
            releasedId = threadId;
            return release;
        }
    }

    private static class RecordingSession extends ClaudeSession {
        private String id;
        private String provider;
        private boolean busy;
        private String channel = "fixture-channel";
        private boolean interrupted;

        private RecordingSession(String id, String provider, boolean busy) {
            super(null, null, null, null);
            this.id = id;
            this.provider = provider;
            this.busy = busy;
        }

        @Override public String getSessionId() { return id; }
        @Override public String getProvider() { return provider; }
        @Override public String getChannelId() { return channel; }
        @Override public boolean isBusy() { return busy; }
        @Override public CompletableFuture<Void> interrupt() {
            interrupted = true;
            return CompletableFuture.completedFuture(null);
        }
    }
}
