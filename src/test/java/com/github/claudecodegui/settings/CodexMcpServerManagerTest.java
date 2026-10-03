package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.io.IOException;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class CodexMcpServerManagerTest {

    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void shouldRenameServerAtomically() throws Exception {
        CodexSettingsManager settings = settingsWithConfig(
                "[mcp_servers.old]\ncommand = \"old-command\"\n"
                        + "[mcp_servers.keep]\ncommand = \"keep-command\"\n");
        CodexMcpServerManager manager = new CodexMcpServerManager(settings, () -> true);

        manager.renameMcpServer("old", server("new", "new-command"));

        Map<String, Object> servers = mcpServers(settings);
        assertFalse(servers.containsKey("old"));
        assertTrue(servers.containsKey("new"));
        assertTrue(servers.containsKey("keep"));
        @SuppressWarnings("unchecked")
        Map<String, Object> renamed = (Map<String, Object>) servers.get("new");
        assertEquals("new-command", renamed.get("command"));
    }

    @Test
    public void shouldLeaveConfigUnchangedWhenRenameTargetExists() throws Exception {
        CodexSettingsManager settings = settingsWithConfig(
                "[mcp_servers.old]\ncommand = \"old-command\"\n"
                        + "[mcp_servers.existing]\ncommand = \"existing-command\"\n");
        CodexMcpServerManager manager = new CodexMcpServerManager(settings, () -> true);
        String before = Files.readString(settings.getConfigTomlPath(), StandardCharsets.UTF_8);

        assertThrows(IOException.class,
                () -> manager.renameMcpServer("old", server("existing", "replacement")));

        assertEquals(before, Files.readString(settings.getConfigTomlPath(), StandardCharsets.UTF_8));
    }

    @Test
    public void shouldRecheckAccessGuardInsideConfigTransaction() throws Exception {
        CodexSettingsManager settings = settingsWithConfig(
                "[mcp_servers.old]\ncommand = \"old-command\"\n");
        CodexMcpServerManager manager = new CodexMcpServerManager(settings, () -> false);
        String before = Files.readString(settings.getConfigTomlPath(), StandardCharsets.UTF_8);

        assertThrows(IOException.class, () -> manager.upsertMcpServer(server("new", "new-command")));

        assertEquals(before, Files.readString(settings.getConfigTomlPath(), StandardCharsets.UTF_8));
    }

    @Test
    public void shouldWriteStdioMessagesAsNewlineDelimitedJson() throws Exception {
        CodexMcpServerManager manager = new CodexMcpServerManager(null, () -> true);
        ByteArrayOutputStream output = new ByteArrayOutputStream();

        manager.writeMcpStdioMessage(output, "{\"message\":\"工具\"}");

        assertEquals("{\"message\":\"工具\"}\n", output.toString(StandardCharsets.UTF_8));
    }

    @Test
    public void shouldReadUtf8NewlineDelimitedStdioMessages() throws Exception {
        CodexMcpServerManager manager = new CodexMcpServerManager(null, () -> true);
        ByteArrayInputStream input = new ByteArrayInputStream(
                "{\"message\":\"工具\"}\r\n".getBytes(StandardCharsets.UTF_8));

        JsonObject response = manager.readMcpStdioMessage(input);

        assertEquals("工具", response.get("message").getAsString());
    }

    @Test
    public void shouldNotQuoteSimpleWindowsShellCommandArguments() {
        CodexMcpServerManager manager = new CodexMcpServerManager(null, () -> true);

        String command = manager.buildWindowsShellCommand(
                "D:\\DevelopmentTool\\NPM\\nodejs\\codegraph.cmd", List.of("serve", "--mcp"));

        assertEquals("D:\\DevelopmentTool\\NPM\\nodejs\\codegraph.cmd serve --mcp", command);
    }

    @Test
    public void shouldQuoteWindowsShellArgumentsThatContainWhitespace() {
        CodexMcpServerManager manager = new CodexMcpServerManager(null, () -> true);

        String command = manager.buildWindowsShellCommand(
                "C:\\Program Files\\CodeGraph\\codegraph.cmd", List.of("serve", "--mcp"));

        assertEquals("\"C:\\Program Files\\CodeGraph\\codegraph.cmd\" serve --mcp", command);
    }

    private CodexSettingsManager settingsWithConfig(String configToml) throws Exception {
        Path tempHome = Files.createTempDirectory("codex-mcp-manager-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = Files.createDirectories(tempHome.resolve(".codex"));
        Files.writeString(codexDir.resolve("config.toml"), configToml, StandardCharsets.UTF_8);
        return new CodexSettingsManager(new Gson());
    }

    private JsonObject server(String id, String command) {
        JsonObject spec = new JsonObject();
        spec.addProperty("command", command);
        JsonObject server = new JsonObject();
        server.addProperty("id", id);
        server.add("server", spec);
        return server;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> mcpServers(CodexSettingsManager settings) throws IOException {
        return (Map<String, Object>) settings.readConfigToml().get("mcp_servers");
    }

    private void useTemporaryHomeDirectory(Path tempHome) throws Exception {
        if (originalHomeDir == null) {
            originalHomeDir = getCachedHomeDirectory();
        }
        setCachedHomeDirectory(tempHome.toString());
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
