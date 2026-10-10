package com.github.claudecodegui.clawbot;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.ClaudeSession.Message;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

public class ClawBotProgressTrackerTest {
    private static final long FIRST_CHECK = TimeUnit.SECONDS.toNanos(30);
    private static final long TEXT_INTERVAL = TimeUnit.MINUTES.toNanos(2);
    private static final long WAIT_INTERVAL = TimeUnit.MINUTES.toNanos(10);

    @Test
    public void sendsOnlyNewPublicAssistantTextFromCurrentTurn() {
        Fixture fixture = startTurn();
        Message answer = new Message(Message.Type.ASSISTANT, "first chunk");
        fixture.session().getState().addMessage(answer);

        ClawBotProgressTracker.Notification first = fixture.tracker().prepare("RUNNING", "", FIRST_CHECK);

        assertNotNull(first);
        assertTrue(first.text().contains("first chunk"));
        assertFalse(first.reminder());
        fixture.tracker().finish(first, true, FIRST_CHECK);

        answer.content = "first chunk and second chunk";
        ClawBotProgressTracker.Notification second = fixture.tracker().prepare(
                "RUNNING", "", FIRST_CHECK + TEXT_INTERVAL);

        assertNotNull(second);
        assertTrue(second.text().contains("second chunk"));
        assertFalse(second.text().contains("first chunk"));
        assertFalse(second.reminder());
    }

    @Test
    public void excludesThinkingBlocksFromProgressText() {
        Fixture fixture = startTurn();
        Message answer = new Message(Message.Type.ASSISTANT, "private fallback text",
                JsonParser.parseString("{\"message\":{\"content\":["
                        + "{\"type\":\"thinking\",\"thinking\":\"private reasoning\"},"
                        + "{\"type\":\"text\",\"text\":\"public progress\"}]}}").getAsJsonObject());
        fixture.session().getState().addMessage(answer);

        ClawBotProgressTracker.Notification notification = fixture.tracker().prepare(
                "RUNNING", "", FIRST_CHECK);

        assertNotNull(notification);
        assertTrue(notification.text().contains("public progress"));
        assertFalse(notification.text().contains("private"));
    }

    @Test
    public void retriesTheSameNotificationAfterFailedDelivery() {
        Fixture fixture = startTurn();
        fixture.session().getState().addMessage(new Message(Message.Type.ASSISTANT, "in progress"));
        ClawBotProgressTracker.Notification notification = fixture.tracker().prepare(
                "RUNNING", "", FIRST_CHECK);
        assertNotNull(notification);

        fixture.tracker().finish(notification, false, FIRST_CHECK);
        assertNull(fixture.tracker().prepare("RUNNING", "", FIRST_CHECK + TimeUnit.MILLISECONDS.toNanos(999)));
        ClawBotProgressTracker.Notification retry = fixture.tracker().prepare(
                "RUNNING", "", FIRST_CHECK + TimeUnit.SECONDS.toNanos(1));

        assertSame(notification, retry);
        fixture.tracker().finish(retry, true, FIRST_CHECK + TimeUnit.SECONDS.toNanos(1));
        assertEquals(1L, retry.sequence());
    }

    @Test
    public void sendsPeriodicReminderWhenNoNewAssistantTextExists() {
        Fixture fixture = startTurn();

        assertNull(fixture.tracker().prepare("RUNNING", "", FIRST_CHECK));
        ClawBotProgressTracker.Notification first = fixture.tracker().prepare("RUNNING", "", TimeUnit.MINUTES.toNanos(5));
        assertNotNull(first);
        assertTrue(first.reminder());
        fixture.tracker().finish(first, true, FIRST_CHECK);

        assertNull(fixture.tracker().prepare("RUNNING", "", FIRST_CHECK + TEXT_INTERVAL));
        ClawBotProgressTracker.Notification reminder = fixture.tracker().prepare(
                "RUNNING", "", FIRST_CHECK + TimeUnit.MINUTES.toNanos(5));
        assertNotNull(reminder);
        assertTrue(reminder.reminder());
    }

