package com.github.claudecodegui.clawbot;

import com.github.claudecodegui.session.ClaudeSession;

import java.io.IOException;
import java.util.List;
import java.util.Objects;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/** Per-request progress cursor; transport I/O never holds the session message lock. */
public final class ClawBotProgressTracker {
    private final Object deliveryLock = new Object();
    private final ClaudeSession session;
    private final int firstMessageIndex;
    private final Supplier<ClawBotProgressSettings> settingsSupplier;
    private Object turnOwner;
    private String runtimeEpoch;
    private ClaudeSession.Message question;
    private boolean closed;
    private boolean inFlight;
    private String phase = "RUNNING";
    private String phaseText = "";
    private long nextCheck;
    private long nextReminder;
    private final long createdAt;
    private long lastSentAt;
    private boolean hasSent;
    private int notificationCount;
    private long sequence;
    private Response delivered = new Response(null, "");
    private Notification pending;
    private Response pendingResponse;
    private int failures;
    private long retryAt;
    private ClawBotProgressSettings appliedSettings;

    public ClawBotProgressTracker(ClaudeSession session, int firstMessageIndex, long now) {
        this(session, firstMessageIndex, now, ClawBotProgressSettings::defaults);
    }

    public ClawBotProgressTracker(
            ClaudeSession session,
            int firstMessageIndex,
            long now,
            Supplier<ClawBotProgressSettings> settingsSupplier) {
        this.session = session;
        this.firstMessageIndex = firstMessageIndex;
        this.settingsSupplier = Objects.requireNonNull(settingsSupplier, "settingsSupplier");
        appliedSettings = currentSettings();
        createdAt = now;
        nextCheck = now + appliedSettings.initialCheckDelayNanos();
        nextReminder = now + appliedSettings.idleReminderNanos();
    }

    /** Called after send synchronously publishes its user message and turn owner. */
    public void bind() {
        Object owner;
        String epoch;
        ClaudeSession.Message anchor;
        synchronized (session.getState().getMessageStateLock()) {
            List<ClaudeSession.Message> messages = session.getMessages();
            owner = session.getState().getTurnOwner();
            epoch = session.getRuntimeSessionEpoch();
            anchor = firstMessageIndex >= 0 && firstMessageIndex < messages.size()
                    ? messages.get(firstMessageIndex) : null;
            // A later local send must not be mistaken for this request's turn.
            for (int index = firstMessageIndex + 1; index < messages.size(); index++) {
                if (messages.get(index).type == ClaudeSession.Message.Type.USER
                        && !"[tool_result]".equals(messages.get(index).content)) {
                    anchor = null;
                    break;
                }
            }
        }
        synchronized (this) {
            turnOwner = owner;
            runtimeEpoch = epoch;
            question = anchor;
        }
    }

    public synchronized Notification prepare(String currentPhase, String statusText, long now) {
        if (closed || question == null) {
            return null;
        }
        ClawBotProgressSettings settings = currentSettings();
        if (!settings.equals(appliedSettings)) {
            appliedSettings = settings;
            nextCheck = (hasSent ? lastSentAt : createdAt) + (hasSent
                    ? settings.textIntervalNanos() : settings.initialCheckDelayNanos());
            nextReminder = (hasSent ? lastSentAt : createdAt) + reminderIntervalNanos(settings, phase);
        }
        boolean newQuestion = !"RUNNING".equals(currentPhase) && (!phase.equals(currentPhase) || !phaseText.equals(statusText));
        // First delivery of a question remains available when ordinary reminders are disabled.
        boolean important = newQuestion || (pending != null && pending.essential());
        if (!important && notificationCount >= settings.maxNotifications()) {
            if (!inFlight) {
                pending = null;
                pendingResponse = null;
            }
            return null;
        }
        if (inFlight) {
            return null;
        }
        if (!important && hasSent && !ClawBotDeliveryRetryPolicy.isDue(now, lastSentAt + settings.minSendIntervalNanos())) {
            return null;
        }
        boolean phaseChanged = !phase.equals(currentPhase)
                || (!"RUNNING".equals(currentPhase) && !phaseText.equals(statusText));
        if (phaseChanged) {
            phase = currentPhase;
            phaseText = statusText;
            pending = null;
            pendingResponse = null;
            failures = 0;
            inFlight = false;
            Response baseline = ClawBotConversationPreview.captureResponse(session, firstMessageIndex, turnOwner, runtimeEpoch, question);
            if (baseline == null) {
                closed = true;
                return null;
            }
            delivered = baseline;
            pendingResponse = baseline;
            pending = new Notification(++sequence, "RUNNING".equals(phase)
                    ? "等待已结束（已回答、取消或超时），任务继续处理。" : statusText, true, !"RUNNING".equals(phase));
            retryAt = now;
            nextCheck = now;
            nextReminder = now;
        }
        if (inFlight) {
            return null;
        }
        if (pending != null) {
            if (!ClawBotDeliveryRetryPolicy.isDue(now, retryAt)) {
                return null;
            }
        } else if (!ClawBotDeliveryRetryPolicy.isDue(now,
                "RUNNING".equals(phase) ? nextCheck : nextReminder)) {
            return null;
        }
        Response response = ClawBotConversationPreview.captureResponse(
                session, firstMessageIndex, turnOwner, runtimeEpoch, question);
        if (response == null) {
            closed = true;
            pending = null;
            pendingResponse = null;
            return null;
        }
        if (pending != null && !pending.essential() && !pending.reminder() && "RUNNING".equals(phase)
                && !response.text().isBlank() && !response.equals(pendingResponse)) {
            String text = response.text();
            if (response.message() == delivered.message() && text.startsWith(delivered.text())) {
                text = text.substring(delivered.text().length());
            }
            pendingResponse = response;
            pending = new Notification(pending.sequence(), "【处理中 · 最新回复】\n\n"
                    + latestExcerpt(text, settings.excerptMaxCharacters()), false, false);
        }
        if (pending == null && notificationCount < settings.maxNotifications()) {
            boolean running = "RUNNING".equals(phase);
            if (running) {
                nextCheck = now + settings.textIntervalNanos();
            }
            if (running && !response.text().isBlank() && !response.equals(delivered)) {
                String text = response.text();
                if (response.message() == delivered.message() && text.startsWith(delivered.text())) {
                    text = text.substring(delivered.text().length());
                }
                pendingResponse = response;
                pending = new Notification(++sequence, "【处理中 · 最新回复】\n\n"
                        + latestExcerpt(text, settings.excerptMaxCharacters()), false, false);
            } else if (running && settings.idleReminderMinutes() > 0 && ClawBotDeliveryRetryPolicy.isDue(now, nextReminder)) {
                String text = response.text().isBlank() ? "任务仍在处理中，暂未产生可展示的回复。"
                        : "任务仍在执行，暂无新的文本回复。";
                pendingResponse = delivered;
                pending = new Notification(++sequence, text, true, false);
            } else if (!running && settings.waitReminderMinutes() > 0 && ClawBotDeliveryRetryPolicy.isDue(now, nextReminder)) {
                pendingResponse = delivered;
                pending = new Notification(++sequence, statusText, true, false);
            }
        }
        inFlight = pending != null;
        return pending;
    }

