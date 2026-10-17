package com.github.claudecodegui.provider.codex;

import com.google.gson.JsonParser;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Verifies that internal approval metadata cannot become user history. */
public class CodexSessionMetadataTest {
    /** Checks native guardian sources independently of user-facing names. */
    @Test
    public void hidesGuardianMetadataWithoutDependingOnItsTitle() {
        for (String json : new String[]{
                "{\"source\":{\"subagent\":{\"other\":\"guardian\"}}}",
                "{\"source\":{\"internal\":\"guardian\"}}",
                "{\"thread_source\":\"guardian_review\"}"}) {
            assertTrue(CodexSessionMetadata.isSubagent(JsonParser.parseString(json).getAsJsonObject()));
        }
        assertFalse(CodexSessionMetadata.isSubagent(JsonParser.parseString(
                "{\"source\":\"exec\",\"name\":\"Guardian review\"}").getAsJsonObject()));
        assertFalse(CodexSessionMetadata.isSubagent(JsonParser.parseString(
                "{\"source\":{\"internal\":\"memory_consolidation\"}}").getAsJsonObject()));
    }
}