    @Test
    public void appliesUpdatedIntervalsToAnActiveTurn() {
        AtomicReference<ClawBotProgressSettings> settings = new AtomicReference<>(
                ClawBotProgressSettings.defaults());
        Fixture fixture = startTurn(settings::get);
        fixture.session().getState().addMessage(new Message(Message.Type.ASSISTANT, "initial"));
        ClawBotProgressTracker.Notification first = fixture.tracker().prepare("RUNNING", "", FIRST_CHECK);
        assertNotNull(first);
        fixture.tracker().finish(first, true, FIRST_CHECK);

        settings.set(new ClawBotProgressSettings(1, 10, 10));
        long changedAt = FIRST_CHECK + TimeUnit.SECONDS.toNanos(30);
        assertNull(fixture.tracker().prepare("RUNNING", "", changedAt));
        ClawBotProgressTracker.Notification reminder = fixture.tracker().prepare(
                "RUNNING", "", changedAt + TimeUnit.MINUTES.toNanos(10));
        assertNotNull(reminder);
        assertTrue(reminder.reminder());
    }

    @Test
    public void doesNotReadPreviousTurnAfterAnotherTurnStarts() {
        Fixture fixture = startTurn();
        fixture.session().getState().addMessage(new Message(Message.Type.ASSISTANT, "first turn response"));
        fixture.session().getState().beginTurn();
        fixture.session().getState().addMessage(new Message(Message.Type.USER, "second question"));

        assertNull(fixture.tracker().prepare("RUNNING", "", FIRST_CHECK));
    }

    @Test
    public void capsOrdinaryProgressNotificationsAtSixPerTurn() {
        Fixture fixture = startTurn();
        Message answer = new Message(Message.Type.ASSISTANT, "progress 0");
        fixture.session().getState().addMessage(answer);
        long now = FIRST_CHECK;

        for (int index = 0; index < 6; index++) {
            answer.content = "progress " + index;
            ClawBotProgressTracker.Notification notification = fixture.tracker().prepare("RUNNING", "", now);
            assertNotNull(notification);
            fixture.tracker().finish(notification, true, now);
            now += TEXT_INTERVAL;
        }

        answer.content = "progress after limit";
        assertNull(fixture.tracker().prepare("RUNNING", "", now));
    }

    @Test
    public void usesConfiguredInitialDelayNotificationLimitAndExcerptLength() {
        ClawBotProgressSettings settings = new ClawBotProgressSettings(1, 5, 10, 30, 1, 100, 30);
        Fixture fixture = startTurn(() -> settings);
        Message answer = new Message(Message.Type.ASSISTANT, "x".repeat(500));
        fixture.session().getState().addMessage(answer);

        assertNull(fixture.tracker().prepare("RUNNING", "", TimeUnit.SECONDS.toNanos(29)));
        ClawBotProgressTracker.Notification first = fixture.tracker().prepare(
                "RUNNING", "", TimeUnit.SECONDS.toNanos(30));
        assertNotNull(first);
        assertTrue(first.text().length() < 150);
        fixture.tracker().finish(first, true, TimeUnit.SECONDS.toNanos(30));

        answer.content = "next chunk";
        assertNull(fixture.tracker().prepare("RUNNING", "", TimeUnit.MINUTES.toNanos(1) + 1));
    }

    @Test
    public void appliesUpdatedNotificationLimitAndExcerptLengthToActiveTurn() {
        AtomicReference<ClawBotProgressSettings> settings = new AtomicReference<>(
                ClawBotProgressSettings.defaults());
        Fixture fixture = startTurn(settings::get);
        Message answer = new Message(Message.Type.ASSISTANT, "initial response");
        fixture.session().getState().addMessage(answer);
        ClawBotProgressTracker.Notification first = fixture.tracker().prepare("RUNNING", "", FIRST_CHECK);
        assertNotNull(first);
        fixture.tracker().finish(first, true, FIRST_CHECK);

        settings.set(new ClawBotProgressSettings(1, 5, 10, 15, 2, 100, 30));
        answer.content = "initial response plus " + "x".repeat(500);
        long changedAt = FIRST_CHECK + TimeUnit.SECONDS.toNanos(30);
        assertNull(fixture.tracker().prepare("RUNNING", "", changedAt));
        ClawBotProgressTracker.Notification second = fixture.tracker().prepare(
                "RUNNING", "", changedAt + TEXT_INTERVAL);
        assertNotNull(second);
        assertTrue(second.text().length() < 150);
        fixture.tracker().finish(second, true, changedAt + TEXT_INTERVAL);
        answer.content = "more output";
        assertNull(fixture.tracker().prepare("RUNNING", "", changedAt + 2 * TEXT_INTERVAL));
    }

