package com.github.claudecodegui.clawbot;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.ArrayDeque;
import java.util.Queue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.*;

public class ClawBotTurnLifecycleTest {
    @Test
    public void completedGenerationRetainsPendingQuestionUntilAnsweredOrExpired() {
        ClawBotTurnLifecycle turn = new ClawBotTurnLifecycle();
        turn.bind(CompletableFuture.completedFuture(null));
        assertFalse(turn.finishIfReady(true));
        assertTrue(turn.finishIfReady(false));
        assertFalse(turn.finishIfReady(false));
    }

    @Test
    public void lateAnswersWaitForOriginalCompletionAndTrackFollowUpToItsTerminal() {
        ClawBotTurnLifecycle turn = new ClawBotTurnLifecycle();
        CompletableFuture<Void> original = new CompletableFuture<>();
        CompletableFuture<Void> followUp = new CompletableFuture<>();
        turn.bind(original);
        AtomicInteger starts = new AtomicInteger();
        JsonObject reply = turn.respond(ClawBotTurnLifecycleTest::lateAnswer, () -> "thread-1", () -> true,
                input -> { assertEquals("Answer B", input); starts.incrementAndGet(); return followUp; }, Runnable::run);
        assertFalse(reply.has("followUp"));
        assertEquals(0, starts.get());
        original.complete(null);
        assertEquals(1, starts.get());
        assertFalse(turn.finishIfReady(false));
        followUp.complete(null);
        assertTrue(turn.finishIfReady(false));
    }

    @Test
    public void resolutionCannotFinishWhileNativeResponseIsInFlight() {
        ClawBotTurnLifecycle turn = new ClawBotTurnLifecycle();
        turn.bind(CompletableFuture.completedFuture(null));
        turn.respond(() -> {
            assertFalse(turn.finishIfReady(false));
            return JsonParser.parseString("{\"replied\":true}").getAsJsonObject();
        }, () -> "thread-1", () -> true, input -> failFuture(), Runnable::run);
        assertTrue(turn.finishIfReady(false));
    }

    @Test
    public void changedSessionOrClosedWindowDoesNotStartQueuedContinuation() {
        for (boolean close : new boolean[]{false, true}) {
            ClawBotTurnLifecycle turn = new ClawBotTurnLifecycle();
            turn.bind(CompletableFuture.completedFuture(null));
            AtomicBoolean current = new AtomicBoolean(true);
            Queue<Runnable> queue = new ArrayDeque<>();
            turn.respond(ClawBotTurnLifecycleTest::lateAnswer, () -> "thread-1", current::get,
                    input -> failFuture(), queue::add);
            if (close) turn.close();
            else current.set(false);
            queue.remove().run();
            assertTrue(turn.failed());
        }
    }

    @Test
    public void failedOrWrongThreadAnswersNeverStartFollowUpAndFailureIsReported() {
        ClawBotTurnLifecycle turn = new ClawBotTurnLifecycle();
        turn.bind(CompletableFuture.completedFuture(null));
        JsonObject wrong = turn.respond(ClawBotTurnLifecycleTest::lateAnswer, () -> "thread-2", () -> true,
                input -> failFuture(), Runnable::run);
        assertTrue(wrong.has("error"));
        turn.respond(ClawBotTurnLifecycleTest::lateAnswer, () -> "thread-1", () -> true,
                input -> CompletableFuture.failedFuture(new IllegalStateException("fixture failure")), Runnable::run);
        assertTrue(turn.failed());
        assertTrue(turn.finishIfReady(false));
    }

    @Test
    public void unrelatedLocalTurnReleasesRemoteQuestionWithoutClaimingItsAnswer() {
        ClawBotTurnLifecycle turn = new ClawBotTurnLifecycle();
        turn.bind(CompletableFuture.completedFuture(null));
        assertTrue(turn.finishIfObsolete(() -> false));
        assertTrue(turn.respond(ClawBotTurnLifecycleTest::lateAnswer, () -> "thread-1", () -> true,
                input -> failFuture(), Runnable::run).has("error"));
    }

    private static JsonObject lateAnswer() {
        return JsonParser.parseString("{\"replied\":true,\"followUp\":{\"threadId\":\"thread-1\",\"text\":\"Answer B\"}}").getAsJsonObject();
    }

    private static CompletableFuture<Void> failFuture() {
        throw new AssertionError("Unexpected continuation");
    }
}
