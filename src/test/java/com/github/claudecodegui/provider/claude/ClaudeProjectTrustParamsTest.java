package com.github.claudecodegui.provider.claude;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClaudeProjectTrustParamsTest {

    private static JsonObject sendParams(ClaudeRequestParamsBuilder builder) {
        return builder.buildSendParams("hi", "", "", "/work", "default", "", null, null, null, null, null, null);
    }

    @Test
    public void sendRequestsCarryTheProjectTrust() {
        ClaudeRequestParamsBuilder builder = new ClaudeRequestParamsBuilder(new Gson());
        builder.setProjectTrust(() -> true);
        assertTrue(sendParams(builder).get("projectTrusted").getAsBoolean());

        builder.setProjectTrust(() -> false);
        assertFalse(sendParams(builder).get("projectTrusted").getAsBoolean());
    }

    @Test
    public void aBuilderWithoutATrustSourceSendsUntrusted() {
        assertFalse(sendParams(new ClaudeRequestParamsBuilder(new Gson())).get("projectTrusted").getAsBoolean());
    }

    @Test
    public void aFailingTrustSourceSendsUntrusted() {
        ClaudeRequestParamsBuilder builder = new ClaudeRequestParamsBuilder(new Gson());
        builder.setProjectTrust(() -> {
            throw new IllegalStateException("no project");
        });
        assertFalse(sendParams(builder).get("projectTrusted").getAsBoolean());
    }

    @Test
    public void preconnectRequestsCarryTheProjectTrust() {
        assertTrue(ClaudeDaemonCoordinator.buildPreconnectParams("/work", "", "", true).get("projectTrusted").getAsBoolean());
        assertFalse(ClaudeDaemonCoordinator.buildPreconnectParams("/work", "", "", false).get("projectTrusted").getAsBoolean());
    }

    @Test
    public void addProjectTrustStampsAnyRequest() {
        ClaudeRequestParamsBuilder builder = new ClaudeRequestParamsBuilder(new Gson());
        builder.setProjectTrust(() -> true);
        JsonObject params = new JsonObject();
        builder.addProjectTrust(params);
        assertTrue(params.get("projectTrusted").getAsBoolean());
    }
}
