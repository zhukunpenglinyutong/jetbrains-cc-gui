package com.github.claudecodegui.service;

import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.changes.Change;
import org.junit.Test;

import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

public class GitCommitMessageServiceCommitAiConfigTest {

    @Test
    public void shouldReturnUnavailableErrorWhenNoCommitAiProviderIsResolved() {
        TestableGitCommitMessageService service = new TestableGitCommitMessageService(buildConfig(null, "claude-sonnet-4-6", "gpt-5.5"));
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(Collections.<Change>emptyList(), callback);

        assertNull(callback.success);
        assertNotNull(callback.error);
        assertNull(service.lastClaudeModel);
        assertNull(service.lastCodexModel);
    }

    @Test
    public void shouldRouteToResolvedClaudeModel() {
        TestableGitCommitMessageService service = new TestableGitCommitMessageService(buildConfig("claude", "claude-opus-4-7", "gpt-5.5"));
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(Collections.<Change>emptyList(), callback);

        assertEquals("claude-opus-4-7", service.lastClaudeModel);
        assertNull(service.lastCodexModel);
        assertEquals("fix: use claude routing", callback.success);
    }

    @Test
    public void shouldRouteToResolvedCodexModel() {
        TestableGitCommitMessageService service = new TestableGitCommitMessageService(buildConfig("codex", "claude-sonnet-4-6", "gpt-5.4"));
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(Collections.<Change>emptyList(), callback);

        assertEquals("gpt-5.4", service.lastCodexModel);
        assertNull(service.lastClaudeModel);
        assertEquals("fix: use codex routing", callback.success);
    }

    private JsonObject buildConfig(String effectiveProvider, String claudeModel, String codexModel) {
        JsonObject config = new JsonObject();
        config.add("provider", JsonNull.INSTANCE);
        if (effectiveProvider == null) {
            config.add("effectiveProvider", JsonNull.INSTANCE);
        } else {
            config.addProperty("effectiveProvider", effectiveProvider);
        }
        config.addProperty("resolutionSource", effectiveProvider == null ? "unavailable" : "auto");

        JsonObject models = new JsonObject();
        models.addProperty("claude", claudeModel);
        models.addProperty("codex", codexModel);
        config.add("models", models);

        JsonObject availability = new JsonObject();
        availability.addProperty("claude", true);
        availability.addProperty("codex", true);
        config.add("availability", availability);
        return config;
    }

    private static class ResultCapture implements GitCommitMessageService.CommitMessageCallback {
        private String success;
        private String error;

        @Override
        public void onSuccess(String commitMessage) {
            this.success = commitMessage;
        }

        @Override
        public void onError(String error) {
            this.error = error;
        }
    }

    private static class TestableGitCommitMessageService extends GitCommitMessageService {
        private final JsonObject config;
        private String lastClaudeModel;
        private String lastCodexModel;

        private TestableGitCommitMessageService(JsonObject config) {
            super((Project) null);
            this.config = config;
        }

        @Override
        protected String generateGitDiff(java.util.Collection<Change> changes) {
            return "diff";
        }

        @Override
        protected JsonObject getCommitAiConfig() {
            return config;
        }

        @Override
        protected void callClaudeAPI(String prompt, String model, CommitMessageCallback callback) {
            this.lastClaudeModel = model;
            callback.onSuccess("fix: use claude routing");
        }

        @Override
        protected void callCodexAPI(String prompt, String model, CommitMessageCallback callback) {
            this.lastCodexModel = model;
            callback.onSuccess("fix: use codex routing");
        }
    }
}
