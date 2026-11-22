package com.github.claudecodegui.provider.claude;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClaudeMcpQueryServiceTrustTest {

    @Test
    public void statusQueriesCarryTheProjectTrustForTheirWorkingDirectory() {
        JsonObject trusted = ClaudeMcpQueryService.buildStatusInput("/work", true);
        assertTrue(trusted.get("projectTrusted").getAsBoolean());
        assertEquals("/work", trusted.get("cwd").getAsString());

        assertFalse(ClaudeMcpQueryService.buildStatusInput("/elsewhere", false).get("projectTrusted").getAsBoolean());
    }

    @Test
    public void toolQueriesCarryTheProjectTrustForTheirWorkingDirectory() {
        JsonObject trusted = ClaudeMcpQueryService.buildToolsInput("server", "/work", true);
        assertTrue(trusted.get("projectTrusted").getAsBoolean());
        assertEquals("server", trusted.get("serverId").getAsString());

        assertFalse(ClaudeMcpQueryService.buildToolsInput("server", "/work", false).get("projectTrusted").getAsBoolean());
    }
}
