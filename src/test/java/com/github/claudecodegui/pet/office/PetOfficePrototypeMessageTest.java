package com.github.claudecodegui.pet.office;

import org.junit.Test;

import java.io.IOException;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public class PetOfficePrototypeMessageTest {
    @Test
    public void onlyExplicitWindowCommandsAreAccepted() throws Exception {
        assertEquals("ready", PetOfficePrototypeMessage.parse("{\"pageGeneration\":\"page\",\"command\":\"ready\"}").command());
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse("{\"pageGeneration\":\"page\",\"command\":\"send_message\"}"));
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse("{\"pageGeneration\":\"page\",\"command\":\"ready\",\"path\":\"x\"}"));
    }

    @Test
    public void topmostRequiresAnExplicitBooleanAndHasNoExtraActionAuthority() throws Exception {
        String valid = "{\"pageGeneration\":\"page\",\"command\":\"setTopmost\",\"topmost\":true}";
        assertEquals(true, PetOfficePrototypeMessage.parse(valid).topmost());
        assertEquals(false, PetOfficePrototypeMessage.parse(valid.replace("true", "false")).topmost());
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(valid.replace("true", "\"true\"")));
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(valid.replace("true", "1")));
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(valid.replace(",\"topmost\":true", "")));
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(valid.replace("setTopmost", "exit")));
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(valid.replace("}", ",\"path\":\"x\"}")));
    }

    @Test
    public void deepMalformedDuplicateAndOversizedInputCannotReachActions() {
        String deep = "{\"pageGeneration\":" + "[".repeat(3000) + "0" + "]".repeat(3000) + ",\"command\":\"ready\"}";
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(deep));
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse("{\"pageGeneration\":\"page\",\"command\":\"ready\",\"command\":\"exit\"}"));
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse("x".repeat(8193)));
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse("{\"pageGeneration\":\"page\",\"command\":\"ready\"}{}"));
    }

    @Test
    public void metricsHaveFiniteBoundedSchemaAndNoImplicitActionAuthority() throws Exception {
        String valid = "{\"pageGeneration\":\"page\",\"command\":\"metrics\",\"metrics\":{\"frames\":80,\"fps\":30,\"drawMs\":2,\"running\":true,\"visibleSources\":25,\"decodedBytes\":33554432}}";
        assertEquals(25, PetOfficePrototypeMessage.parse(valid).metrics().visibleSources());
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(valid.replace("\"fps\":30", "\"fps\":1e309")));
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(valid.replace("33554432", "268435457")));
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(valid.replace("\"metrics\",\"metrics\"", "\"exit\",\"metrics\"")));
    }

    @Test
    public void configurableCacheMetricsAcceptCurrentAndMaximumBudgetsWithoutChangingTheSchema() throws Exception {
        String valid = "{\"pageGeneration\":\"page\",\"command\":\"metrics\",\"metrics\":{\"frames\":80,\"fps\":30,\"drawMs\":2,\"running\":true,\"visibleSources\":16,\"decodedBytes\":52428800}}";
        for (long bytes : new long[]{0, 3L * 1536 * 1872 * 4, 32L * 1024 * 1024, 50L * 1024 * 1024, 256L * 1024 * 1024}) {
            assertEquals(bytes, PetOfficePrototypeMessage.parse(valid.replace("52428800", Long.toString(bytes))).metrics().decodedBytes());
        }
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(valid.replace("52428800", "-1")));
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(valid.replace("52428800", "268435457")));
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(valid.replace("\"decodedBytes\":52428800", "\"decodedBytes\":52428800,\"decodedLimitBytes\":52428800")));
    }

    @Test public void storageAllowsBoundedChunksButCannotExpandTheWindowOrProviderCommandSurface() throws Exception {
        var value = new com.google.gson.JsonObject(); value.addProperty("pageGeneration", "page"); value.addProperty("command", "storage");
        value.addProperty("requestId", java.util.UUID.randomUUID().toString()); value.addProperty("operation", "backgroundChunk");
        value.addProperty("payload", "a".repeat(43900));
        assertEquals("storage", PetOfficePrototypeMessage.parse(value.toString()).command());
        value.addProperty("payload", "a".repeat(44001)); assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(value.toString()));
        value.addProperty("payload", "{}"); value.addProperty("operation", "send_message"); assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(value.toString()));
        value.addProperty("operation", "backgroundRead"); value.addProperty("path", "C:/unexpected"); assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(value.toString()));
    }
}