    @Test
    public void pausesProgressWhileWaitingAndSendsResumeBeforeNewText() {
        Fixture fixture = startTurn();
        Message answer = new Message(Message.Type.ASSISTANT, "before question");
        fixture.session().getState().addMessage(answer);
        long now = FIRST_CHECK;

        ClawBotProgressTracker.Notification waiting = fixture.tracker().prepare(
                "WAITING:q-1", "【等待回答】\n请回复选项。", now);
        assertNotNull(waiting);
        assertTrue(waiting.essential());
        assertTrue(waiting.text().contains("等待回答"));
        fixture.tracker().finish(waiting, true, now);

        answer.content = "before question and post answer";
        assertNull(fixture.tracker().prepare("WAITING:q-1", "【等待回答】\n请回复选项。",
                now + TEXT_INTERVAL));
        ClawBotProgressTracker.Notification waitReminder = fixture.tracker().prepare(
                "WAITING:q-1", "【等待回答】\n请回复选项。", now + WAIT_INTERVAL);
        assertNotNull(waitReminder);
        assertTrue(waitReminder.reminder());
        assertFalse(waitReminder.text().isBlank());
        fixture.tracker().finish(waitReminder, true, now + WAIT_INTERVAL);

        ClawBotProgressTracker.Notification resumed = fixture.tracker().prepare(
                "RUNNING", "", now + WAIT_INTERVAL + TEXT_INTERVAL);
        assertNotNull(resumed);
        assertFalse(resumed.essential());
        assertTrue(resumed.text().contains("等待已结束"));
        fixture.tracker().finish(resumed, true, now + WAIT_INTERVAL + TEXT_INTERVAL);

        answer.content = "before question and post answer and another chunk";
        ClawBotProgressTracker.Notification progress = fixture.tracker().prepare(
                "RUNNING", "", now + WAIT_INTERVAL + 2 * TEXT_INTERVAL);
        assertNotNull(progress);
        assertFalse(progress.essential());
        assertTrue(progress.text().contains("another chunk"));
    }

    @Test
    public void rechecksTurnStateImmediatelyBeforeSendingPreparedProgress() {
        Fixture fixture = startTurn();
        fixture.session().getState().addMessage(new Message(Message.Type.ASSISTANT, "prepared text"));
        ClawBotProgressTracker.Notification notification = fixture.tracker().prepare(
                "RUNNING", "", FIRST_CHECK);
        AtomicInteger checks = new AtomicInteger();
        AtomicBoolean sent = new AtomicBoolean();

        fixture.tracker().dispatch(notification, () -> checks.incrementAndGet() < 2, ignored -> {
            sent.set(true);
            return true;
        });

        assertFalse(sent.get());
        assertTrue(checks.get() >= 2);
    }

    private static Fixture startTurn() {
        return startTurn(ClawBotProgressSettings::defaults);
    }

    @Test
    public void disablingProgressStillAllowsFirstQuestionButNotRepeatedReminders() {
        Fixture fixture = startTurn(() -> new ClawBotProgressSettings(1, 0, 0, 30, 0, 800, 30));
        fixture.session().getState().addMessage(new Message(Message.Type.ASSISTANT, "ordinary text"));
        assertNull(fixture.tracker().prepare("RUNNING", "", FIRST_CHECK));
        var question = fixture.tracker().prepare("WAITING:q1", "Choose a response", FIRST_CHECK);
        assertNotNull(question);
        assertTrue(question.essential());
        fixture.tracker().finish(question, true, FIRST_CHECK);
        assertNull(fixture.tracker().prepare("WAITING:q1", "Choose a response", FIRST_CHECK + WAIT_INTERVAL));
    }

    @Test
    public void coalescesRejectedProgressToLatestTextWithoutCreatingAnotherEvent() {
        Fixture fixture = startTurn();
        Message answer = new Message(Message.Type.ASSISTANT, "old response");
        fixture.session().getState().addMessage(answer);
        var first = fixture.tracker().prepare("RUNNING", "", FIRST_CHECK);
        fixture.tracker().finish(first, false, FIRST_CHECK);
        answer.content = "new response";
        var retry = fixture.tracker().prepare("RUNNING", "", FIRST_CHECK + TimeUnit.SECONDS.toNanos(1));
        assertNotNull(retry);
        assertEquals(first.sequence(), retry.sequence());
        assertTrue(retry.text().contains("new response"));
        assertFalse(retry.text().contains("old response"));
    }

    private static Fixture startTurn(java.util.function.Supplier<ClawBotProgressSettings> settingsSupplier) {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.getState().beginTurn();
        session.getState().addMessage(new Message(Message.Type.USER, "question"));
        ClawBotProgressTracker tracker = new ClawBotProgressTracker(session, 0, 0L, settingsSupplier);
        tracker.bind();
        return new Fixture(session, tracker);
    }

    private record Fixture(ClaudeSession session, ClawBotProgressTracker tracker) {
    }
}
