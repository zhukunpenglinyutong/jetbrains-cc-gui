package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.github.claudecodegui.util.PlatformUtils;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Tests for {@link ClaudeSettingsManager#repairMissingProviderFields(JsonObject)}.
 *
 * <p>Contract being verified (see also
 * {@code docs/codex/方案A+-智能按需同步实现方案.md}):
 *
 * <ul>
 *   <li>Adds provider-managed fields that are missing from
 *       {@code ~/.claude/settings.json} (the "fill in the blanks" pass).</li>
 *   <li>NEVER overwrites a value the user already has in settings.json.</li>
 *   <li>Per-env-var behavior: missing env keys are added, existing env keys are kept.</li>
 *   <li>Returns {@code false} when no changes are made (so callers can skip logging noise).</li>
 * </ul>
 */
public class ClaudeSettingsManagerRepairTest {

    private String originalHomeDir;
    private Path tempHome;
    private Path settingsPath;
    private ClaudeSettingsManager manager;

    @Before
    public void setUp() throws Exception {
        tempHome = Files.createTempDirectory("claude-repair-test");
        Path claudeDir = tempHome.resolve(".claude");
        Files.createDirectories(claudeDir);
        settingsPath = claudeDir.resolve("settings.json");

        originalHomeDir = getCachedHomeDirectory();
        setCachedHomeDirectory(tempHome.toString());

        manager = new ClaudeSettingsManager(new Gson(), new ConfigPathManager());
    }

    @After
    public void tearDown() throws Exception {
        // Always restore the cached home — including when the original value
        // was null (never initialized) — so later tests see the pristine state.
        setCachedHomeDirectory(originalHomeDir);
        originalHomeDir = null;
        if (tempHome != null) {
            try (java.util.stream.Stream<Path> paths = Files.walk(tempHome)) {
                paths.sorted(Comparator.reverseOrder())
                        .map(Path::toFile)
                        .forEach(File::delete);
            }
            tempHome = null;
        }
    }

    private JsonObject buildProvider(String id, String model) {
        JsonObject provider = new JsonObject();
        provider.addProperty("id", id);
        provider.addProperty("name", "Test Provider " + id);

        JsonObject settingsConfig = new JsonObject();
        settingsConfig.addProperty("model", model);

        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_API_KEY", "sk-ant-provider-key");
        env.addProperty("ANTHROPIC_BASE_URL", "https://api.anthropic.com");
        settingsConfig.add("env", env);

        provider.add("settingsConfig", settingsConfig);
        return provider;
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

    /** A brand-new settings.json (file does not exist) should be filled in. */
    @Test
    public void fillsInMissingFieldsOnFreshInstall() throws Exception {
        assertFalse("precondition: settings.json should not exist", Files.exists(settingsPath));

        boolean changed = manager.repairMissingProviderFields(buildProvider("p1", "claude-sonnet-4-6"));

        assertTrue("repair should report a change on a fresh install", changed);
        assertTrue(Files.exists(settingsPath));

        JsonObject written = manager.readClaudeSettings();
        assertEquals("claude-sonnet-4-6", written.get("model").getAsString());
        assertEquals("sk-ant-provider-key",
                written.getAsJsonObject("env").get("ANTHROPIC_API_KEY").getAsString());
        assertEquals("p1", written.get("codemossProviderId").getAsString());
    }

    /**
     * Existing user values must be preserved verbatim — no overwrite.
     * The preexisting file contains ALL fields the provider would try to add,
     * so the repair pass is expected to be a genuine no-op.
     */
    @Test
    public void doesNotOverwriteExistingModelField() throws Exception {
        String preexisting = "{"
                + "\"model\":\"user-picked-model\","
                + "\"codemossProviderId\":\"p1\","
                + "\"env\":{"
                +     "\"ANTHROPIC_API_KEY\":\"sk-ant-USER-KEY\","
                +     "\"ANTHROPIC_BASE_URL\":\"https://user-proxy.example.com\""
                + "}}";
        Files.writeString(settingsPath, preexisting, StandardCharsets.UTF_8);

        boolean changed = manager.repairMissingProviderFields(
                buildProvider("p1", "claude-sonnet-4-6"));

        assertFalse("repair should be a no-op when every provider field is already present", changed);

        JsonObject after = manager.readClaudeSettings();
        assertEquals("user-picked-model", after.get("model").getAsString());
        assertEquals("sk-ant-USER-KEY",
                after.getAsJsonObject("env").get("ANTHROPIC_API_KEY").getAsString());
        assertEquals("https://user-proxy.example.com",
                after.getAsJsonObject("env").get("ANTHROPIC_BASE_URL").getAsString());
    }

    /** Missing env keys are added; existing ones are not touched. */
    @Test
    public void repairsMissingEnvKeysOnly() throws Exception {
        String preexisting = "{\"env\":{\"ANTHROPIC_API_KEY\":\"sk-USER\"}}";
        Files.writeString(settingsPath, preexisting, StandardCharsets.UTF_8);

        boolean changed = manager.repairMissingProviderFields(
                buildProvider("p1", "claude-sonnet-4-6"));

        assertTrue("should add the missing env keys", changed);
        JsonObject env = manager.readClaudeSettings().getAsJsonObject("env");
        assertEquals("sk-USER", env.get("ANTHROPIC_API_KEY").getAsString());
        assertEquals("https://api.anthropic.com", env.get("ANTHROPIC_BASE_URL").getAsString());
    }

    /** codemossProviderId is only set when missing — never overwritten. */
    @Test
    public void doesNotOverwriteExistingCodemossProviderId() throws Exception {
        String preexisting = "{\"codemossProviderId\":\"user-pinned-id\"}";
        Files.writeString(settingsPath, preexisting, StandardCharsets.UTF_8);

        manager.repairMissingProviderFields(buildProvider("p1", "claude-sonnet-4-6"));

        assertEquals("user-pinned-id",
                manager.readClaudeSettings().get("codemossProviderId").getAsString());
    }

    /** Top-level user fields that are not provider-managed are left untouched. */
    @Test
    public void preservesUserAddedTopLevelFields() throws Exception {
        String preexisting = "{\"hooks\":{\"PreToolUse\":[]},\"custom\":42}";
        Files.writeString(settingsPath, preexisting, StandardCharsets.UTF_8);

        manager.repairMissingProviderFields(buildProvider("p1", "claude-sonnet-4-6"));

        JsonObject after = manager.readClaudeSettings();
        assertTrue("user-added top-level field 'hooks' must remain", after.has("hooks"));
        assertEquals(42, after.get("custom").getAsInt());
    }

    /**
     * A provider without settingsConfig (e.g. written by an older plugin
     * version) is a graceful no-op — it must not throw on every window open,
     * and must not create settings.json.
     */
    @Test
    public void missingSettingsConfigIsAGracefulNoOp() throws Exception {
        JsonObject provider = new JsonObject();
        provider.addProperty("id", "p1");

        boolean changed = manager.repairMissingProviderFields(provider);

        assertFalse("missing settingsConfig must report no change", changed);
        assertFalse("settings.json must not be created", Files.exists(settingsPath));
    }
}
