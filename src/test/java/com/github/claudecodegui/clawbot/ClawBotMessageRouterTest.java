package com.github.claudecodegui.clawbot;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class ClawBotMessageRouterTest {

    @Test
    public void reportsAnUncertainMessageInsteadOfSilentlyReplayingAfterReceiptFailure() throws Exception {
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        List<String> replies = new ArrayList<>();
        AtomicInteger receiptWrites = new AtomicInteger();
        ClawBotMessageRouter.MessageReceiptRecorder failingRecorder = messageIds -> {
            if (receiptWrites.incrementAndGet() == 2) {
                throw new java.io.IOException("fixture receipt failure");
            }
        };
        ClawBotInboundMessage message = message("uncertain-1", "hello");

        try {
            router.handle(message, List.of(), (user, context, text) -> replies.add(text),
                    (handle, inbound) -> false, (handle, inbound) -> false, failingRecorder);
        } catch (java.io.IOException expected) {
            // The failed accepted-state write must leave the message marked uncertain.
        }
        assertEquals(List.of("uncertain-1"), router.uncertainMessageIdsSnapshot());

        router.handle(message, List.of(), (user, context, text) -> replies.add(text),
                (handle, inbound) -> false);

        assertTrue(replies.get(replies.size() - 1).contains("状态：未知"));
        assertTrue(router.uncertainMessageIdsSnapshot().isEmpty());
    }

    @Test
    public void persistsExecutionClaimBeforeQueueingAndRollsBackRejectedEnqueue() throws Exception {
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        ClawBotSessionSnapshot session = session("session-1", "Project", "codex");
        List<String> steps = new ArrayList<>();
        router.handle(message("select", "/use session-1"), List.of(session),
                (userId, contextToken, text) -> { }, (handle, inbound) -> true);

        router.handle(message("rejected", "hello"), List.of(session),
                (userId, contextToken, text) -> { },
                (handle, inbound) -> {
                    steps.add("enqueue");
                    return false;
                },
                (handle, command) -> true,
                messageIds -> { },
                new ClawBotMessageRouter.ExecutionRecorder() {
                    @Override
                    public boolean recordAccepted(String handle, ClawBotInboundMessage inbound) {
                        steps.add("record");
                        return true;
                    }

                    @Override
                    public void rollbackAccepted(String messageId) {
                        steps.add("rollback");
                    }
                });

        assertEquals(List.of("record", "enqueue", "rollback"), steps);
    }

    @Test
    public void executionJournalFailurePreventsQueueingAndRetainsUnknownMarker() throws Exception {
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        ClawBotSessionSnapshot session = session("session-1", "Project", "codex");
        router.handle(message("select", "/use session-1"), List.of(session),
                (userId, contextToken, text) -> { }, (handle, inbound) -> true);

        assertThrows(java.io.IOException.class, () -> router.handle(message("write-failed", "hello"),
                List.of(session), (userId, contextToken, text) -> { },
                (handle, inbound) -> {
                    throw new AssertionError("message must not be queued without a durable claim");
                },
                (handle, command) -> true,
                messageIds -> { },
                (handle, inbound) -> {
                    throw new java.io.IOException("fixture journal write failure");
                }));

        assertEquals(List.of("write-failed"), router.uncertainMessageIdsSnapshot());
    }

    @Test
    public void retainedExecutionClaimPreventsRequeueingTheSameMessageId() throws Exception {
        ClawBotSessionSnapshot session = session("session-1", "Project", "codex");
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        router.handle(message("select", "/use session-1"), List.of(session),
                (userId, contextToken, text) -> { }, (handle, inbound) -> true);

        assertThrows(java.io.IOException.class, () -> router.handle(message("already-claimed", "hello"),
                List.of(session), (userId, contextToken, text) -> { },
                (handle, inbound) -> {
                    throw new AssertionError("a retained execution claim must block queueing");
                },
                (handle, command) -> true,
                messageIds -> { },
                (handle, inbound) -> false));
        assertEquals(List.of("already-claimed"), router.uncertainMessageIdsSnapshot());
    }

    @Test
    public void retainsUnknownMarkerUntilIdeReplyAndSuppressesLiveDuplicate() throws Exception {
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        ClawBotSessionSnapshot session = session("session-1", "Project", "codex");
        List<String> replies = new ArrayList<>();
        List<String> uncertainIds = new ArrayList<>();
        ClawBotMessageRouter.MessageReceiptRecorder recorder = new ClawBotMessageRouter.MessageReceiptRecorder() {
            @Override
            public void record(List<String> messageIds) {
            }

            @Override
            public void record(List<String> messageIds, List<String> pendingIds) {
                uncertainIds.clear();
                uncertainIds.addAll(pendingIds);
            }
        };
        ClawBotMessageRouter.ReplySender replySender = (userId, contextToken, text) -> replies.add(text);
        ClawBotMessageRouter.MessageEnqueuer enqueuer = (handle, message) -> true;

        router.handle(message("select", "/use session-1"), List.of(session), replySender, enqueuer);
        ClawBotInboundMessage inbound = message("inbound-1", "hello");
        router.handle(inbound, List.of(session), replySender, enqueuer,
                (handle, command) -> false, recorder);
        assertEquals(List.of("inbound-1"), uncertainIds);

        router.handle(inbound, List.of(session), replySender, enqueuer,
                (handle, command) -> false, recorder);
        assertFalse(replies.stream().anyMatch(reply -> reply.contains("状态：未知")));

        assertThrows(java.io.IOException.class, () -> router.resolveUncertainMessage("inbound-1", messageIds -> {
            throw new java.io.IOException("fixture receipt failure");
        }));
        assertEquals(List.of("inbound-1"), router.uncertainMessageIdsSnapshot());
        router.resolveUncertainMessage("inbound-1", recorder);
        assertTrue(uncertainIds.isEmpty());
        assertTrue(router.uncertainMessageIdsSnapshot().isEmpty());
    }

    @Test
    public void restoredUnknownMarkerWarnsOnceAfterGatewayRestart() throws Exception {
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        router.restoreSeenMessageIds(List.of("inbound-1"));
        router.restoreUncertainMessageIds(List.of("inbound-1"));
        List<String> replies = new ArrayList<>();

        router.handle(message("inbound-1", "hello"), List.of(),
                (userId, contextToken, text) -> replies.add(text), (handle, message) -> false);

        assertTrue(replies.get(0).contains("状态：未知"));
        assertTrue(router.uncertainMessageIdsSnapshot().isEmpty());
    }

    @Test
    public void doesNotSendUnknownWarningToRevokedSender() throws Exception {
        ClawBotMessageRouter.RouteStore routeStore = new ClawBotMessageRouter.RouteStore() {
            @Override
            public Map<String, String> load() {
                return Map.of();
            }

            @Override
            public void save(Map<String, String> routes) {
            }

            @Override
            public void clear() {
            }
        };
        ClawBotMessageRouter router = new ClawBotMessageRouter(routeStore, senderId -> false);
        router.restoreSeenMessageIds(List.of("inbound-1"));
        router.restoreUncertainMessageIds(List.of("inbound-1"));
        List<String> replies = new ArrayList<>();

        router.handle(message("inbound-1", "hello"), List.of(),
                (userId, contextToken, text) -> replies.add(text), (handle, message) -> false);

        assertTrue(replies.isEmpty());
        assertTrue(router.uncertainMessageIdsSnapshot().isEmpty());
    }

    @Test
    public void requiresExplicitSelectionAndDeduplicatesInboundMessages() throws Exception {
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        ClawBotSessionSnapshot session = session("session-1", "Project", "codex");
        List<String> replies = new ArrayList<>();
        List<String> delivered = new ArrayList<>();
        ClawBotMessageRouter.ReplySender replySender = (userId, contextToken, text) -> replies.add(text);
        ClawBotMessageRouter.MessageEnqueuer enqueuer = (handle, message) -> {
            delivered.add(handle + ":" + message.text());
            return true;
        };

        router.handle(message("message-1", "hello"), List.of(session), replySender, enqueuer);
        assertTrue(delivered.isEmpty());
        assertEquals(1, replies.size());
        router.handle(message("select", "/use session-1"), List.of(session), replySender, enqueuer);

        router.handle(message("message-2", "hello again"), List.of(session), replySender, enqueuer);
        router.handle(message("message-2", "hello again"), List.of(session), replySender, enqueuer);
        assertEquals(List.of("session-1:hello again"), delivered);
    }

    @Test
    public void exposesOnlySafeSessionDisplayFieldsInSessionsCommand() throws Exception {
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        List<String> replies = new ArrayList<>();
        router.handle(message("message-1", "/sessions"),
                List.of(session("opaque-handle", "Demo Project", "claude")),
                (userId, contextToken, text) -> replies.add(text),
                (handle, message) -> true);
        assertEquals(1, replies.size());
        assertEquals(true, replies.get(0).contains("Demo Project / Chat"));
        assertFalse(replies.get(0).contains("claude"));
        assertFalse(replies.get(0).contains("ONLINE"));
        assertEquals(false, replies.get(0).contains("opaque-handle"));
    }

    @Test
    public void naturalLanguageControlsSelectedTabWithoutEnablingSlashCommands() throws Exception {
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        ClawBotSessionSnapshot session = controllableSession("session-1", "Project", "tab-a", "codex");
        List<ClawBotInboundMessage> commands = new ArrayList<>();
        List<String> replies = new ArrayList<>();
        ClawBotMessageRouter.ReplySender replySender = (userId, contextToken, text) -> replies.add(text);
        ClawBotMessageRouter.MessageEnqueuer enqueuer = (handle, message) -> true;
        ClawBotMessageRouter.SessionCommandEnqueuer commandEnqueuer = (handle, message) -> {
            commands.add(message);
            return true;
        };

        router.handle(message("message-1", "/use session-1"), List.of(session), replySender, enqueuer,
                commandEnqueuer, ignored -> { });
        router.handle(message("message-2", "stop current session"), List.of(session), replySender, enqueuer,
                commandEnqueuer, ignored -> { });
        router.handle(message("message-3", "new session session-1"), List.of(session), replySender, enqueuer,
                commandEnqueuer, ignored -> { });
        router.handle(message("message-4", "/stop"), List.of(session), replySender, enqueuer,
                commandEnqueuer, ignored -> { });

        assertEquals(2, commands.size());
        assertEquals(ClawBotInboundAction.INTERRUPT, commands.get(0).action());
        assertEquals(ClawBotInboundAction.NEW_SESSION, commands.get(1).action());
        assertEquals(true, replies.get(replies.size() - 1).contains("禁止"));
    }

    @Test
    public void answersUseTheIndependentControlMailbox() throws Exception {
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        ClawBotSessionSnapshot session = controllableSession("session-1", "Project", "Chat", "codex");
        List<ClawBotInboundMessage> commands = new ArrayList<>();

        router.handle(new ClawBotInboundMessage("select", "user-1", "context", "/use session-1"),
                List.of(session), (user, context, text) -> { }, (handle, message) -> true);
        router.setInteraction(session, new ClawBotInboundMessage("task", "user-1", "context-1", "task"), "question-version");
        router.handle(new ClawBotInboundMessage("approve", "user-1", "context-2", "1"),
                List.of(session), (user, context, text) -> { }, (handle, message) -> true,
                (handle, message) -> {
                    commands.add(message);
                    return true;
                }, ignored -> { });

        assertEquals(1, commands.size());
        assertEquals(ClawBotInboundAction.ANSWER, commands.get(0).action());
        assertEquals("question-version", commands.get(0).interactionToken());
        assertEquals(commands.get(0), ClawBotInboundMessage.fromJson(commands.get(0).toJson()));
        assertEquals("1", commands.get(0).text());
        assertEquals("context-2", commands.get(0).contextToken());
        assertEquals("session-1", commands.get(0).target().handle());
    }

    @Test
    public void treatsUnknownSlashTextAsAnAnswerWhileAnInteractionIsPending() throws Exception {
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        ClawBotSessionSnapshot session = controllableSession("session-1", "Project", "Chat", "codex");
        List<ClawBotInboundMessage> commands = new ArrayList<>();

        router.handle(new ClawBotInboundMessage("select", "user-1", "context", "/use session-1"),
                List.of(session), (user, context, text) -> { }, (handle, message) -> true);
        router.setInteraction(session, new ClawBotInboundMessage("task", "user-1", "context", "task"), "revision");
        router.handle(new ClawBotInboundMessage("answer", "user-1", "context", "/workspace/path"),
                List.of(session), (user, context, text) -> { }, (handle, message) -> true,
                (handle, message) -> {
                    commands.add(message);
                    return true;
                }, ignored -> { });

        assertEquals(1, commands.size());
        assertEquals(ClawBotInboundAction.ANSWER, commands.get(0).action());
        assertEquals("/workspace/path", commands.get(0).text());
    }

    @Test
    public void unsupportedMediaIsRejectedWithoutDispatchingItsTextOrPayload() throws Exception {
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        List<String> replies = new ArrayList<>();
        List<ClawBotInboundMessage> delivered = new ArrayList<>();
        ClawBotInboundMessage media = new ClawBotInboundMessage(
                "image-1", "user-1", "context-1", "", ClawBotInboundAction.UNSUPPORTED_MEDIA);
        assertEquals(media, ClawBotInboundMessage.fromJson(media.toJson()));

        router.handle(media, List.of(session("session-1", "Project", "codex")),
                (user, context, text) -> replies.add(text), (handle, message) -> {
                    delivered.add(message);
                    return true;
                });

        assertTrue(delivered.isEmpty());
        assertEquals(1, replies.size());
        assertTrue(replies.get(0).contains("尚不支持"));
        assertTrue(replies.get(0).contains("未提交给 IDE"));
    }

    @Test
    public void ordinaryWordsSharingCommandPrefixesAreDeliveredAsMessages() throws Exception {
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        ClawBotSessionSnapshot session = controllableSession("session-1", "Project", "tab-a", "codex");
        List<String> delivered = new ArrayList<>();
        List<ClawBotInboundMessage> commands = new ArrayList<>();
        ClawBotMessageRouter.ReplySender replySender = (userId, contextToken, text) -> { };
        ClawBotMessageRouter.MessageEnqueuer enqueuer = (handle, inbound) -> {
            delivered.add(inbound.text());
            return true;
        };
        ClawBotMessageRouter.SessionCommandEnqueuer commandEnqueuer = (handle, inbound) -> {
            commands.add(inbound);
            return true;
        };

        router.handle(message("route", "/use session-1"), List.of(session), replySender, enqueuer,
                commandEnqueuer, ignored -> { });
        router.handle(message("one", "stopwatch"), List.of(session), replySender, enqueuer,
                commandEnqueuer, ignored -> { });
        router.handle(message("two", "new sessionation"), List.of(session), replySender, enqueuer,
                commandEnqueuer, ignored -> { });

        assertEquals(List.of("stopwatch", "new sessionation"), delivered);
        assertEquals(0, commands.size());
    }

    @Test
    public void naturalLanguageSelectsOneOfSeveralSessionsForFutureMessages() throws Exception {
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        ClawBotSessionSnapshot first = session("session-1", "Project A", "claude");
        ClawBotSessionSnapshot second = session("session-2", "Project B", "codex");
        List<String> replies = new ArrayList<>();
        List<String> delivered = new ArrayList<>();
        ClawBotMessageRouter.ReplySender replySender = (userId, contextToken, text) -> replies.add(text);
        ClawBotMessageRouter.MessageEnqueuer enqueuer = (handle, message) -> {
            delivered.add(handle + ":" + message.text());
            return true;
        };

        router.handle(message("message-1", "hello"), List.of(first, second), replySender, enqueuer);
        assertEquals(0, delivered.size());
        assertEquals(1, replies.size());
        assertTrue(replies.get(0).contains("Project A / Chat"));
        assertTrue(replies.get(0).contains("Project B / Chat"));

        router.handle(message("message-2", "切换到 Project B"), List.of(first, second), replySender, enqueuer);
        router.handle(message("message-3", "hello codex"), List.of(first, second), replySender, enqueuer);
        assertEquals(List.of("session-2:hello codex"), delivered);
    }

    @Test
    public void selectedSessionSurvivesChangingContextTokens() throws Exception {
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        List<ClawBotSessionSnapshot> sessions = List.of(
                session("session-1", "Project A", "claude"), session("session-2", "Project B", "codex"));
        List<String> replies = new ArrayList<>();
        List<String> replyContexts = new ArrayList<>();
        List<String> handles = new ArrayList<>();
        List<ClawBotInboundMessage> delivered = new ArrayList<>();
        ClawBotMessageRouter.ReplySender sender = (userId, contextToken, text) -> {
            replies.add(text);
            replyContexts.add(contextToken);
        };
        ClawBotMessageRouter.MessageEnqueuer enqueuer = (handle, inbound) -> {
            handles.add(handle);
            delivered.add(inbound);
            return true;
        };

        router.handle(new ClawBotInboundMessage("select", "user-1", "context-select", "/use session-2"),
                sessions, sender, enqueuer);
        router.handle(new ClawBotInboundMessage("status", "user-1", "context-status", "/status"),
                sessions, sender, enqueuer);
        ClawBotInboundMessage first = new ClawBotInboundMessage("first", "user-1", "context-first", "hello");
        ClawBotInboundMessage second = new ClawBotInboundMessage("second", "user-1", "context-second", "follow up");
        router.handle(first, sessions, sender, enqueuer);
        router.handle(second, sessions, sender, enqueuer);

        assertEquals(List.of("session-2", "session-2"), handles);
        assertEquals(List.of(first.forTarget(sessions.get(1)).forRoute(1), second.forTarget(sessions.get(1)).forRoute(1)), delivered);
        assertEquals(2, replies.size());
        assertTrue(replies.get(1).contains("Project B / Chat"));
        assertTrue(replies.get(1).contains("提供方：codex"));
        assertEquals(List.of("context-select", "context-status"), replyContexts);
    }

    @Test
    public void userSelectionsRemainIsolatedAcrossChangingContextTokens() throws Exception {
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        List<ClawBotSessionSnapshot> sessions = List.of(
                session("session-1", "Project A", "claude"), session("session-2", "Project B", "codex"));
        List<String> delivered = new ArrayList<>();
        ClawBotMessageRouter.ReplySender sender = (userId, contextToken, text) -> { };
        ClawBotMessageRouter.MessageEnqueuer enqueuer = (handle, inbound) -> {
            delivered.add(inbound.fromUserId() + ":" + handle);
            return true;
        };

        router.handle(new ClawBotInboundMessage("select-1", "user-1", "shared-context", "/use session-1"),
                sessions, sender, enqueuer);
        router.handle(new ClawBotInboundMessage("unselected", "user-2", "shared-context", "hello"),
                sessions, sender, enqueuer);
        assertTrue(delivered.isEmpty());
        router.handle(new ClawBotInboundMessage("select-2", "user-2", "shared-context", "/use session-2"),
                sessions, sender, enqueuer);
        router.handle(new ClawBotInboundMessage("first", "user-1", "context-first", "hello"),
                sessions, sender, enqueuer);
        router.handle(new ClawBotInboundMessage("second", "user-2", "context-second", "hello"),
                sessions, sender, enqueuer);
        router.handle(new ClawBotInboundMessage("off", "user-1", "context-off", "/use off"),
                sessions, sender, enqueuer);
        router.handle(new ClawBotInboundMessage("after-off", "user-1", "shared-context", "hello"),
                sessions, sender, enqueuer);
        router.handle(new ClawBotInboundMessage("other-user", "user-2", "context-other", "hello"),
                sessions, sender, enqueuer);

        assertEquals(List.of("user-1:session-1", "user-2:session-2", "user-2:session-2"), delivered);
        router.clear();
        router.handle(new ClawBotInboundMessage("after-clear", "user-2", "context-clear", "hello"),
                sessions, sender, enqueuer);
        assertEquals(3, delivered.size());
    }

    @Test
    public void blocksUnlistedSendersButAllowsWhoamiAndAuthorizedRouting() throws Exception {
        FakeSecretBackend backend = new FakeSecretBackend();
        ClawBotSenderAccessStore accessStore = new ClawBotSenderAccessStore(backend);
        accessStore.allow("authorized-user");
        ClawBotMessageRouter router = new ClawBotMessageRouter(
                new ClawBotConversationRouteStore(backend), accessStore::isAllowed);
        List<String> replies = new ArrayList<>();
        List<String> delivered = new ArrayList<>();
        ClawBotMessageRouter.ReplySender sender = (userId, contextToken, text) -> replies.add(text);
        ClawBotMessageRouter.MessageEnqueuer enqueuer = (handle, inbound) -> {
            delivered.add(handle + ":" + inbound.text());
            return true;
        };
        List<ClawBotSessionSnapshot> sessions = List.of(session("session-1", "Project", "codex"));

        router.handle(new ClawBotInboundMessage("denied", "unlisted-user", "ctx-1", "/sessions"),
                sessions, sender, enqueuer);
        assertTrue(replies.isEmpty());
        assertTrue(delivered.isEmpty());

        router.handle(new ClawBotInboundMessage("whoami", "unlisted-user", "ctx-2", "/whoami"),
                sessions, sender, enqueuer);
        assertTrue(replies.get(0).contains("unlisted-user"));
        assertTrue(delivered.isEmpty());

        router.handle(new ClawBotInboundMessage("selection", "authorized-user", "ctx-3", "/use session-1"),
                sessions, sender, enqueuer);
        router.handle(new ClawBotInboundMessage("authorized", "authorized-user", "ctx-3", "hello"),
                sessions, sender, enqueuer);
        assertEquals(List.of("session-1:hello"), delivered);
        assertFalse(replies.get(0).contains("authorized-user"));
    }

    @Test
    public void senderRouteRequiresReselectionAfterRouterRecreation() throws Exception {
        FakeSecretBackend backend = new FakeSecretBackend();
        ClawBotConversationRouteStore routeStore = new ClawBotConversationRouteStore(backend);
        ClawBotSessionSnapshot first = session("session-1", "Project A", "claude");
        ClawBotSessionSnapshot second = session("session-2", "Project B", "codex");
        List<ClawBotSessionSnapshot> sessions = List.of(first, second);
        ClawBotMessageRouter firstRouter = new ClawBotMessageRouter(routeStore, senderId -> true);

        firstRouter.handle(new ClawBotInboundMessage("select", "sender-1", "select-context", "/use session-2"),
                sessions, (userId, contextToken, text) -> { }, (handle, inbound) -> true);

        ClawBotMessageRouter restartedRouter = new ClawBotMessageRouter(
                new ClawBotConversationRouteStore(backend), senderId -> true);
        List<String> delivered = new ArrayList<>();
        restartedRouter.handle(new ClawBotInboundMessage("message", "sender-1", "new-context", "hello"),
                sessions, (userId, contextToken, text) -> { }, (handle, inbound) -> {
                    delivered.add(handle);
                    return true;
                });

        assertTrue(delivered.isEmpty());
    }

    private static final class FakeSecretBackend implements ClawBotCredentialStore.SecretBackend {

        private final java.util.Map<String, String> values = new java.util.HashMap<>();

        @Override
        public String read(String key) {
            return values.get(key);
        }

        @Override
        public void write(String key, String value) {
            values.put(key, value);
        }

        @Override
        public void clear(String key) {
            values.remove(key);
        }
    }

    @Test
    public void selectedControlsSurviveChangingContextTokens() throws Exception {
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        List<ClawBotSessionSnapshot> sessions = List.of(
                controllableSession("session-1", "Project A", "Chat", "claude"),
                controllableSession("session-2", "Project B", "Chat", "codex"));
        List<String> handles = new ArrayList<>();
        List<ClawBotInboundMessage> commands = new ArrayList<>();
        ClawBotMessageRouter.ReplySender sender = (userId, contextToken, text) -> { };
        ClawBotMessageRouter.MessageEnqueuer enqueuer = (handle, inbound) -> true;
        ClawBotMessageRouter.SessionCommandEnqueuer commandEnqueuer = (handle, inbound) -> {
            handles.add(handle);
            commands.add(inbound);
            return true;
        };

        router.handle(new ClawBotInboundMessage("select", "user-1", "context-select", "/use session-2"),
                sessions, sender, enqueuer);
        router.handle(new ClawBotInboundMessage("stop", "user-1", "context-stop", "stop current session"),
                sessions, sender, enqueuer, commandEnqueuer, ignored -> { });
        router.handle(new ClawBotInboundMessage("new", "user-1", "context-new", "new session"),
                sessions, sender, enqueuer, commandEnqueuer, ignored -> { });

        assertEquals(List.of("session-2", "session-2"), handles);
        assertEquals(ClawBotInboundAction.INTERRUPT, commands.get(0).action());
        assertEquals("context-stop", commands.get(0).contextToken());
        assertEquals(ClawBotInboundAction.NEW_SESSION, commands.get(1).action());
        assertEquals("context-new", commands.get(1).contextToken());
    }

    @Test
    public void helpSeparatesCommandsIntoParagraphsAndIncludesStatus() throws Exception {
        List<String> replies = new ArrayList<>();
        new ClawBotMessageRouter().handle(message("help", "/help"), List.of(),
                (userId, contextToken, text) -> replies.add(text), (handle, inbound) -> true);

        String help = replies.get(0);
        assertTrue(help.contains("【会话导航】\n\n/sessions"));
        assertTrue(help.contains("\n\n/status"));
        assertTrue(help.contains("【会话控制】"));
        assertTrue(help.contains("替换当前页签会话"));
    }

    @Test
    public void messageAwareReplySenderReceivesInboundMessageIdentity() throws Exception {
        List<String> messageIds = new ArrayList<>();
        ClawBotMessageRouter.ReplySender sender = new ClawBotMessageRouter.ReplySender() {
            @Override
            public void send(String userId, String contextToken, String text) {
                throw new AssertionError("message-aware reply path was not used");
            }

            @Override
            public void send(ClawBotInboundMessage message, String text) {
                messageIds.add(message.messageId());
            }
        };

        new ClawBotMessageRouter().handle(message("reply-source", "/help"), List.of(), sender,
                (handle, inbound) -> true);

        assertEquals(List.of("reply-source"), messageIds);
    }

    @Test
    public void recordsUsageOnlyForAuthorizedMessages() throws Exception {
        AtomicReference<String> recordedSender = new AtomicReference<>();
        ClawBotMessageRouter.SenderUsageRecorder recorder = new ClawBotMessageRouter.SenderUsageRecorder() {
            @Override
            public boolean test(String senderId) {
                return "authorized".equals(senderId);
            }

            @Override
            public void recordUse(String senderId) {
                recordedSender.set(senderId);
            }
        };
        ClawBotMessageRouter.RouteStore routeStore = new ClawBotMessageRouter.RouteStore() {
            @Override
            public Map<String, String> load() {
                return Map.of();
            }

            @Override
            public void save(Map<String, String> routes) {
            }

            @Override
            public void clear() {
            }
        };
        ClawBotMessageRouter router = new ClawBotMessageRouter(routeStore, recorder);

        router.handle(new ClawBotInboundMessage("authorized-msg", "authorized", "context", "/help"), List.of(),
                (userId, contextToken, text) -> { }, (handle, inbound) -> true);
        router.handle(new ClawBotInboundMessage("unauthorized-msg", "unauthorized", "context", "/help"), List.of(),
                (userId, contextToken, text) -> { }, (handle, inbound) -> true);

        assertEquals("authorized", recordedSender.get());
    }

    @Test
    public void sessionListShowsTabTitlesAndOnlyMeaningfulBusyStatus() throws Exception {
        List<String> replies = new ArrayList<>();
        ClawBotSessionSnapshot ready = controllableSession("ready", "Project", "Fix authentication", "codex");
        ClawBotSessionSnapshot busy = controllableSession("busy", "Project", "Review tests", "claude")
                .withStatus(ClawBotSessionStatus.BUSY);
        new ClawBotMessageRouter().handle(message("list", "/sessions"), List.of(ready, busy),
                (userId, contextToken, text) -> replies.add(text), (handle, inbound) -> true);

        assertTrue(replies.get(0).contains("\n\n1. Project / Fix authentication"));
        assertTrue(replies.get(0).contains("\n\n2. Project / Review tests（处理中）"));
        assertFalse(replies.get(0).contains("ONLINE"));
        assertFalse(replies.get(0).contains("codex"));
    }

    @Test
    public void statusShowsUncertainInboundCountWithoutMessageContent() throws Exception {
        ClawBotMessageRouter router = new ClawBotMessageRouter();
        ClawBotSessionSnapshot target = session("session-1", "Project", "codex");
        List<String> replies = new ArrayList<>();

        router.handle(message("select", "/use session-1"), List.of(target),
                (userId, contextToken, text) -> replies.add(text), (handle, inbound) -> true);
        router.handle(message("inbound", "private message body"), List.of(target),
                (userId, contextToken, text) -> replies.add(text), (handle, inbound) -> true);
        router.handle(message("status", "/status"), List.of(target),
                (userId, contextToken, text) -> replies.add(text), (handle, inbound) -> true);

        String status = replies.get(replies.size() - 1);
        assertTrue(status, status.contains("待核验入站消息：1"));
        assertFalse(status.contains("private message body"));
    }

    private static ClawBotInboundMessage message(String id, String text) {
        return new ClawBotInboundMessage(id, "user-1", "context-1", text);
    }

    private static ClawBotSessionSnapshot session(String handle, String name, String provider) {
        return new ClawBotSessionSnapshot(
                handle, "ide-1", "project-1", name, provider,
                Set.of("STATUS", "INBOUND", "ROUTING_V2"), ClawBotSessionStatus.ONLINE,
                1, 1, 1, "Chat", "generation-1", 0);
    }

    private static ClawBotSessionSnapshot controllableSession(
            String handle, String project, String tab, String provider) {
        return new ClawBotSessionSnapshot(
                handle, "ide-1", "project-1", project, provider,
                Set.of("STATUS", "INBOUND", "CONTROL", "ROUTING_V2"), ClawBotSessionStatus.ONLINE,
                1, 1, 1, tab, "generation-1", 0);
    }
}
