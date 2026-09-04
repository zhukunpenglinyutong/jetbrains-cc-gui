package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

/**
 * Story 1.10: the {@code gemini.idleReapMinutes} settings block — the user
 * control behind the silence-window watchdog (disable with 0, resize with a
 * positive count of minutes). Mirrors the UiFontConfig test's isolation
 * (temp home via {@code PlatformUtils.cachedRealHomeDir}) and its reflection
 * invocation so the red phase is behavioral ("method not implemented yet")
 * rather than a compile break.
 *
 * <p>Pinned contract (from the story): getter/setter named after the grok
 * block's {@code getGrokAuthMethod}/{@code setGrokAuthMethod} pattern,
 * default 30, 0 = disabled, stored under the {@code gemini} config object.
 */
public class CodemossSettingsServiceGeminiIdleReapTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void shouldDefaultGeminiIdleReapMinutesToThirty() throws Exception {
        Path tempHome = Files.createTempDirectory("gemini-reap-default-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        assertEquals(30, invokeGetGeminiIdleReapMinutes(service));
    }

    @Test
    public void shouldRoundTripGeminiIdleReapMinutesIncludingDisabledZero() throws Exception {
        Path tempHome = Files.createTempDirectory("gemini-reap-roundtrip-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();

        invokeSetGeminiIdleReapMinutes(service, 0);
        assertEquals("0 disables automatic reaping and must persist verbatim",
                0, invokeGetGeminiIdleReapMinutes(service));

        invokeSetGeminiIdleReapMinutes(service, 45);
        assertEquals("a resized window persists as the exact integer",
                45, invokeGetGeminiIdleReapMinutes(service));
    }

    @Test
    public void shouldKeepGeminiIdleReapMinutesInsideTheGeminiConfigBlock() throws Exception {
        Path tempHome = Files.createTempDirectory("gemini-reap-block-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        invokeSetGeminiIdleReapMinutes(service, 15);

        // The block is the story's pinned name — the ai-bridge carriage and
        // the webview field both key off "gemini.idleReapMinutes".
        String raw = Files.readString(Path.of(service.getConfigPath()));
        org.junit.Assert.assertTrue(
                "config.json must carry {\"gemini\":{\"idleReapMinutes\":...}}",
                raw.contains("\"gemini\"") && raw.contains("\"idleReapMinutes\""));
    }

    private int invokeGetGeminiIdleReapMinutes(CodemossSettingsService service) throws Exception {
        Method method;
        try {
            method = CodemossSettingsService.class.getMethod("getGeminiIdleReapMinutes");
        } catch (NoSuchMethodException e) {
            fail("CodemossSettingsService should expose getGeminiIdleReapMinutes()");
            throw e;
        }
        return (int) method.invoke(service);
    }

    private void invokeSetGeminiIdleReapMinutes(CodemossSettingsService service, int minutes)
            throws Exception {
        Method method;
        try {
            method = CodemossSettingsService.class.getMethod("setGeminiIdleReapMinutes", int.class);
        } catch (NoSuchMethodException e) {
            fail("CodemossSettingsService should expose setGeminiIdleReapMinutes(int)");
            throw e;
        }
        method.invoke(service, minutes);
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
