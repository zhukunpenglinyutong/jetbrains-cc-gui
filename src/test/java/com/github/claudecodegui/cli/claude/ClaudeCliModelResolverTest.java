package com.github.claudecodegui.cli.claude;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class ClaudeCliModelResolverTest {

    @Test
    public void shouldUseMainModelOverrideBeforeFamilyMapping() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_MODEL", "mimo-v2.5-pro");
        env.addProperty("ANTHROPIC_DEFAULT_SONNET_MODEL", "ignored-sonnet");

        String resolved = ClaudeCliModelResolver.resolveMapped("claude-sonnet-4-6", env);

        assertEquals("mimo-v2.5-pro", resolved);
    }

    @Test
    public void shouldUseSonnetMappingForClaudeSonnetModel() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_DEFAULT_SONNET_MODEL", "mimo-v2.5-pro");

        String resolved = ClaudeCliModelResolver.resolveMapped("claude-sonnet-4-6", env);

        assertEquals("mimo-v2.5-pro", resolved);
    }

    @Test
    public void shouldStripLongContextSuffixBeforeResolvingFamilyMapping() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_DEFAULT_OPUS_MODEL", "mimo-opus-pro");

        String resolved = ClaudeCliModelResolver.resolveMapped("claude-opus-4-7[1m]", env);

        assertEquals("mimo-opus-pro", resolved);
    }

    @Test
    public void shouldPreserveAlreadyCustomModelIds() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_DEFAULT_SONNET_MODEL", "mimo-v2.5-pro");

        String resolved = ClaudeCliModelResolver.resolveMapped("mimo-v2.5-pro", env);

        assertEquals("mimo-v2.5-pro", resolved);
    }

    @Test
    public void shouldUseSmallFastModelForHaikuBeforeDefaultHaikuMapping() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_SMALL_FAST_MODEL", "mimo-fast");
        env.addProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL", "ignored-haiku");

        String resolved = ClaudeCliModelResolver.resolveMapped("claude-haiku-4-5", env);

        assertEquals("mimo-fast", resolved);
    }
}
