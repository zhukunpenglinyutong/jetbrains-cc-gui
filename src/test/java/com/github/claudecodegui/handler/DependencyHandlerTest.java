package com.github.claudecodegui.handler;

import com.github.claudecodegui.dependency.InstallResult;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit-tests the pure parts of {@link DependencyHandler}: when a Claude SDK change must reach the
 * running daemons, and what the {@code dependencyInstallResult} payload reports to the chat.
 */
public class DependencyHandlerTest {

    @Test
    public void reloadsClaudeSdkAfterClaudeSdkInstall() {
        assertTrue(DependencyHandler.shouldReloadClaudeSdk(
                InstallResult.success("claude-sdk", "0.3.300", "")));
    }

    @Test
    public void keepsClaudeSdkWhenClaudeSdkInstallFails() {
        assertFalse(DependencyHandler.shouldReloadClaudeSdk(
                InstallResult.failure("claude-sdk", "npm install failed with exit code: 1", "")));
    }

    @Test
    public void keepsClaudeSdkWhenAnotherSdkChanges() {
        assertFalse(DependencyHandler.shouldReloadClaudeSdk(
                InstallResult.success("codex-sdk", "0.155.0", "")));
    }

    @Test
    public void successPayloadReportsPreviousVersionAndCustomCli() {
        JsonObject json = DependencyHandler.buildInstallResultJson(
                InstallResult.success("claude-sdk", "0.3.300", "logs"), "0.3.220", "  /usr/local/bin/claude ");

        assertTrue(json.get("success").getAsBoolean());
        assertEquals("claude-sdk", json.get("sdkId").getAsString());
        assertEquals("0.3.300", json.get("installedVersion").getAsString());
        assertEquals("0.3.220", json.get("previousVersion").getAsString());
        assertEquals("/usr/local/bin/claude", json.get("customCliPath").getAsString());
        assertFalse(json.has("error"));
    }

    @Test
    public void successPayloadOmitsUnknownPreviousVersionAndBlankCli() {
        JsonObject json = DependencyHandler.buildInstallResultJson(
                InstallResult.success("claude-sdk", "0.3.300", ""), null, "   ");

        assertFalse(json.has("previousVersion"));
        assertFalse(json.has("customCliPath"));
    }

    @Test
    public void failurePayloadReportsOnlyTheError() {
        JsonObject json = DependencyHandler.buildInstallResultJson(
                InstallResult.failure("claude-sdk", "npm install failed with exit code: 1", "logs"),
                "0.3.220", "/usr/local/bin/claude");

        assertFalse(json.get("success").getAsBoolean());
        assertEquals("npm install failed with exit code: 1", json.get("error").getAsString());
        assertFalse(json.has("installedVersion"));
        assertFalse(json.has("previousVersion"));
        assertFalse(json.has("customCliPath"));
    }
}
