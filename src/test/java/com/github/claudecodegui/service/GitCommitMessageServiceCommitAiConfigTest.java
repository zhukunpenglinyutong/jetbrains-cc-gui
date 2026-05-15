package com.github.claudecodegui.service;

import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.FilePath;
import com.intellij.openapi.vcs.LocalFilePath;
import com.intellij.openapi.vcs.VcsException;
import com.intellij.openapi.vcs.changes.Change;
import com.intellij.openapi.vcs.changes.ContentRevision;
import com.intellij.openapi.vcs.history.VcsRevisionNumber;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

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

    @Test
    public void shouldNotFallBackToClaudeWhenCodexIsManuallySelectedButUnavailable() {
        JsonObject config = buildConfig("codex", "claude-sonnet-4-6", "gpt-5.4");
        config.addProperty("provider", "codex");
        config.getAsJsonObject("availability").addProperty("codex", false);
        config.addProperty("effectiveProvider", (String) null);
        config.addProperty("resolutionSource", "unavailable");

        TestableGitCommitMessageService service = new TestableGitCommitMessageService(config);
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(Collections.<Change>emptyList(), callback);

        assertNull(service.lastClaudeModel);
        assertNull(service.lastCodexModel);
        assertNotNull(callback.error);
        assertTrue(callback.error.length() > 0);
    }

    @Test
    public void shouldUseSkillPromptWhenSkillModeIsEnabled() {
        JsonObject config = buildConfig("codex", "claude-sonnet-4-6", "gpt-5.4");
        config.addProperty("generationMode", "skill");
        config.addProperty("skillRef", "builtin:git-commit");
        config.addProperty("language", "ja");
        TestableGitCommitMessageService service = new TestableGitCommitMessageService(config);
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(Collections.<Change>emptyList(), callback);

        assertEquals("gpt-5.4", service.lastCodexModel);
        assertNotNull(service.lastPrompt);
        assertTrue(service.lastPrompt.contains("## Built-in Skill: git-commit"));
        assertTrue(service.lastPrompt.contains("## User preferences"));
        assertTrue(service.lastPrompt.contains("## Selected git diff"));
        assertTrue(service.lastPrompt.contains("Return format:"));
        assertTrue(service.lastPrompt.contains("<commit>"));
        assertTrue(service.lastPrompt.contains("Group related changes by intent or impact"));
        assertTrue(service.lastPrompt.contains("do not write one bullet per file, class, or field"));
        assertTrue(service.lastPrompt.contains("Cover each major functional area touched by the diff"));
        assertTrue(service.lastPrompt.contains("MUST be written in Japanese (日本語)"));
        assertEquals("fix: use codex routing", callback.success);
    }

    @Test
    public void shouldPassSelectedCommitLanguageIntoPrompt() {
        JsonObject config = buildConfig("codex", "claude-sonnet-4-6", "gpt-5.5");
        config.addProperty("generationMode", "prompt");
        config.addProperty("language", "ja");
        TestableGitCommitMessageService service = new TestableGitCommitMessageService(config);
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(Collections.<Change>emptyList(), callback);

        assertNotNull(service.lastPrompt);
        assertTrue(service.lastPrompt.contains("MUST be written in Japanese (日本語)"));
        assertTrue(service.lastPrompt.contains("This overrides any examples"));
        assertTrue(service.lastPrompt.contains("Group related changes by intent or impact"));
        assertTrue(service.lastPrompt.contains("Cover each major functional area touched by the diff"));
        assertEquals("fix: use codex routing", callback.success);
    }

    @Test
    public void shouldRequireEnoughBodyBulletsForVeryLargeSkillDiff() {
        JsonObject config = buildConfig("codex", "claude-sonnet-4-6", "gpt-5.5");
        config.addProperty("generationMode", "skill");
        config.addProperty("skillRef", "builtin:git-commit");
        TestableGitCommitMessageService service = new TestableGitCommitMessageService(config, largeDiff(38));
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(Collections.<Change>emptyList(), callback);

        assertTrue(service.lastPrompt.contains("This diff contains 38 files"));
        assertTrue(service.lastPrompt.contains("Write 7-10 grouped body bullets"));
        assertTrue(service.lastPrompt.contains("do not write fewer than 7"));
        assertTrue(service.lastPrompt.contains("name the main services, settings, UI flows"));
    }

    @Test
    public void shouldApplyBodyScaleRulesToPromptModeToo() {
        JsonObject config = buildConfig("codex", "claude-sonnet-4-6", "gpt-5.5");
        config.addProperty("generationMode", "prompt");
        TestableGitCommitMessageService service = new TestableGitCommitMessageService(config, largeDiff(20));
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(Collections.<Change>emptyList(), callback);

        assertTrue(service.lastPrompt.contains("This diff contains 20 files"));
        assertTrue(service.lastPrompt.contains("Write 7-10 grouped body bullets"));
    }

    @Test
    public void shouldRequireConcreteBulletsForComplexSingleFileSkillDiff() {
        JsonObject config = buildConfig("codex", "claude-sonnet-4-6", "gpt-5.5");
        config.addProperty("generationMode", "skill");
        config.addProperty("skillRef", "builtin:git-commit");
        TestableGitCommitMessageService service = new TestableGitCommitMessageService(config, complexSingleFileDiff());
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(Collections.<Change>emptyList(), callback);

        assertTrue(service.lastPrompt.contains("one file but is non-trivial (36 changed lines)"));
        assertTrue(service.lastPrompt.contains("Write 3-5 concrete body bullets"));
        assertTrue(service.lastPrompt.contains("Do not collapse a complex single-file diff into one generic bullet"));
    }

    @Test
    public void shouldRequireConcreteBulletsForComplexSingleFilePromptDiff() {
        JsonObject config = buildConfig("codex", "claude-sonnet-4-6", "gpt-5.5");
        config.addProperty("generationMode", "prompt");
        TestableGitCommitMessageService service = new TestableGitCommitMessageService(config, complexSingleFileDiff());
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(Collections.<Change>emptyList(), callback);

        assertTrue(service.lastPrompt.contains("one file but is non-trivial (36 changed lines)"));
        assertTrue(service.lastPrompt.contains("Write 3-5 concrete body bullets"));
    }

    @Test
    public void shouldFilterSensitiveFilesInPromptModeDiff() {
        GitCommitMessageService service = new GitCommitMessageService((Project) null);
        Change envChange = new Change(null, revision(absolutePath("project/.env"), "OPENAI_API_KEY=secret"));
        Change codeChange = new Change(null, revision(absolutePath("project/App.java"), "class App {}"));

        String diff = service.generateGitDiff(List.of(envChange, codeChange));

        assertTrue(diff.contains("class App"));
        assertTrue(diff.contains("Filtered sensitive files: 1"));
        assertFalse(diff.contains("OPENAI_API_KEY=secret"));
    }

    @Test
    public void shouldFilterExpandedSensitivePathPatterns() {
        String diff = new CommitSkillDiffCollector().collect(List.of(
                new Change(null, revision(absolutePath("project/.aws/credentials"), "aws_secret_access_key=secret")),
                new Change(null, revision(absolutePath("project/.aws/config"), "sso_session=secret")),
                new Change(null, revision(absolutePath("project/.npmrc"), "//registry.npmjs.org/:_authToken=secret")),
                new Change(null, revision(absolutePath("project/.netrc"), "machine example login token")),
                new Change(null, revision(absolutePath("project/.kube/config"), "client-key-data: secret")),
                new Change(null, revision(absolutePath("project/kubeconfig"), "client-certificate-data: secret")),
                new Change(null, revision(absolutePath("project/auth.token"), "secret")),
                new Change(null, revision(absolutePath("project/cert.pfx"), "secret")),
                new Change(null, revision(absolutePath("project/.git-credentials"), "https://token@example.com"))
        ));

        assertEquals("Filtered sensitive files: 9", diff);
    }

    @Test
    public void shouldUsePositionalDiffWhenLcsBoundaryIsExceeded() {
        String before = repeatedLines("left", 600);
        String after = repeatedLines("right", 600);
        Change change = new Change(
                revision(absolutePath("project/App.java"), before),
                revision(absolutePath("project/App.java"), after)
        );

        String diff = new CommitSkillDiffCollector().collect(List.of(change));

        assertTrue(diff.contains("- left-0"));
        assertTrue(diff.contains("+ right-0"));
        assertTrue(diff.contains("changed lines truncated"));
    }

    @Test
    public void shouldKeepLargeModifiedFileChangesVisible() {
        String before = repeatedLines("same", 3000) + "old behavior\n";
        String after = repeatedLines("same", 3000) + "new behavior\n";
        Change change = new Change(
                revision(absolutePath("project/SyncApplyService.java"), before),
                revision(absolutePath("project/SyncApplyService.java"), after)
        );

        String diff = new CommitSkillDiffCollector().collect(List.of(change));

        assertTrue(diff.contains("- old behavior"));
        assertTrue(diff.contains("+ new behavior"));
        assertFalse(diff.contains("large file content omitted"));
    }

    @Test
    public void shouldTruncateVeryLongChangedLines() {
        Change change = new Change(
                revision(absolutePath("project/App.java"), "old " + repeatedText("a", 800) + "\n"),
                revision(absolutePath("project/App.java"), "new " + repeatedText("b", 800) + "\n")
        );

        String diff = new CommitSkillDiffCollector().collect(List.of(change));

        assertTrue(diff.contains("[line truncated]"));
        assertTrue(diff.length() < 1500);
    }

    @Test
    public void shouldOnlyAllowApiKeyLikeEnvKeyNames() throws Exception {
        java.lang.reflect.Method method = GitCommitMessageService.class.getDeclaredMethod(
                "normalizeAllowedApiKeyEnvKey",
                String.class
        );
        method.setAccessible(true);
        GitCommitMessageService service = new GitCommitMessageService((Project) null);

        assertEquals("OPENAI_API_KEY", method.invoke(service, "OPENAI_API_KEY"));
        assertEquals("ANTHROPIC_AUTH_TOKEN", method.invoke(service, "ANTHROPIC_AUTH_TOKEN"));
        assertNull(method.invoke(service, "PATH"));
        assertNull(method.invoke(service, "HOME"));
    }

    private String largeDiff(int files) {
        StringBuilder diff = new StringBuilder();
        for (int i = 0; i < files; i++) {
            diff.append("=== MODIFICATION: File").append(i).append(".java ===\n+ line\n");
        }
        return diff.toString();
    }

    private String complexSingleFileDiff() {
        StringBuilder diff = new StringBuilder("=== MODIFICATION: AiCommitConfigurable.java ===\n");
        for (int i = 0; i < 18; i++) {
            diff.append("- old line ").append(i).append("\n");
            diff.append("+ new line ").append(i).append("\n");
        }
        return diff.toString();
    }

    private static String absolutePath(String path) {
        return new java.io.File(path).getAbsolutePath();
    }

    private static String repeatedLines(String prefix, int count) {
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < count; i++) {
            text.append(prefix).append("-").append(i).append("\n");
        }
        return text.toString();
    }

    private static String repeatedText(String text, int count) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < count; i++) {
            out.append(text);
        }
        return out.toString();
    }

    private static ContentRevision revision(String path, String content) {
        return new ContentRevision() {
            @Override
            public String getContent() throws VcsException {
                return content;
            }

            @Override
            public FilePath getFile() {
                return new LocalFilePath(path, false);
            }

            @Override
            public VcsRevisionNumber getRevisionNumber() {
                return VcsRevisionNumber.NULL;
            }
        };
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
        private String lastPrompt;
        private final String diff;

        private TestableGitCommitMessageService(JsonObject config) {
            this(config, "diff");
        }

        private TestableGitCommitMessageService(JsonObject config, String diff) {
            super((Project) null);
            this.config = config;
            this.diff = diff;
        }

        @Override
        protected String generateGitDiff(java.util.Collection<Change> changes) {
            return diff;
        }

        @Override
        protected String generateSkillGitDiff(java.util.Collection<Change> changes) {
            return diff;
        }

        @Override
        protected JsonObject getCommitAiConfig() {
            return config;
        }

        @Override
        protected void callClaudeAPI(String prompt, String model, CommitMessageCallback callback) {
            this.lastPrompt = prompt;
            this.lastClaudeModel = model;
            callback.onSuccess("fix: use claude routing");
        }

        @Override
        protected void callCodexAPI(String prompt, String model, CommitMessageCallback callback) {
            this.lastPrompt = prompt;
            this.lastCodexModel = model;
            callback.onSuccess("fix: use codex routing");
        }
    }
}
