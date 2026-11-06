package com.github.claudecodegui.provider.claude;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.function.Predicate;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClaudeMcpQueryServiceTrustTest {

    private static ClaudeMcpQueryService service(Predicate<String> projectTrust) {
        return new ClaudeMcpQueryService(null, null, null, null, null, null, null, projectTrust);
    }

    @Test
    public void statusQueriesCarryTheProjectTrustForTheirWorkingDirectory() {
        JsonObject trusted = service("/work"::equals).buildStatusInput("/work");
        assertTrue(trusted.get("projectTrusted").getAsBoolean());
        assertEquals("/work", trusted.get("cwd").getAsString());

        JsonObject outside = service("/work"::equals).buildStatusInput("/elsewhere");
        assertFalse(outside.get("projectTrusted").getAsBoolean());
    }

    @Test
    public void toolQueriesCarryTheProjectTrustForTheirWorkingDirectory() {
        JsonObject trusted = service(cwd -> true).buildToolsInput("server", "/work");
        assertTrue(trusted.get("projectTrusted").getAsBoolean());
        assertEquals("server", trusted.get("serverId").getAsString());

        assertFalse(service(cwd -> false).buildToolsInput("server", "/work").get("projectTrusted").getAsBoolean());
    }

    @Test
    public void aFailingTrustSourceSendsUntrusted() {
        Predicate<String> failing = cwd -> {
            throw new IllegalStateException("no project");
        };
        assertFalse(service(failing).buildStatusInput("/work").get("projectTrusted").getAsBoolean());
        assertFalse(service(failing).buildToolsInput("server", "/work").get("projectTrusted").getAsBoolean());
    }
}
