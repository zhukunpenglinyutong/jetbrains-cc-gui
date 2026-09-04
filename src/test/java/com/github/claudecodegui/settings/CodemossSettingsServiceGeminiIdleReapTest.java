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

    @Test
    public void shouldClampNegativeSetterInputToDisabledZero() throws Exception {
        // Review fix L3: pins the setter's fail-safe direction — a negative
        // (only reachable via a hand-edited payload; the webview clamps before
        // sending) is normalized to 0 = disabled, never persisted verbatim as
        // a negative. 0 matches the ai-bridge's parse of the same value.
        Path tempHome = Files.createTempDirectory("gemini-reap-negative-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        invokeSetGeminiIdleReapMinutes(service, -5);
        assertEquals("a negative window must clamp to disabled (0)", 0,
                invokeGetGeminiIdleReapMinutes(service));
        String raw = Files.readString(Path.of(service.getConfigPath()));
        // Gson here pretty-prints ("key": 0), so accept either spacing.
        boolean carriesClampedZero = raw.contains("\"idleReapMinutes\": 0")
                || raw.contains("\"idleReapMinutes\":0");
        org.junit.Assert.assertTrue(
                "the file must carry the clamped 0, not the raw negative",
                carriesClampedZero && !raw.contains("-5"));
    }

    @Test
    public void shouldDropTheStoredKeyWhenTheDefaultIsRestored() throws Exception {
        // Review fix L3: the default (30) is the absent-key reading, so saving
        // it back must remove the key and keep the config file clean — the
        // file then keeps answering the default even if DEFAULT ever moves.
        Path tempHome = Files.createTempDirectory("gemini-reap-default-key-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        invokeSetGeminiIdleReapMinutes(service, 15);
        String withKey = Files.readString(Path.of(service.getConfigPath()));
        org.junit.Assert.assertTrue("the non-default window must be stored",
                withKey.contains("\"idleReapMinutes\""));

        invokeSetGeminiIdleReapMinutes(service, 30);
        String raw = Files.readString(Path.of(service.getConfigPath()));
        org.junit.Assert.assertTrue(
                "restoring the default must remove the idleReapMinutes key",
                !raw.contains("\"idleReapMinutes\""));
        assertEquals("the absent key still reads as the default", 30,
                invokeGetGeminiIdleReapMinutes(service));
    }

    @Test
    public void shouldReadHandEditedGarbageAsTheDefault() throws Exception {
        // Review fix L3: pins the getter's documented asymmetry vs the
        // ai-bridge. UnPARSEABLE values read as the default 30 here (this is
        // the "settings chain is alive" reading), while the ai-bridge disables
        // on the same input — an unknown value must never become a surprise
        // kill on either side; the bridge side is the last line of defense.
        // Parseable negatives, by contrast, clamp to 0 on BOTH sides.
        Path tempHome = Files.createTempDirectory("gemini-reap-garbage-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        Files.writeString(Path.of(service.getConfigPath()),
                "{\"gemini\":{\"idleReapMinutes\":\"not-a-number\"}}");
        assertEquals("a hand-edited unparseable window reads as the default",
                30, invokeGetGeminiIdleReapMinutes(service));
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
