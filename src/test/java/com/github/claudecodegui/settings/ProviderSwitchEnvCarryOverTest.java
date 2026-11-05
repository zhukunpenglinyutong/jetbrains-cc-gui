package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

/**
 * End to end through {@link ProviderManager}: env values a provider wrote into
 * ~/.claude/settings.json leave with it on the next switch, while values the
 * user changed by hand stay.
 */
public class ProviderSwitchEnvCarryOverTest {

    private String originalHomeDir;
    private Path tempHome;
    private Path settingsPath;
    private AtomicReference<JsonObject> config;
    private ProviderManager manager;

    @Before
    public void setUp() throws Exception {
        tempHome = Files.createTempDirectory("provider-switch-env-test");
        Files.createDirectories(tempHome.resolve(".claude"));
        settingsPath = tempHome.resolve(".claude").resolve("settings.json");
        originalHomeDir = cachedHomeDirectory();
        setCachedHomeDirectory(tempHome.toString());

        config = new AtomicReference<>(JsonParser.parseString("{\"claude\":{\"current\":\"minimax\",\"providers\":{"
                + "\"minimax\":{\"name\":\"MiniMax\",\"settingsConfig\":{\"env\":{"
                + "\"ANTHROPIC_BASE_URL\":\"https://api.minimaxi.com/anthropic\","
                + "\"ANTHROPIC_AUTH_TOKEN\":\"minimax-token\","
                + "\"API_TIMEOUT_MS\":\"3000000\"}}},"
                + "\"deepseek\":{\"name\":\"DeepSeek\",\"settingsConfig\":{\"env\":{"
                + "\"ANTHROPIC_BASE_URL\":\"https://api.deepseek.com/anthropic\","
                + "\"ANTHROPIC_AUTH_TOKEN\":\"deepseek-token\"}}}}}}").getAsJsonObject());
        Gson gson = new Gson();
        manager = new ProviderManager(gson, ignored -> config.get(),
                updated -> config.set(updated.deepCopy()), null,
                new ClaudeSettingsManager(gson, new ConfigPathManager()));
    }

    @After
    public void tearDown() throws Exception {
        setCachedHomeDirectory(originalHomeDir);
        try (java.util.stream.Stream<Path> paths = Files.walk(tempHome)) {
            paths.sorted(Comparator.reverseOrder()).map(Path::toFile).forEach(File::delete);
        }
    }

    @Test
    public void thePresetTimeoutDoesNotFollowTheUserToTheNextProvider() throws Exception {
        manager.applyActiveProviderToClaudeSettings();
        assertEquals("3000000", env().get("API_TIMEOUT_MS").getAsString());

        manager.switchClaudeProvider("deepseek");
        manager.applyActiveProviderToClaudeSettings();

        assertFalse(env().has("API_TIMEOUT_MS"));
        assertEquals("https://api.deepseek.com/anthropic", env().get("ANTHROPIC_BASE_URL").getAsString());
    }

    @Test
    public void aTimeoutTheUserRaisedByHandSurvivesTheSwitch() throws Exception {
        manager.applyActiveProviderToClaudeSettings();
        JsonObject settings = read();
        settings.getAsJsonObject("env").addProperty("API_TIMEOUT_MS", "900000");
        Files.writeString(settingsPath, settings.toString(), StandardCharsets.UTF_8);

        manager.switchClaudeProvider("deepseek");
        manager.applyActiveProviderToClaudeSettings();

        assertEquals("900000", env().get("API_TIMEOUT_MS").getAsString());
    }

    @Test
    public void reapplyingAnEditedActiveProviderUsesTheUpdateEntryPointToo() throws Exception {
        manager.applyActiveProviderToClaudeSettings();
        manager.switchClaudeProvider("deepseek");

        manager.applyProviderToClaudeSettings(manager.getActiveClaudeProvider());

        assertFalse(env().has("API_TIMEOUT_MS"));
    }

    @Test
    public void removingAValueFromTheActiveProviderAlsoRemovesItFromSettings() throws Exception {
        manager.applyActiveProviderToClaudeSettings();
        JsonObject beforeEdit = manager.getSavedClaudeProvider("minimax");

        manager.updateClaudeProvider("minimax", JsonParser.parseString("{\"settingsConfig\":{\"env\":{"
                + "\"ANTHROPIC_BASE_URL\":\"https://api.minimaxi.com/anthropic\","
                + "\"ANTHROPIC_AUTH_TOKEN\":\"minimax-token\"}}}").getAsJsonObject());
        manager.applyProviderToClaudeSettings(manager.getActiveClaudeProvider(), beforeEdit);

        assertFalse(env().has("API_TIMEOUT_MS"));
        assertEquals("minimax-token", env().get("ANTHROPIC_AUTH_TOKEN").getAsString());
    }

    @Test
    public void editingTheActiveProviderKeepsAValueTheUserChangedByHand() throws Exception {
        manager.applyActiveProviderToClaudeSettings();
        JsonObject settings = read();
        settings.getAsJsonObject("env").addProperty("API_TIMEOUT_MS", "900000");
        Files.writeString(settingsPath, settings.toString(), StandardCharsets.UTF_8);
        JsonObject beforeEdit = manager.getSavedClaudeProvider("minimax");

        manager.updateClaudeProvider("minimax", JsonParser.parseString("{\"settingsConfig\":{\"env\":{"
                + "\"ANTHROPIC_AUTH_TOKEN\":\"rotated-token\"}}}").getAsJsonObject());
        manager.applyProviderToClaudeSettings(manager.getActiveClaudeProvider(), beforeEdit);

        assertEquals("900000", env().get("API_TIMEOUT_MS").getAsString());
        assertEquals("rotated-token", env().get("ANTHROPIC_AUTH_TOKEN").getAsString());
    }

    private JsonObject env() throws Exception {
        return read().getAsJsonObject("env");
    }

    private JsonObject read() throws Exception {
        return JsonParser.parseString(Files.readString(settingsPath, StandardCharsets.UTF_8)).getAsJsonObject();
    }

    private static String cachedHomeDirectory() throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private static void setCachedHomeDirectory(String homeDir) throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        field.set(null, homeDir);
    }
}
