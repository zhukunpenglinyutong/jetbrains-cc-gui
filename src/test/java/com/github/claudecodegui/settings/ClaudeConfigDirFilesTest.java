package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.ClaudeConfigDir;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClaudeConfigDirFilesTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private String originalHome;
    private Path home;
    private Path profile;
    private ClaudeSettingsManager settingsManager;
    private McpServerManager mcpManager;

    @Before
    public void setUp() throws Exception {
        home = tmp.newFolder("home").toPath();
        profile = tmp.newFolder("work-profile").toPath();
        Files.createDirectories(home.resolve(".claude"));
        originalHome = cachedHome();
        setCachedHome(home.toString());
        ClaudeConfigDir.setSettingReaderForTests(() -> profile.toString());
        settingsManager = new ClaudeSettingsManager(new Gson(), new ConfigPathManager());
        mcpManager = new McpServerManager(new Gson(), v -> new JsonObject(), c -> { }, settingsManager);
    }

    @After
    public void tearDown() throws Exception {
        ClaudeConfigDir.setSettingReaderForTests(null);
        setCachedHome(originalHome);
    }

    private static String cachedHome() throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private static void setCachedHome(String value) throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        field.set(null, value);
    }

    private static void write(Path file, String content) throws Exception {
        Files.createDirectories(file.getParent());
        Files.writeString(file, content, StandardCharsets.UTF_8);
    }

    private static JsonObject read(Path file) throws Exception {
        return JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
    }

    private static JsonObject provider() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_AUTH_TOKEN", "sk-ant-provider-token");
        env.addProperty("ANTHROPIC_BASE_URL", "https://api.example.invalid");
        JsonObject settingsConfig = new JsonObject();
        settingsConfig.add("env", env);
        JsonObject provider = new JsonObject();
        provider.addProperty("id", "p1");
        provider.addProperty("name", "Provider 1");
        provider.add("settingsConfig", settingsConfig);
        return provider;
    }

    private static JsonObject server(String id) {
        JsonObject spec = new JsonObject();
        spec.addProperty("type", "stdio");
        spec.addProperty("command", "node");
        JsonObject server = new JsonObject();
        server.addProperty("id", id);
        server.addProperty("name", id);
        server.addProperty("enabled", true);
        server.add("server", spec);
        return server;
    }

    private List<String> serverIds() throws Exception {
        return mcpManager.getMcpServers().stream().map(s -> s.get("id").getAsString()).sorted().collect(Collectors.toList());
    }

    @Test
    public void settingsJsonLivesInsideTheConfigDirectory() {
        assertEquals(profile.resolve("settings.json"), new ConfigPathManager().getClaudeSettingsPath());
        assertEquals(profile.resolve("settings.json"), ClaudeConfigDir.settingsJson());
    }

    @Test
    public void settingsJsonStaysUnderDotClaudeWithoutAConfigDirectory() {
        Assume.assumeTrue("CLAUDE_CONFIG_DIR is set in this environment", System.getenv("CLAUDE_CONFIG_DIR") == null);
        ClaudeConfigDir.setSettingReaderForTests(() -> null);

        assertEquals(home.resolve(".claude").resolve("settings.json"), new ConfigPathManager().getClaudeSettingsPath());
    }

    @Test
    public void aProviderIsWrittenIntoTheConfigDirectorysSettings() throws Exception {
        assertTrue(settingsManager.repairMissingProviderFields(provider()));

        JsonObject env = read(profile.resolve("settings.json")).getAsJsonObject("env");
        assertEquals("sk-ant-provider-token", env.get("ANTHROPIC_AUTH_TOKEN").getAsString());
        assertFalse(Files.exists(home.resolve(".claude").resolve("settings.json")));
    }

    @Test
    public void aTokenAlreadyInTheConfigDirectorysSettingsIsNotPairedWithTheProvidersBaseUrl() throws Exception {
        write(profile.resolve("settings.json"), "{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"user-token\"}}");

        assertFalse(settingsManager.repairMissingProviderFields(provider()));

        JsonObject env = read(profile.resolve("settings.json")).getAsJsonObject("env");
        assertEquals("user-token", env.get("ANTHROPIC_AUTH_TOKEN").getAsString());
        assertFalse(env.has("ANTHROPIC_BASE_URL"));
    }

    @Test
    public void aBaseUrlAlreadyInTheConfigDirectorysSettingsIsNotPairedWithTheProvidersToken() throws Exception {
        write(profile.resolve("settings.json"), "{\"env\":{\"ANTHROPIC_BASE_URL\":\"https://user-proxy.example.invalid\"}}");

        assertFalse(settingsManager.repairMissingProviderFields(provider()));

        JsonObject env = read(profile.resolve("settings.json")).getAsJsonObject("env");
        assertEquals("https://user-proxy.example.invalid", env.get("ANTHROPIC_BASE_URL").getAsString());
        assertFalse(env.has("ANTHROPIC_AUTH_TOKEN"));
    }

    @Test
    public void anApiKeyAlreadyInTheConfigDirectorysSettingsIsNotPairedWithTheProvidersBaseUrl() throws Exception {
        write(profile.resolve("settings.json"), "{\"env\":{\"ANTHROPIC_API_KEY\":\"user-key\"}}");

        assertFalse(settingsManager.repairMissingProviderFields(provider()));

        JsonObject env = read(profile.resolve("settings.json")).getAsJsonObject("env");
        assertEquals("user-key", env.get("ANTHROPIC_API_KEY").getAsString());
        assertFalse(env.has("ANTHROPIC_BASE_URL"));
        assertFalse(env.has("ANTHROPIC_AUTH_TOKEN"));
    }

    @Test
    public void aDirectoryWithOtherEnvButNoApiSettingsStillGetsTheProvider() throws Exception {
        write(profile.resolve("settings.json"), "{\"env\":{\"MY_FLAG\":\"1\"}}");

        assertTrue(settingsManager.repairMissingProviderFields(provider()));

        JsonObject env = read(profile.resolve("settings.json")).getAsJsonObject("env");
        assertEquals("1", env.get("MY_FLAG").getAsString());
        assertEquals("sk-ant-provider-token", env.get("ANTHROPIC_AUTH_TOKEN").getAsString());
        assertEquals("https://api.example.invalid", env.get("ANTHROPIC_BASE_URL").getAsString());
    }

    private static JsonObject provider(String id, String token, String baseUrl) {
        JsonObject provider = provider();
        provider.addProperty("id", id);
        JsonObject env = provider.getAsJsonObject("settingsConfig").getAsJsonObject("env");
        env.addProperty("ANTHROPIC_AUTH_TOKEN", token);
        env.addProperty("ANTHROPIC_BASE_URL", baseUrl);
        return provider;
    }

    /** A ProviderManager whose saved providers are {@code p1} and {@code p2}, with {@code current} active. */
    private ProviderManager providerManager(String current) {
        JsonObject providers = new JsonObject();
        providers.add("p1", provider("p1", "token-1", "https://one.example.invalid"));
        providers.add("p2", provider("p2", "token-2", "https://two.example.invalid"));
        JsonObject claude = new JsonObject();
        claude.addProperty("current", current);
        claude.add("providers", providers);
        JsonObject config = new JsonObject();
        config.add("claude", claude);
        return new ProviderManager(new Gson(), v -> config, c -> { }, null, settingsManager);
    }

    private JsonObject profileEnv() throws Exception {
        return read(profile.resolve("settings.json")).getAsJsonObject("env");
    }

    @Test
    public void aFreshDirectoryGetsTheActiveProvider() throws Exception {
        assertFalse(providerManager("p2").applyActiveProviderToConfigDirectory());

        assertEquals("token-2", profileEnv().get("ANTHROPIC_AUTH_TOKEN").getAsString());
        assertEquals("https://two.example.invalid", profileEnv().get("ANTHROPIC_BASE_URL").getAsString());
    }

    /**
     * A provider switch only writes the directory active at the time. Returning to a directory the
     * plugin filled for an earlier provider must bring the current one in, not keep the old one.
     */
    @Test
    public void aDirectoryTheProviderWroteForAnEarlierProviderSwitchesToTheActiveOne() throws Exception {
        settingsManager.applyProviderToClaudeSettings(provider("p1", "token-1", "https://one.example.invalid"));

        assertFalse(providerManager("p2").applyActiveProviderToConfigDirectory());

        assertEquals("token-2", profileEnv().get("ANTHROPIC_AUTH_TOKEN").getAsString());
        assertEquals("https://two.example.invalid", profileEnv().get("ANTHROPIC_BASE_URL").getAsString());
        assertEquals("p2", read(profile.resolve("settings.json")).get("codemossProviderId").getAsString());
    }

    @Test
    public void aDirectoryWithTheActiveProvidersSettingsGetsItsMissingFields() throws Exception {
        write(profile.resolve("settings.json"), "{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"token-2\"},"
                + "\"codemossProviderId\":\"p2\"}");

        assertFalse(providerManager("p2").applyActiveProviderToConfigDirectory());

        assertEquals("https://two.example.invalid", profileEnv().get("ANTHROPIC_BASE_URL").getAsString());
    }

    @Test
    public void aDirectoryWithTheUsersOwnTokenIsKeptAndReported() throws Exception {
        write(profile.resolve("settings.json"), "{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"user-token\"}}");

        assertTrue(providerManager("p2").applyActiveProviderToConfigDirectory());

        assertEquals("user-token", profileEnv().get("ANTHROPIC_AUTH_TOKEN").getAsString());
        assertFalse(profileEnv().has("ANTHROPIC_BASE_URL"));
    }

    /** codemossProviderId alone does not make a value the plugin's: one changed by hand is the user's. */
    @Test
    public void aTokenChangedByHandAfterTheProviderWroteItIsKeptAndReported() throws Exception {
        write(profile.resolve("settings.json"), "{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"user-token\","
                + "\"ANTHROPIC_BASE_URL\":\"https://one.example.invalid\"},\"codemossProviderId\":\"p1\"}");

        assertTrue(providerManager("p2").applyActiveProviderToConfigDirectory());

        assertEquals("user-token", profileEnv().get("ANTHROPIC_AUTH_TOKEN").getAsString());
        assertEquals("https://one.example.invalid", profileEnv().get("ANTHROPIC_BASE_URL").getAsString());
    }

    @Test
    public void mcpServersAreReadFromTheConfigDirectorysClaudeJson() throws Exception {
        write(home.resolve(".claude.json"), "{\"mcpServers\":{\"home-server\":{\"command\":\"node\"}}}");
        write(profile.resolve(".claude.json"), "{\"mcpServers\":{\"profile-server\":{\"command\":\"node\"}}}");

        assertEquals(List.of("profile-server"), serverIds());
    }

    @Test
    public void mcpServersComeFromTheHomeClaudeJsonWithoutAConfigDirectory() throws Exception {
        Assume.assumeTrue("CLAUDE_CONFIG_DIR is set in this environment", System.getenv("CLAUDE_CONFIG_DIR") == null);
        ClaudeConfigDir.setSettingReaderForTests(() -> null);
        write(home.resolve(".claude.json"), "{\"mcpServers\":{\"home-server\":{\"command\":\"node\"}}}");
        write(profile.resolve(".claude.json"), "{\"mcpServers\":{\"profile-server\":{\"command\":\"node\"}}}");

        assertEquals(List.of("home-server"), serverIds());
    }

    @Test
    public void anUnreadableClaudeJsonIsReportedWithTheConfigDirectorysPath() throws Exception {
        write(profile.resolve(".claude.json"), "{ not json");

        try {
            serverIds();
            org.junit.Assert.fail("an unparseable .claude.json must be reported");
        } catch (java.io.IOException e) {
            assertTrue(e.getMessage(), e.getMessage().contains(profile.resolve(".claude.json").toString()));
            assertFalse(e.getMessage(), e.getMessage().contains("~/.claude.json"));
        }
    }

    @Test
    public void addingAnMcpServerWritesTheConfigDirectorysFilesOnly() throws Exception {
        write(profile.resolve(".claude.json"), "{\"mcpServers\":{},\"projects\":{}}");
        write(home.resolve(".claude.json"), "{\"mcpServers\":{\"untouched\":{\"command\":\"node\"}}}");
        String homeBefore = Files.readString(home.resolve(".claude.json"), StandardCharsets.UTF_8);

        mcpManager.upsertMcpServer(server("added"));

        assertTrue(read(profile.resolve(".claude.json")).getAsJsonObject("mcpServers").has("added"));
        assertTrue(read(profile.resolve("settings.json")).getAsJsonObject("mcpServers").has("added"));
        assertEquals(homeBefore, Files.readString(home.resolve(".claude.json"), StandardCharsets.UTF_8));
        assertFalse(Files.exists(home.resolve(".claude").resolve("settings.json")));
    }

    @Test
    public void deletingAnMcpServerRemovesItFromTheConfigDirectoryOnly() throws Exception {
        write(profile.resolve(".claude.json"), "{\"mcpServers\":{\"keep\":{\"command\":\"node\"},\"drop\":{\"command\":\"node\"}}}");

        assertTrue(mcpManager.deleteMcpServer("drop"));

        assertEquals(List.of("keep"), serverIds());
        assertFalse(read(profile.resolve(".claude.json")).getAsJsonObject("mcpServers").has("drop"));
    }

    @Test
    public void theCliLoginAccountIsReadFromTheConfigDirectorysClaudeJson() throws Exception {
        write(home.resolve(".claude.json"), "{\"oauthAccount\":{\"emailAddress\":\"home@example.invalid\"}}");
        write(profile.resolve(".claude.json"), "{\"oauthAccount\":{\"emailAddress\":\"work@example.invalid\",\"name\":\"Work\"}}");

        JsonObject account = settingsManager.readCliLoginAccountInfo();

        assertEquals("work@example.invalid", account.get("emailAddress").getAsString());
    }

    @Test
    public void noCliLoginAccountIsReportedWhenTheConfigDirectoryHasNoClaudeJson() throws Exception {
        write(home.resolve(".claude.json"), "{\"oauthAccount\":{\"emailAddress\":\"home@example.invalid\"}}");

        assertEquals(null, settingsManager.readCliLoginAccountInfo());
    }
}
