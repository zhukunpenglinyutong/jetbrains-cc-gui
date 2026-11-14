package com.github.claudecodegui.hooks;

import org.junit.Test;
import org.tomlj.Toml;
import java.nio.file.Path;
import java.util.List;
import static org.junit.Assert.*;

/** Native hook state is per handler and does not alter the declaration or trust hash. */
public class CodexHookTomlTest {
    private static final Path SOURCE = Path.of("fixture/config.toml").toAbsolutePath();
    private static final String DECLARATION = "# keep comment\n[[hooks.PreToolUse]]\nmatcher=\"Bash\"\n"
            + "hooks=[{type=\"command\",command=\"python guard.py\"},{type=\"command\",command=\"echo second\"}]\n";

    @Test public void defaultsToEnabledAndWritesNativeStateForOnlyOneHandler() {
        var parsed = CodexHookToml.parse(DECLARATION, SOURCE, DECLARATION);
        assertTrue(parsed.valid());
        assertTrue(parsed.featureEnabled());
        assertEquals(2, parsed.entries().size());
        String key = SOURCE + ":pre_tool_use:0:0";
        assertEquals(key, parsed.entries().get(0).managedKey());
        assertTrue(parsed.entries().get(0).enabled());
        var updated = CodexHookToml.updateEnabled(DECLARATION, key, false);
        assertTrue(updated.success());
        assertTrue(updated.content().startsWith(DECLARATION));
        assertFalse(Toml.parse(updated.content()).getBoolean(List.of("hooks", "state", key, "enabled")));
        var after = CodexHookToml.parse(updated.content(), SOURCE, updated.content());
        assertFalse(after.entries().get(0).enabled());
        assertTrue(after.entries().get(1).enabled());
        assertTrue(after.sourceIssues().isEmpty());
    }

    @Test public void preservesCrLfAndTrustedHashWhileChangingAnExistingState() {
        String key = CodexHookToml.stateKey(SOURCE, "PreToolUse", 0, 0);
        String source = CodexHookToml.updateEnabled(DECLARATION.replace("\n", "\r\n"), key, true).content()
                + "trusted_hash = \"sha256:fixture\"\r\n";
        var result = CodexHookToml.updateEnabled(source, key, false);
        assertTrue(result.success());
        assertEquals(source.replace("enabled = true", "enabled = false"), result.content());
    }

    @Test public void addsAnEnabledPreferenceBesideAnExistingTrustHash() {
        String key = "simple:stop:0:0";
        String source = "[hooks.state.\"simple:stop:0:0\"] # preserve\ntrusted_hash=\"sha256:fixture\"\n";
        var result = CodexHookToml.updateEnabled(source, key, false);
        assertTrue(result.success());
        assertTrue(result.content().contains("trusted_hash=\"sha256:fixture\""));
        assertFalse(Toml.parse(result.content()).getBoolean(List.of("hooks", "state", key, "enabled")));
    }

    @Test public void supportsTheFeatureDefaultAndDeprecatedAlias() {
        assertTrue(CodexHookToml.parse(DECLARATION, SOURCE, "").featureEnabled());
        assertTrue(CodexHookToml.parse(DECLARATION, SOURCE, "[features]\ncodex_hooks=true\n").featureEnabled());
        assertFalse(CodexHookToml.parse(DECLARATION, SOURCE, "[features]\nhooks=false\n").featureEnabled());
    }

    @Test public void readsHooksJsonUsingOnlyUserState() {
        String json = "{\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"echo ready\"}]}]}}";
        Path source = Path.of("fixture/hooks.json").toAbsolutePath();
        String key = source + ":stop:0:0";
        String preferences = CodexHookToml.updateEnabled("", key, false).content();
        var parsed = CodexHookToml.parseJson(json, source, preferences);
        assertTrue(parsed.valid());
        assertFalse(parsed.entries().get(0).enabled());
        assertEquals(key, parsed.entries().get(0).managedKey());
    }

    @Test public void refusesInvalidOrUnsupportedInlineStateWithoutRewritingIt() {
        assertFalse(CodexHookToml.parse("[[hooks.Stop]\n", SOURCE, "").valid());
        var updated = CodexHookToml.updateEnabled("[hooks.state]\nkey={enabled=true}\n", "key", false);
        assertFalse(updated.success());
        assertEquals("CODEX_STATE_INLINE_UNSUPPORTED", updated.errorCode());
    }
}