    /** Serializes progress delivery with close, so terminal replies cannot be overtaken. */
    public void dispatch(Notification notification, BooleanSupplier current, Sender sender) {
        synchronized (deliveryLock) {
            try {
                synchronized (this) {
                    if (closed || pending != notification || !current.getAsBoolean()) {
                        return;
                    }
                }
                if (ClawBotConversationPreview.captureResponse(
                        session, firstMessageIndex, turnOwner, runtimeEpoch, question) == null) {
                    close();
                    return;
                }
                synchronized (this) {
                    if (closed || pending != notification || !current.getAsBoolean()) {
                        return;
                    }
                }
                boolean accepted = sender.send(notification);
                finish(notification, accepted, System.nanoTime());
            } catch (IOException | RuntimeException error) {
                finish(notification, false, System.nanoTime());
            } finally {
                synchronized (this) {
                    if (pending == notification) {
                        inFlight = false;
                    }
                }
            }
        }
    }

    synchronized void finish(Notification notification, boolean accepted, long now) {
        if (closed || pending != notification) {
            return;
        }
        inFlight = false;
        if (accepted) {
            delivered = pendingResponse;
            if (!notification.essential()) {
                notificationCount++;
            }
            lastSentAt = now;
            hasSent = true;
            boolean running = "RUNNING".equals(phase);
            ClawBotProgressSettings settings = currentSettings();
            appliedSettings = settings;
            nextReminder = now + reminderIntervalNanos(settings, phase);
            nextCheck = notification.essential() ? now : now + (running
                    ? settings.textIntervalNanos() : settings.waitReminderNanos());
            pending = null;
            pendingResponse = null;
            failures = 0;
        } else {
            failures = Math.min(failures + 1, 31);
            retryAt = now + ClawBotDeliveryRetryPolicy.delayNanos(failures);
        }
    }

    public void close() {
        synchronized (deliveryLock) {
            synchronized (this) {
                closed = true;
                pending = null;
                pendingResponse = null;
            }
        }
    }

    static String latestExcerpt(String text) {
        return latestExcerpt(text, ClawBotProgressSettings.DEFAULT_EXCERPT_MAX_CHARACTERS);
    }

    static String latestExcerpt(String text, int maxCharacters) {
        String visible = text.trim();
        if (visible.length() <= maxCharacters) {
            return visible;
        }
        int start = visible.length() - maxCharacters;
        if (Character.isLowSurrogate(visible.charAt(start))) {
            start++;
        }
        int paragraph = visible.indexOf('\n', start);
        if (paragraph >= start && paragraph < start + maxCharacters / 2) {
            start = paragraph + 1;
        }
        return "…（仅展示最新片段）\n" + visible.substring(start).trim();
    }

    private ClawBotProgressSettings currentSettings() {
        try {
            ClawBotProgressSettings settings = settingsSupplier.get();
            return settings == null ? ClawBotProgressSettings.defaults() : settings;
        } catch (RuntimeException ignored) {
            return ClawBotProgressSettings.defaults();
        }
    }

    private static long reminderIntervalNanos(ClawBotProgressSettings settings, String currentPhase) {
        return "RUNNING".equals(currentPhase) ? settings.idleReminderNanos() : settings.waitReminderNanos();
    }

    record Response(Object message, String text) { }

    public record Notification(long sequence, String text, boolean reminder, boolean essential) { }

    @FunctionalInterface
    public interface Sender {
        boolean send(Notification notification) throws IOException;
    }
}
