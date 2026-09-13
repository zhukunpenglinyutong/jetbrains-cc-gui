package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for the DSH port clamping rules in {@link CodemossSettingsService}:
 * only 1-65535 is persisted, and the default port (3080) is omitted from the
 * config file entirely.
 */
public class CodemossSettingsServiceDshSettingsTest {

    private static final int DSH_DEFAULT_PORT = 3080;

    private String originalHome;

    @After
    public void restoreHome() throws Exception {
        if (originalHome != null) {
            setHome(originalHome);
        }
    }

    @Test
    public void dshPortDefaultsTo3080WhenUnset() throws Exception {
        Path home = newIsolatedHome();

        CodemossSettingsService service = new CodemossSettingsService();
        assertEquals(DSH_DEFAULT_PORT, service.getDshPort());
    }

    @Test
    public void dshPortPersistsCustomValue() throws Exception {
        Path home = newIsolatedHome();

        CodemossSettingsService service = new CodemossSettingsService();
        service.setDshPort(8080);
        assertEquals(8080, service.getDshPort());
        assertEquals(8080, readDshSection(home).get("port").getAsInt());
    }

    @Test
    public void dshPortOmitsDefaultValueFromConfig() throws Exception {
        Path home = newIsolatedHome();

        CodemossSettingsService service = new CodemossSettingsService();
        service.setDshPort(DSH_DEFAULT_PORT);
        assertEquals(DSH_DEFAULT_PORT, service.getDshPort());
        assertFalse(readDshSection(home).has("port"));
    }

    @Test
    public void dshPortClampsOutOfRangeValuesToDefault() throws Exception {
        Path home = newIsolatedHome();

        CodemossSettingsService service = new CodemossSettingsService();
        for (int invalid : new int[]{0, -1, 65536, 70000}) {
            service.setDshPort(invalid);
            assertEquals("port " + invalid, DSH_DEFAULT_PORT, service.getDshPort());
            assertFalse("port " + invalid, readDshSection(home).has("port"));
        }
    }

    @Test
    public void dshPortClampingClearsPreviouslyStoredValue() throws Exception {
        Path home = newIsolatedHome();

        CodemossSettingsService service = new CodemossSettingsService();
        service.setDshPort(8080);
        service.setDshPort(0);
        assertEquals(DSH_DEFAULT_PORT, service.getDshPort());
        assertFalse(readDshSection(home).has("port"));
    }

    // ---------- helpers ----------

    private Path newIsolatedHome() throws Exception {
        Path home = Files.createTempDirectory("dsh-settings-home");
        if (originalHome == null) {
            originalHome = getHome();
        }
        setHome(home.toString());
        Files.createDirectories(home.resolve(".codemoss"));
        return home;
    }

    private static JsonObject readDshSection(Path home) throws Exception {
        Path configFile = home.resolve(".codemoss/config.json");
        assertTrue("config.json should exist after a write", Files.exists(configFile));
        JsonObject config = JsonParser.parseString(Files.readString(configFile)).getAsJsonObject();
        assertTrue("dsh section should exist after a write", config.has("dsh"));
        return config.getAsJsonObject("dsh");
    }

    private static String getHome() throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private static void setHome(String home) throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        field.set(null, home);
    }
}
