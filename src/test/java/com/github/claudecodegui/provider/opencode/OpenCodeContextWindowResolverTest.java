package com.github.claudecodegui.provider.opencode;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class OpenCodeContextWindowResolverTest {

    private static final String JSONC_WITH_TRAILING_COMMAS = """
            {
              // local model via LM Studio
              "provider": {
                "lmstudio": {
                  "options": { "baseURL": "http://localhost:1234/v1" },
                  "models": {
                    "qwen": { "limit": { "context": 32768, "output": 4096, }, },
                  },
                },
              },
            }
            """;

    @Test
    public void readsJsoncWithCommentsAndTrailingCommas() throws Exception {
        Path dir = Files.createTempDirectory("oc-jsonc");
        Files.writeString(dir.resolve("opencode.jsonc"), JSONC_WITH_TRAILING_COMMAS, StandardCharsets.UTF_8);

        assertEquals(Integer.valueOf(32768), OpenCodeContextWindowResolver.resolve("lmstudio/qwen", dir.toString()));
    }

    @Test
    public void stripJsoncLeavesStringContentsUntouched() {
        String raw = "{ \"url\": \"http://a/*b*/\", \"note\": \"x, }\", \"q\": \"say \\\"hi\\\", // no\", /* gone */ \"n\": [1, 2,], }";

        JsonObject parsed = JsonParser.parseString(OpenCodeContextWindowResolver.stripJsonc(raw)).getAsJsonObject();

        assertEquals("http://a/*b*/", parsed.get("url").getAsString());
        assertEquals("x, }", parsed.get("note").getAsString());
        assertEquals("say \"hi\", // no", parsed.get("q").getAsString());
        assertEquals(2, parsed.getAsJsonArray("n").size());
    }

    @Test
    public void picksUpAnEditedConfigInsteadOfServingTheCachedOne() throws Exception {
        Path dir = Files.createTempDirectory("oc-cache");
        Path config = dir.resolve("opencode.json");
        Files.writeString(config, limitConfig(32768), StandardCharsets.UTF_8);
        assertEquals(Integer.valueOf(32768), OpenCodeContextWindowResolver.resolve("lmstudio/qwen", dir.toString()));

        Files.writeString(config, limitConfig(131072), StandardCharsets.UTF_8);
        Files.setLastModifiedTime(config, FileTime.fromMillis(Files.getLastModifiedTime(config).toMillis() + 5_000));

        assertEquals(Integer.valueOf(131072), OpenCodeContextWindowResolver.resolve("lmstudio/qwen", dir.toString()));
    }

    @Test
    public void configDefaultModelFallsBackToTheConfiguredModel() throws Exception {
        Path dir = Files.createTempDirectory("oc-default");
        Files.writeString(dir.resolve("opencode.json"),
                "{\"model\": \"lmstudio/qwen\"," + limitConfig(65536).substring(1), StandardCharsets.UTF_8);

        assertEquals(Integer.valueOf(65536), OpenCodeContextWindowResolver.resolve("__config_default__", dir.toString()));
    }

    @Test
    public void undeclaredModelResolvesToNull() throws Exception {
        Path dir = Files.createTempDirectory("oc-undeclared");
        Files.writeString(dir.resolve("opencode.json"), limitConfig(32768), StandardCharsets.UTF_8);

        assertNull(OpenCodeContextWindowResolver.resolve("lmstudio/not-declared-anywhere-xyz", dir.toString()));
    }

    private static String limitConfig(int context) {
        return "{\"provider\": {\"lmstudio\": {\"models\": {\"qwen\": {\"limit\": {\"context\": " + context + "}}}}}}";
    }
}
