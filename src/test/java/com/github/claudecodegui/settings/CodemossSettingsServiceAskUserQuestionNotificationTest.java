package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CodemossSettingsServiceAskUserQuestionNotificationTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void defaultsToDisabledWhenMissingOrNull() throws Exception {
        Path tempHome = Files.createTempDirectory("ask-user-question-notification-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        assertFalse(service.getAskUserQuestionNotificationEnabled());
        assertFalse(service.getAskUserQuestionSoundNotificationEnabled());

        Path configPath = tempHome.resolve(".codemoss").resolve("config.json");
        Files.writeString(configPath,
                "{\"askUserQuestionNotificationEnabled\":null,"
                        + "\"askUserQuestionSoundNotificationEnabled\":null,"
                        + "\"systemNotificationOnlyWhenUnfocused\":null}",
                StandardCharsets.UTF_8);

        assertFalse(service.getAskUserQuestionNotificationEnabled());
        assertFalse(service.getAskUserQuestionSoundNotificationEnabled());
        assertFalse(service.getSystemNotificationOnlyWhenUnfocused());
    }

    @Test
    public void persistsEnabledFlagRoundTrip() throws Exception {
        Path tempHome = Files.createTempDirectory("ask-user-question-notification-persist-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setAskUserQuestionNotificationEnabled(true);
        assertTrue(service.getAskUserQuestionNotificationEnabled());

        JsonObject config = service.readConfig();
        assertTrue(config.get("askUserQuestionNotificationEnabled").getAsBoolean());

        service.setAskUserQuestionNotificationEnabled(false);
        assertFalse(service.getAskUserQuestionNotificationEnabled());
    }

    @Test
    public void persistsSoundEnabledFlagIndependently() throws Exception {
        Path tempHome = Files.createTempDirectory("ask-user-question-sound-notification-persist-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setAskUserQuestionNotificationEnabled(false);
        service.setAskUserQuestionSoundNotificationEnabled(true);

        assertFalse(service.getAskUserQuestionNotificationEnabled());
        assertTrue(service.getAskUserQuestionSoundNotificationEnabled());

        JsonObject config = service.readConfig();
        assertFalse(config.get("askUserQuestionNotificationEnabled").getAsBoolean());
        assertTrue(config.get("askUserQuestionSoundNotificationEnabled").getAsBoolean());
    }

    @Test
    public void persistsSystemNotificationOnlyWhenUnfocusedIndependently() throws Exception {
        Path tempHome = Files.createTempDirectory("system-notification-focus-gate-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setAskUserQuestionNotificationEnabled(true);
        service.setSystemNotificationOnlyWhenUnfocused(true);

        assertTrue(service.getAskUserQuestionNotificationEnabled());
        assertTrue(service.getSystemNotificationOnlyWhenUnfocused());

        JsonObject config = service.readConfig();
        assertTrue(config.get("askUserQuestionNotificationEnabled").getAsBoolean());
        assertTrue(config.get("systemNotificationOnlyWhenUnfocused").getAsBoolean());

        service.setSystemNotificationOnlyWhenUnfocused(false);
        assertFalse(service.getSystemNotificationOnlyWhenUnfocused());
    }

    private void useTemporaryHomeDirectory(Path tempHome) throws Exception {
        if (originalHomeDir == null) {
            originalHomeDir = getCachedHomeDirectory();
        }
        setCachedHomeDirectory(tempHome.toString());
        Files.createDirectories(tempHome.resolve(".codemoss"));
    }

    private String getCachedHomeDirectory() throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private void setCachedHomeDirectory(String homeDir) throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        field.set(null, homeDir);
    }
}
