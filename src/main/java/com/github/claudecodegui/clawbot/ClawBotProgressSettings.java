package com.github.claudecodegui.clawbot;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.util.concurrent.TimeUnit;

/** Immutable intervals used when publishing progress messages for an active Claw Bot turn. */
public record ClawBotProgressSettings(
        int textIntervalMinutes,
        int idleReminderMinutes,
        int waitReminderMinutes,
        int initialCheckDelaySeconds,
        int maxNotifications,
        int excerptMaxCharacters,
        int sessionIdleTimeoutMinutes,
        int minSendIntervalSeconds) {

    static final int DEFAULT_TEXT_INTERVAL_MINUTES = 1;
    static final int DEFAULT_IDLE_REMINDER_MINUTES = 5;
    static final int DEFAULT_WAIT_REMINDER_MINUTES = 10;
    static final int DEFAULT_INITIAL_CHECK_DELAY_SECONDS = 30;
    static final int DEFAULT_MAX_NOTIFICATIONS = 6;
    static final int DEFAULT_MIN_SEND_INTERVAL_SECONDS = 120;
    static final int DEFAULT_EXCERPT_MAX_CHARACTERS = 800;
    static final int DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES = 30;
    static final int MIN_INTERVAL_MINUTES = 1;
    static final int MAX_INTERVAL_MINUTES = 24 * 60;
    static final int MIN_INITIAL_CHECK_DELAY_SECONDS = 15;
    static final int MAX_INITIAL_CHECK_DELAY_SECONDS = 5 * 60;
    static final int MIN_MAX_NOTIFICATIONS = 0;
    static final int MAX_MAX_NOTIFICATIONS = 6;
    static final int MIN_EXCERPT_MAX_CHARACTERS = 100;
    static final int MAX_EXCERPT_MAX_CHARACTERS = 3_500;

    public ClawBotProgressSettings(int textIntervalMinutes, int idleReminderMinutes, int waitReminderMinutes,
            int initialCheckDelaySeconds, int maxNotifications, int excerptMaxCharacters, int sessionIdleTimeoutMinutes) {
        this(textIntervalMinutes, idleReminderMinutes, waitReminderMinutes, initialCheckDelaySeconds,
                maxNotifications, excerptMaxCharacters, sessionIdleTimeoutMinutes, DEFAULT_MIN_SEND_INTERVAL_SECONDS);
    }

    public ClawBotProgressSettings(int textIntervalMinutes, int idleReminderMinutes, int waitReminderMinutes) {
        this(textIntervalMinutes, idleReminderMinutes, waitReminderMinutes,
                DEFAULT_INITIAL_CHECK_DELAY_SECONDS, DEFAULT_MAX_NOTIFICATIONS,
                DEFAULT_EXCERPT_MAX_CHARACTERS, DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES);
    }

    public ClawBotProgressSettings {
        textIntervalMinutes = validateRange(textIntervalMinutes, 1, 60, "textIntervalMinutes");
        idleReminderMinutes = idleReminderMinutes == 0 ? 0 : validateRange(idleReminderMinutes, 5, 60, "idleReminderMinutes");
        waitReminderMinutes = waitReminderMinutes == 0 ? 0 : validateRange(waitReminderMinutes, 10, 120, "waitReminderMinutes");
        initialCheckDelaySeconds = validateRange(initialCheckDelaySeconds,
                MIN_INITIAL_CHECK_DELAY_SECONDS, MAX_INITIAL_CHECK_DELAY_SECONDS, "initialCheckDelaySeconds");
        maxNotifications = validateRange(maxNotifications,
                MIN_MAX_NOTIFICATIONS, MAX_MAX_NOTIFICATIONS, "maxNotifications");
        excerptMaxCharacters = validateRange(excerptMaxCharacters,
                MIN_EXCERPT_MAX_CHARACTERS, MAX_EXCERPT_MAX_CHARACTERS, "excerptMaxCharacters");
        sessionIdleTimeoutMinutes = validateMinutes(sessionIdleTimeoutMinutes, "sessionIdleTimeoutMinutes");
        minSendIntervalSeconds = validateRange(minSendIntervalSeconds, 120, 3600, "minSendIntervalSeconds");
    }

    public static ClawBotProgressSettings defaults() {
        return new ClawBotProgressSettings(
                DEFAULT_TEXT_INTERVAL_MINUTES,
                DEFAULT_IDLE_REMINDER_MINUTES,
                DEFAULT_WAIT_REMINDER_MINUTES,
                DEFAULT_INITIAL_CHECK_DELAY_SECONDS,
                DEFAULT_MAX_NOTIFICATIONS,
                DEFAULT_EXCERPT_MAX_CHARACTERS,
                DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES);
    }

    static ClawBotProgressSettings fromJson(JsonObject object) throws IOException {
        if (object == null) {
            throw new IOException("CLAWBOT_PROGRESS_SETTINGS_INVALID");
        }
        // Migrate previously valid settings field by field, preserving unrelated values.
        object = object.deepCopy();
        migrateInteger(object, "maxNotifications", 0, 100, 0, MAX_MAX_NOTIFICATIONS);
        migrateInteger(object, "excerptMaxCharacters", 100, 4000, 100, MAX_EXCERPT_MAX_CHARACTERS);
        migrateInteger(object, "initialCheckDelaySeconds", 1, 300, MIN_INITIAL_CHECK_DELAY_SECONDS, 300);
        migrateInteger(object, "textIntervalMinutes", 1, MAX_INTERVAL_MINUTES, 1, 60);
        migrateReminder(object, "idleReminderMinutes", 5, 60);
        migrateReminder(object, "waitReminderMinutes", 10, 120);
        return new ClawBotProgressSettings(
                readMinutes(object, "textIntervalMinutes", DEFAULT_TEXT_INTERVAL_MINUTES),
                readInteger(object, "idleReminderMinutes", DEFAULT_IDLE_REMINDER_MINUTES, 0, 60),
                readInteger(object, "waitReminderMinutes", DEFAULT_WAIT_REMINDER_MINUTES, 0, 120),
                readInteger(object, "initialCheckDelaySeconds", DEFAULT_INITIAL_CHECK_DELAY_SECONDS,
                        MIN_INITIAL_CHECK_DELAY_SECONDS, MAX_INITIAL_CHECK_DELAY_SECONDS),
                readInteger(object, "maxNotifications", DEFAULT_MAX_NOTIFICATIONS,
                        MIN_MAX_NOTIFICATIONS, MAX_MAX_NOTIFICATIONS),
                readInteger(object, "excerptMaxCharacters", DEFAULT_EXCERPT_MAX_CHARACTERS,
                        MIN_EXCERPT_MAX_CHARACTERS, MAX_EXCERPT_MAX_CHARACTERS),
                readMinutes(object, "sessionIdleTimeoutMinutes", DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES),
                readInteger(object, "minSendIntervalSeconds", DEFAULT_MIN_SEND_INTERVAL_SECONDS, 120, 3600));
    }

    static ClawBotProgressSettings fromUpdatePayload(JsonObject object) throws IOException {
        return fromUpdatePayload(object, defaults());
    }

    static ClawBotProgressSettings fromUpdatePayload(
            JsonObject object, ClawBotProgressSettings fallback) throws IOException {
        if (object == null || !object.has("textIntervalMinutes")
                || !object.has("idleReminderMinutes") || !object.has("waitReminderMinutes")) {
            throw new IOException("CLAWBOT_PROGRESS_SETTINGS_INVALID");
        }
        ClawBotProgressSettings safeFallback = fallback == null ? defaults() : fallback;
        int idle = readInteger(object, "idleReminderMinutes", -1, 0, 60);
        int wait = readInteger(object, "waitReminderMinutes", -1, 0, 120);
        if ((idle != 0 && idle < 5) || (wait != 0 && wait < 10)) {
            throw new IOException("CLAWBOT_PROGRESS_SETTINGS_INVALID");
        }
        return new ClawBotProgressSettings(
                readInteger(object, "textIntervalMinutes", -1, 1, 60),
                idle,
                wait,
                readInteger(object, "initialCheckDelaySeconds", safeFallback.initialCheckDelaySeconds(),
                        MIN_INITIAL_CHECK_DELAY_SECONDS, MAX_INITIAL_CHECK_DELAY_SECONDS),
                readInteger(object, "maxNotifications", safeFallback.maxNotifications(),
                        MIN_MAX_NOTIFICATIONS, MAX_MAX_NOTIFICATIONS),
                readInteger(object, "excerptMaxCharacters", safeFallback.excerptMaxCharacters(),
                        MIN_EXCERPT_MAX_CHARACTERS, MAX_EXCERPT_MAX_CHARACTERS),
                readMinutes(object, "sessionIdleTimeoutMinutes", safeFallback.sessionIdleTimeoutMinutes()),
                readInteger(object, "minSendIntervalSeconds", safeFallback.minSendIntervalSeconds(), 120, 3600));
    }

    JsonObject toJson() {
        JsonObject object = new JsonObject();
        object.addProperty("textIntervalMinutes", textIntervalMinutes);
        object.addProperty("idleReminderMinutes", idleReminderMinutes);
        object.addProperty("waitReminderMinutes", waitReminderMinutes);
        object.addProperty("initialCheckDelaySeconds", initialCheckDelaySeconds);
        object.addProperty("maxNotifications", maxNotifications);
        object.addProperty("excerptMaxCharacters", excerptMaxCharacters);
        object.addProperty("sessionIdleTimeoutMinutes", sessionIdleTimeoutMinutes);
        object.addProperty("minSendIntervalSeconds", minSendIntervalSeconds);
        return object;
    }

    long textIntervalNanos() {
        return TimeUnit.MINUTES.toNanos(textIntervalMinutes);
    }

    long minSendIntervalNanos() {
        return TimeUnit.SECONDS.toNanos(minSendIntervalSeconds);
    }

    private static void migrateInteger(JsonObject object, String name, int oldMin, int oldMax, int min, int max) throws IOException {
        if (object.has(name)) {
            int value = readInteger(object, name, min, oldMin, oldMax);
            object.addProperty(name, Math.max(min, Math.min(max, value)));
        }
    }

    private static void migrateReminder(JsonObject object, String name, int min, int max) throws IOException {
        if (object.has(name)) {
            int value = readInteger(object, name, min, 0, MAX_INTERVAL_MINUTES);
            object.addProperty(name, value == 0 ? 0 : Math.max(min, Math.min(max, value)));
        }
    }

    long idleReminderNanos() {
        return TimeUnit.MINUTES.toNanos(idleReminderMinutes);
    }

    long waitReminderNanos() {
        return TimeUnit.MINUTES.toNanos(waitReminderMinutes);
    }

    long initialCheckDelayNanos() {
        return TimeUnit.SECONDS.toNanos(initialCheckDelaySeconds);
    }

    long sessionIdleTimeoutMillis() {
        return TimeUnit.MINUTES.toMillis(sessionIdleTimeoutMinutes);
    }

    private static int readMinutes(JsonObject object, String name, int fallback) throws IOException {
        return readInteger(object, name, fallback, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES);
    }

    private static int readInteger(JsonObject object, String name, int fallback, int minimum, int maximum)
            throws IOException {
        JsonElement value = object.get(name);
        if (value == null || value.isJsonNull()) {
            return fallback;
        }
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
            throw new IOException("CLAWBOT_PROGRESS_SETTINGS_INVALID");
        }
        try {
            int minutes = value.getAsInt();
            if (value.getAsDouble() != minutes) {
                throw new NumberFormatException("not an integer");
            }
            return validateRange(minutes, minimum, maximum, name);
        } catch (RuntimeException error) {
            throw new IOException("CLAWBOT_PROGRESS_SETTINGS_INVALID", error);
        }
    }

    private static int readRequiredMinutes(JsonObject object, String name) throws IOException {
        JsonElement value = object.get(name);
        if (value == null || value.isJsonNull()) {
            throw new IOException("CLAWBOT_PROGRESS_SETTINGS_INVALID");
        }
        return readMinutes(object, name, MIN_INTERVAL_MINUTES);
    }

    private static int validateMinutes(int minutes, String name) {
        return validateRange(minutes, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, name);
    }

    private static int validateRange(int value, int minimum, int maximum, String name) {
        if (value < minimum || value > maximum) {
            throw new IllegalArgumentException("Invalid " + name);
        }
        return value;
    }
}
