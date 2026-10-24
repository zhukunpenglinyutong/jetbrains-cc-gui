package com.github.claudecodegui.dependency;

import com.google.gson.JsonArray;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Path;
import java.util.ArrayList;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

/** Opt-in registry integration using the installed npm and isolated, disposable cache. */
public class DependencyManagerNativeQueryTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void nativeNpmReturnsRegistryVersionsAndLatestThroughTheJavaProcessBridge() throws Exception {
        String configured = System.getenv("CCGUI_NPM_QUERY_COMMAND");
        assumeTrue("Set CCGUI_NPM_QUERY_COMMAND to a JSON command array to enable registry integration", configured != null);
        JsonArray commandJson = JsonParser.parseString(configured).getAsJsonArray();
        var command = new ArrayList<String>();
        commandJson.forEach(value -> command.add(value.getAsString()));
        command.addAll(java.util.List.of("view", "@anthropic-ai/claude-agent-sdk", "versions", "dist-tags.latest", "--json"));
        String cache = temporary.newFolder("npm query cache").getAbsolutePath();
        command.add("--cache=" + cache);
        ProcessBuilder builder = new ProcessBuilder(command);
        String cwd = System.getenv("CCGUI_NPM_QUERY_CWD");
        if (cwd != null) {
            builder.directory(Path.of(cwd).toFile());
        }
        var result = DependencyManager.parseVersionInfo(DependencyManager.runNpmQueryWithCacheFallback(builder, 30_000, cache));
        assertFalse(result.versions().isEmpty());
        assertNotNull(result.latestVersion());
        assertTrue(result.versions().contains(result.latestVersion()));
        assertNull(result.error());
    }
}
