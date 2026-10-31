package com.github.claudecodegui.settings;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;

import static org.junit.Assert.*;

public class ProviderBackupCodecTest {
    private static final char[] PASSWORD = "correct 密码🔐 123".toCharArray();

    @Test
    public void encryptedRoundTripUsesRandomSaltAndIvAndContainsNoSecrets() throws Exception {
        JsonObject payload = ProviderBackupCodec.parseObject("{\"providers\":[{\"name\":\"Secret name\",\"apiKey\":\"sk-test-secret\"}]}");
        byte[] first = ProviderBackupCodec.encode("claude", payload, PASSWORD);
        byte[] second = ProviderBackupCodec.encode("claude", payload, PASSWORD);
        assertFalse(Arrays.equals(first, second));
        String text = new String(first, StandardCharsets.UTF_8);
        assertFalse(text.contains("sk-test-secret"));
        assertFalse(text.contains("Secret name"));
        assertFalse(text.contains(new String(PASSWORD)));
        assertEquals(payload, ProviderBackupCodec.decode(first, "claude", PASSWORD));
        assertEquals(payload, ProviderBackupCodec.decode(second, "claude", PASSWORD));
    }

    @Test
    public void wrongPasswordAndCiphertextTamperingAreRejected() throws Exception {
        byte[] bytes = ProviderBackupCodec.encode("codex", new JsonObject(), PASSWORD);
        assertCode("wrongPassword", () -> ProviderBackupCodec.decode(bytes, "codex", "incorrect".toCharArray()));
        assertCode("passwordRequired", () -> ProviderBackupCodec.decode(bytes, "codex", new char[0]));
        JsonObject envelope = ProviderBackupCodec.inspect(bytes, "codex");
        byte[] ciphertext = Base64.getDecoder().decode(envelope.get("ciphertext").getAsString());
        ciphertext[0] ^= 1;
        envelope.addProperty("ciphertext", Base64.getEncoder().encodeToString(ciphertext));
        assertCode("wrongPassword", () -> ProviderBackupCodec.decode(utf8(envelope), "codex", PASSWORD));
    }

    @Test
    public void metadataAndKdfCannotBeChangedToBypassAuthentication() throws Exception {
        JsonObject envelope = ProviderBackupCodec.inspect(
                ProviderBackupCodec.encode("claude", new JsonObject(), PASSWORD), "claude");
        envelope.addProperty("engine", "codex");
        assertCode("wrongPassword", () -> ProviderBackupCodec.decode(utf8(envelope), "codex", PASSWORD));
        envelope.addProperty("iterations", Integer.MAX_VALUE);
        assertCode("invalidFile", () -> ProviderBackupCodec.decode(utf8(envelope), "codex", PASSWORD));
        envelope.addProperty("encrypted", false);
        assertCode("invalidFile", () -> ProviderBackupCodec.decode(utf8(envelope), "codex", PASSWORD));
    }

    @Test
    public void plaintextIsExplicitAndStillEnforcesFormatVersionAndEngine() throws Exception {
        JsonObject payload = ProviderBackupCodec.parseObject("{\"providers\":[]}");
        byte[] bytes = ProviderBackupCodec.encode("claude", payload, new char[0]);
        assertFalse(ProviderBackupCodec.inspect(bytes, "claude").get("encrypted").getAsBoolean());
        assertEquals(payload, ProviderBackupCodec.decode(bytes, "claude", new char[0]));
        assertCode("wrongEngine", () -> ProviderBackupCodec.decode(bytes, "codex", new char[0]));
        JsonObject envelope = ProviderBackupCodec.inspect(bytes, "claude");
        envelope.addProperty("version", 2);
        assertCode("invalidFile", () -> ProviderBackupCodec.inspect(utf8(envelope), "claude"));
    }

