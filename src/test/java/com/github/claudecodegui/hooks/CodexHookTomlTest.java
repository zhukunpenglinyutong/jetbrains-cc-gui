package com.github.claudecodegui.hooks;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/** Regression tests for lossless Codex hook discovery and native toggles. */
public class CodexHookTomlTest {

    @Test
    public void parsesAndUpdatesOneHookWithoutReformattingOtherContent() {
        String source = """
                # keep this comment
                [features]
                hooks = true

                [[hooks.pre_tool_use]]
                matcher = "Bash"
                enabled = true # keep inline comment
                hooks = [{ type = "command", command = "python", args = ["guard.py"] }]

                [model_aliases]
                fast = "gpt-test"
                """;

        CodexHookToml.ParseResult parsed = CodexHookToml.parse(source);
        assertTrue(parsed.valid());
        assertTrue(parsed.featureEnabled());
        assertEquals(1, parsed.entries().size());
        assertEquals("python guard.py", parsed.entries().get(0).command());

        CodexHookToml.UpdateResult updated = CodexHookToml.updateEnabled(source, "pre_tool_use/0", false);
        assertTrue(updated.success());
        assertNull(updated.errorCode());
        assertTrue(updated.content().contains("enabled = false # keep inline comment"));
        assertTrue(updated.content().contains("# keep this comment"));
        assertTrue(updated.content().contains("fast = \"gpt-test\""));
    }

    @Test
    public void rejectsInvalidTomlAndMissingEnabledField() {
        assertFalse(CodexHookToml.parse("[[hooks.pre_tool_use]\n").valid());
        String source = """
                [[hooks.pre_tool_use]]
                hooks = [{ type = "command", command = "python" }]
                """;

        CodexHookToml.UpdateResult result = CodexHookToml.updateEnabled(source, "pre_tool_use/0", false);

        assertFalse(result.success());
        assertEquals("CODEX_ENABLED_INVALID", result.errorCode());
    }

    @Test
    public void preservesCrLfWhenToggling() {
        String source = "[[hooks.pre_tool_use]]\r\nenabled = true\r\n"
                + "hooks = [{ type = \"command\", command = \"python\" }]\r\n";

        CodexHookToml.UpdateResult result = CodexHookToml.updateEnabled(source, "pre_tool_use/0", false);

        assertTrue(result.success());
        assertEquals(source.replace("enabled = true", "enabled = false"), result.content());
    }
}
