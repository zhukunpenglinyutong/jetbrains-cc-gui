package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertFalse;

/**
 * Tests for per-project env file configuration in CodemossSettingsService.
 *
 * Covers:
 * - Per-project env file override with global default fallback
 * - Legacy string-to-object migration
 * - The three states reported by getEnvFile(): unconfigured (null), explicitly
 *   configured (a path), and explicitly opted out (ENV_FILE_DISABLED)
 */
public class CodemossSettingsServiceEnvFileTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    // ---- getEnvFile(projectPath) tests ----

    @Test
    public void shouldReturnNullWhenEnvFileNotConfigured() throws Exception {
        Path tempHome = Files.createTempDirectory("envfile-null-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        assertNull(service.getEnvFile("/some/project/path"));
    }

    @Test
    public void shouldReturnProjectSpecificEnvFile() throws Exception {
        Path tempHome = Files.createTempDirectory("envfile-project-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setEnvFile("/projects/project-a", ".env.ai");

        String result = service.getEnvFile("/projects/project-a");
        assertNotNull(result);
        assertEquals(".env.ai", result);
    }

    @Test
    public void shouldFallBackToDefaultWhenProjectNotConfigured() throws Exception {
        Path tempHome = Files.createTempDirectory("envfile-fallback-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setEnvFile("default", "/global/.env");
        service.setEnvFile("/projects/project-a", ".env.ai");

        // Query for a different project → should get the default
        String result = service.getEnvFile("/projects/project-b");
        assertNotNull(result);
        assertEquals("/global/.env", result);
    }

    @Test
    public void shouldPrioritizeProjectOverDefault() throws Exception {
        Path tempHome = Files.createTempDirectory("envfile-priority-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setEnvFile("default", "/global/.env");
        service.setEnvFile("/projects/project-a", ".env.ai");

        String result = service.getEnvFile("/projects/project-a");
        assertEquals(".env.ai", result);
    }

    // ---- setEnvFile(projectPath) tests ----

    @Test
    public void shouldSetProjectSpecificEnvFile() throws Exception {
        Path tempHome = Files.createTempDirectory("envfile-set-project-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setEnvFile("/projects/myproject", ".env.local");

        String result = service.getEnvFile("/projects/myproject");
        assertEquals(".env.local", result);

        // Other projects should NOT see this value
        assertNull(service.getEnvFile("/projects/other"));
    }

    @Test
    public void shouldSetGlobalDefaultWhenProjectPathIsNull() throws Exception {
        Path tempHome = Files.createTempDirectory("envfile-default-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setEnvFile(null, ".env");

        String result = service.getEnvFile(null);
        assertEquals(".env", result);

        // Also accessible without project path
        String result2 = service.getEnvFile("/any/project");
        assertEquals(".env", result2);
    }

    @Test
    public void shouldRecordOptOutWhenClearingProjectEnvFile() throws Exception {
        Path tempHome = Files.createTempDirectory("envfile-clear-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setEnvFile("/projects/project-a", ".env.ai");
        service.setEnvFile("default", ".env");

        // Clearing the field is an explicit opt-out, not a "fall back to default".
        service.setEnvFile("/projects/project-a", null);

        String result = service.getEnvFile("/projects/project-a");
        assertTrue(CodemossSettingsService.isEnvFileDisabled(result));
    }

    @Test
    public void shouldRecordOptOutWhenClearingDefault() throws Exception {
        Path tempHome = Files.createTempDirectory("envfile-clear-default-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setEnvFile(null, ".env");
        service.setEnvFile(null, null);

        assertTrue(CodemossSettingsService.isEnvFileDisabled(service.getEnvFile(null)));
        assertTrue(CodemossSettingsService.isEnvFileDisabled(service.getEnvFile("/any/project")));
    }

    @Test
    public void shouldResetToAutoDiscoveryOnReset() throws Exception {
        Path tempHome = Files.createTempDirectory("envfile-reset-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setEnvFile("/projects/project-a", ".env.ai");
        service.setEnvFile("/projects/project-a", null);
        service.resetEnvFile("/projects/project-a");

        // Back to the unconfigured state → callers auto-discover <project>/.env again
        assertNull(service.getEnvFile("/projects/project-a"));
    }

    @Test
    public void shouldNotResurrectPreviousPathAfterClear() throws Exception {
        Path tempHome = Files.createTempDirectory("envfile-roundtrip-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setEnvFile("default", "/global/.env");
        service.setEnvFile("/projects/project-a", ".env.ai");
        service.setEnvFile("/projects/project-a", null);

        // A per-project opt-out outranks the global default: the previously
        // configured path must not come back, and neither must the default.
        String result = service.getEnvFile("/projects/project-a");
        assertTrue(CodemossSettingsService.isEnvFileDisabled(result));
        assertEquals("/global/.env", service.getEnvFile("/projects/project-b"));
    }

    // ---- Legacy migration tests ----

    @Test
    public void shouldMigrateLegacyStringEnvFileToDefault() throws Exception {
        Path tempHome = Files.createTempDirectory("envfile-legacy-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        // Simulate legacy storage: store a plain string under "envFile"
        service.setEnvFile(null, "/legacy/path/.env");

        // Should be retrievable as default
        String result = service.getEnvFile("/any/project");
        assertNotNull(result);
        assertEquals("/legacy/path/.env", result);
    }

    @Test
    public void shouldHandleEmptyStringAsOptOut() throws Exception {
        Path tempHome = Files.createTempDirectory("envfile-empty-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setEnvFile("/projects/project-a", ".env.ai");
        service.setEnvFile("/projects/project-a", "");

        // Empty string = the user cleared the field on purpose → explicit opt-out
        assertTrue(CodemossSettingsService.isEnvFileDisabled(service.getEnvFile("/projects/project-a")));
    }

    @Test
    public void shouldHandleWhitespaceOnlyStringAsOptOut() throws Exception {
        Path tempHome = Files.createTempDirectory("envfile-whitespace-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setEnvFile("/projects/project-a", ".env.ai");
        service.setEnvFile("/projects/project-a", "   ");

        assertTrue(CodemossSettingsService.isEnvFileDisabled(service.getEnvFile("/projects/project-a")));
    }

    @Test
    public void shouldMigrateLegacyOptOutSentinel() throws Exception {
        Path tempHome = Files.createTempDirectory("envfile-legacy-disabled-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setEnvFile(null, CodemossSettingsService.ENV_FILE_DISABLED);

        assertTrue(CodemossSettingsService.isEnvFileDisabled(service.getEnvFile(null)));
        assertTrue(CodemossSettingsService.isEnvFileDisabled(service.getEnvFile("/any/project")));
    }

    // ---- Helpers ----

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
