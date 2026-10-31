package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Assume;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Optional acceptance test against the official CLI, using an isolated home and no account. */
public class CodexConfigCompatibilityNativeTest {
    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void pluginMetadataSeparationPassesNativeStrictValidationAndPreservesNetworkSettings() throws Exception {
        String configuredCommand = System.getenv("CODEX_CLI_TEST_COMMAND");
        Assume.assumeTrue("Set CODEX_CLI_TEST_COMMAND to enable native acceptance", configuredCommand != null);
        List<String> command = new ArrayList<>();
        JsonArray argv = JsonParser.parseString(configuredCommand).getAsJsonArray();
        argv.forEach(value -> command.add(value.getAsString()));
        command.addAll(List.of("app-server", "--strict-config", "--listen", "stdio://"));

        Path root = temporary.getRoot().toPath();
        Path home = temporary.newFolder("native home with spaces").toPath();
        Files.writeString(home.resolve("config.toml"), "model = \"gpt-6.1-sol\"\n"
                + "[sandbox_workspace_write]\nnetwork_access = true\n"
                + "[model_aliases]\n\"gpt-6.1-sol\" = \"vendor/gpt-6.1-sol\"\n"
                + "[mcp_servers.fixture]\ncommand = \"node\"\nenabled = false\n"
                + "[profiles.fixture]\nmodel_reasoning_effort = \"medium\"\n");
        CodexSettingsManager settings = new CodexSettingsManager(new Gson(), home);
        settings.prepareNativeConfig(() -> true);
        assertEquals("vendor/gpt-6.1-sol", settings.resolveModelAlias("gpt-6.1-sol"));

        ProcessBuilder builder = new ProcessBuilder(command).directory(root.toFile());
        var env = builder.environment();
        env.keySet().removeIf(key -> key.matches("(?i).*(API_KEY|TOKEN|SECRET|AUTHORIZATION|NODE_OPTIONS).*"));
        env.put("CODEX_HOME", home.toString());
        env.put("HOME", root.toString());
        env.put("USERPROFILE", root.toString());
        Path stderr = root.resolve("native-stderr.txt");
        builder.redirectError(stderr.toFile());
        Process process = builder.start();
        var executor = Executors.newSingleThreadExecutor();
        List<String> warnings = new ArrayList<>();
        try (var input = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
             var output = new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8)) {
            output.write("{\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"ccgui_config_test\",\"version\":\"0.6.1\"}}}\n");
            output.flush();
            JsonObject initialized = executor.submit(() -> response(input, 1, warnings, stderr)).get(30, TimeUnit.SECONDS);
            assertFalse(initialized.toString(), initialized.has("error"));
            output.write("{\"method\":\"initialized\",\"params\":{}}\n"
                    + "{\"id\":2,\"method\":\"config/read\",\"params\":{\"includeLayers\":false}}\n");
            output.flush();
            JsonObject read = executor.submit(() -> response(input, 2, warnings, stderr)).get(30, TimeUnit.SECONDS);
            assertFalse(read.toString(), read.has("error"));
            JsonObject nativeConfig = read.getAsJsonObject("result").getAsJsonObject("config");
            assertTrue(nativeConfig.getAsJsonObject("sandbox_workspace_write").get("network_access").getAsBoolean());
            assertEquals("gpt-6.1-sol", nativeConfig.get("model").getAsString());
            assertTrue(warnings.toString(), warnings.isEmpty());
            assertFalse(Files.readString(stderr).contains("unrecognized configuration"));
        } finally {
            List<ProcessHandle> descendants = process.descendants().toList();
            descendants.forEach(ProcessHandle::destroyForcibly);
            process.destroyForcibly();
            process.waitFor(5, TimeUnit.SECONDS);
            executor.shutdownNow();
        }
    }

    private static JsonObject response(BufferedReader input, int id, List<String> warnings, Path stderr) throws Exception {
        String line;
        while ((line = input.readLine()) != null) {
            JsonObject message = JsonParser.parseString(line).getAsJsonObject();
            if (message.has("method") && "configWarning".equals(message.get("method").getAsString())) {
                warnings.add(message.toString());
            }
            if (message.has("id") && message.get("id").isJsonPrimitive() && message.get("id").getAsInt() == id) {
                return message;
            }
        }
        throw new AssertionError("Native CLI closed before responding: " + Files.readString(stderr));
    }
}