    @Test
    public void rejectsMalformedDeepAndOversizedJson() {
        assertCode("invalidFile", () -> ProviderBackupCodec.parseObject("{unquoted: 'value'}"));
        assertCode("invalidFile", () -> ProviderBackupCodec.parseObject("{} {}"));
        assertCode("invalidFile", () -> ProviderBackupCodec.parseObject("{\"a\":" + "[".repeat(70) + "0" + "]".repeat(70) + "}"));
        assertCode("tooLarge", () -> ProviderBackupCodec.parseObject(" ".repeat(ProviderBackupCodec.MAX_FILE_BYTES + 1)));
    }

    @Test
    public void errorDetailsOnlyExposeAllowlistedFieldsAndValidPositions() {
        var failure = new ProviderBackupCodec.BackupException("invalidFile");
        assertEquals(new JsonObject(), failure.details());
        assertEquals(new JsonObject(), failure.withField("secret-parser-message").atProvider(-1).details());
        assertEquals(new JsonObject(), failure.atProvider(2001).details());
        JsonObject details = failure.withField("authJson").atProvider(2).details();
        assertEquals("authJson", details.get("field").getAsString());
        assertEquals(2, details.get("providerIndex").getAsInt());
        assertEquals(2, details.size());
    }

    private static byte[] utf8(JsonObject object) {
        return object.toString().getBytes(StandardCharsets.UTF_8);
    }

    @Test
    public void preservesExplicitNullsInPlaintextAndEncryptedPayloads() throws Exception {
        JsonObject payload = ProviderBackupCodec.parseObject(
                "{\"providers\":[{\"name\":\"Synthetic\",\"settingsConfig\":{\"model\":null,\"nested\":{\"value\":null},\"array\":[null]}}]}");
        for (char[] password : java.util.List.of(new char[0], PASSWORD)) {
            byte[] bytes = ProviderBackupCodec.encode("claude", payload, password);
            assertEquals(payload, ProviderBackupCodec.decode(bytes, "claude", password));
        }
    }

    @Test
    public void plaintextExportEnforcesTheEnvelopeDepthLimit() throws Exception {
        JsonObject allowed = nestedPayload(63);
        byte[] bytes = ProviderBackupCodec.encode("claude", allowed, new char[0]);
        assertEquals(allowed, ProviderBackupCodec.decode(bytes, "claude", new char[0]));
        assertCode("invalidFile", () -> ProviderBackupCodec.encode("claude", nestedPayload(64), new char[0]));
    }

    @Test
    public void encryptedExportEnforcesTheDecryptedPayloadDepthLimit() throws Exception {
        JsonObject allowed = nestedPayload(64);
        byte[] bytes = ProviderBackupCodec.encode("claude", allowed, PASSWORD);
        assertEquals(allowed, ProviderBackupCodec.decode(bytes, "claude", PASSWORD));
        assertCode("invalidFile", () -> ProviderBackupCodec.encode("claude", nestedPayload(65), PASSWORD));
    }

    @Test
    public void rejectsVeryDeepAndNullPayloadsBeforeSerialization() {
        JsonObject deep = nestedPayload(10_000);
        assertCode("invalidFile", () -> ProviderBackupCodec.encode("claude", deep, new char[0]));
        assertCode("invalidFile", () -> ProviderBackupCodec.encode("claude", deep, PASSWORD));
        assertCode("invalidFile", () -> ProviderBackupCodec.encode("claude", null, PASSWORD));
    }

    /** The root counts as one level; alternating arrays/objects exercise both JSON container types. */
    private static JsonObject nestedPayload(int depth) {
        JsonElement nested = new JsonPrimitive("synthetic");
        for (int level = depth; level > 1; level--) {
            if (level % 2 == 0) {
                JsonArray array = new JsonArray();
                array.add(nested);
                nested = array;
            } else {
                JsonObject object = new JsonObject();
                object.add("child", nested);
                nested = object;
            }
        }
        JsonObject root = new JsonObject();
        root.add("child", nested);
        return root;
    }

    private static void assertCode(String code, ThrowingRunnable action) {
        Exception error = assertThrows(ProviderBackupCodec.BackupException.class, action::run);
        assertEquals(code, error.getMessage());
    }

    private interface ThrowingRunnable { void run() throws Exception; }
}
