package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;

import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import java.util.Set;

/** Versioned, authenticated provider backups. Never stores a password or a password verifier. */
public final class ProviderBackupCodec {
    public static final int MAX_FILE_BYTES = 8 * 1024 * 1024;
    public static final int MAX_PASSWORD_LENGTH = 1024;
    private static final int MAX_JSON_DEPTH = 64;
    private static final String FORMAT = "ccgui-provider-backup";
    private static final int ITERATIONS = 600_000;
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    private static final SecureRandom RANDOM = new SecureRandom();

    private ProviderBackupCodec() {}

    /** Stable codes are translated by the webview, never raw parser errors containing credentials. */
    public static final class BackupException extends IOException {
        private static final Set<String> DIAGNOSTIC_FIELDS = Set.of(
                "name", "remark", "websiteUrl", "category", "settingsConfig", "configToml", "authJson",
                "customModels", "messageEnvVars", "mcpEnvVars");
        private final String field;
        private final int providerIndex;

        public BackupException(String code) {
            this(code, null, 0);
        }

        private BackupException(String code, String field, int providerIndex) {
            super(code);
            this.field = field != null && DIAGNOSTIC_FIELDS.contains(field) ? field : null;
            this.providerIndex = providerIndex;
        }

        public BackupException withField(String value) {
            return new BackupException(getMessage(), value, providerIndex);
        }

        public BackupException atProvider(int index) {
            return new BackupException(getMessage(), field, index);
        }

        /** Only a numeric position and allowlisted field names cross the bridge, never config values. */
        public JsonObject details() {
            JsonObject result = new JsonObject();
            if (providerIndex > 0 && providerIndex <= 2000) {
                result.addProperty("providerIndex", providerIndex);
            }
            if (field != null) {
                result.addProperty("field", field);
            }
            return result;
        }
    }

    public static void checkEngine(String engine) throws BackupException {
        if (!"claude".equals(engine) && !"codex".equals(engine)) {
            throw new BackupException("invalidFile");
        }
    }

    public static JsonObject inspect(byte[] bytes, String engine) throws IOException {
        checkEngine(engine);
        if (bytes.length > MAX_FILE_BYTES) {
            throw new BackupException("tooLarge");
        }
        JsonObject envelope = parseObject(new String(bytes, StandardCharsets.UTF_8));
        if (!FORMAT.equals(string(envelope, "format"))
                || !envelope.has("version") || !"1".equals(envelope.get("version").toString())
                || !envelope.has("encrypted") || !envelope.get("encrypted").isJsonPrimitive()
                || !envelope.getAsJsonPrimitive("encrypted").isBoolean()) {
            throw new BackupException("invalidFile");
        }
        if (!engine.equals(string(envelope, "engine"))) {
            throw new BackupException("wrongEngine");
        }
        return envelope;
    }

    public static byte[] encode(String engine, JsonObject payload, char[] password) throws IOException {
        checkEngine(engine);
        checkPassword(password);
        if (password.length > 0 && password.length < 8) {
            throw new BackupException("passwordShort");
        }
        if (payload == null) {
            throw new BackupException("invalidFile");
        }
        // Plaintext payloads sit inside the envelope; encrypted payloads are parsed as
        // a separate document after decryption. Validate before serialization/KDF work.
        checkJsonDepth(payload, password.length == 0 ? 1 : 0);
        JsonObject envelope = new JsonObject();
        envelope.addProperty("format", FORMAT);
        envelope.addProperty("version", 1);
        envelope.addProperty("engine", engine);
        envelope.addProperty("encrypted", password.length > 0);
        byte[] plaintext = GSON.toJson(payload).getBytes(StandardCharsets.UTF_8);
        try {
            if (password.length == 0) {
                envelope.add("payload", payload);
            } else {
                byte[] salt = new byte[16];
                byte[] iv = new byte[12];
                RANDOM.nextBytes(salt);
                RANDOM.nextBytes(iv);
                envelope.addProperty("cipher", "AES-256-GCM");
                envelope.addProperty("kdf", "PBKDF2-HMAC-SHA256");
                envelope.addProperty("iterations", ITERATIONS);
                envelope.addProperty("salt", Base64.getEncoder().encodeToString(salt));
                envelope.addProperty("iv", Base64.getEncoder().encodeToString(iv));
                byte[] ciphertext = crypt(Cipher.ENCRYPT_MODE, plaintext, password, salt, iv, engine);
                envelope.addProperty("ciphertext", Base64.getEncoder().encodeToString(ciphertext));
            }
            byte[] result = GSON.toJson(envelope).getBytes(StandardCharsets.UTF_8);
            if (result.length > MAX_FILE_BYTES) {
                throw new BackupException("tooLarge");
            }
            return result;
        } catch (GeneralSecurityException e) {
            throw new BackupException("failed");
        } finally {
            Arrays.fill(plaintext, (byte) 0);
        }
    }

    public static JsonObject decode(byte[] bytes, String engine, char[] password) throws IOException {
        checkPassword(password);
        JsonObject envelope = inspect(bytes, engine);
        if (!envelope.get("encrypted").getAsBoolean()) {
            if (!envelope.has("payload") || !envelope.get("payload").isJsonObject()) {
                throw new BackupException("invalidFile");
            }
            return envelope.getAsJsonObject("payload");
        }
        if (password.length == 0) {
            throw new BackupException("passwordRequired");
        }
        if (!"AES-256-GCM".equals(string(envelope, "cipher"))
                || !"PBKDF2-HMAC-SHA256".equals(string(envelope, "kdf"))
                || !envelope.has("iterations")
                || !Integer.toString(ITERATIONS).equals(envelope.get("iterations").toString())) {
            // Never accept attacker-controlled KDF costs.
            throw new BackupException("invalidFile");
        }
        byte[] plaintext = null;
        try {
            byte[] salt = Base64.getDecoder().decode(string(envelope, "salt"));
            byte[] iv = Base64.getDecoder().decode(string(envelope, "iv"));
            byte[] ciphertext = Base64.getDecoder().decode(string(envelope, "ciphertext"));
            if (salt.length != 16 || iv.length != 12 || ciphertext.length < 16) {
                throw new BackupException("invalidFile");
            }
            plaintext = crypt(Cipher.DECRYPT_MODE, ciphertext, password, salt, iv, engine);
            return parseObject(new String(plaintext, StandardCharsets.UTF_8));
        } catch (AEADBadTagException e) {
            throw new BackupException("wrongPassword");
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            throw new BackupException("invalidFile");
        } finally {
            if (plaintext != null) {
                Arrays.fill(plaintext, (byte) 0);
            }
        }
    }

    private static byte[] crypt(int mode, byte[] input, char[] password, byte[] salt, byte[] iv, String engine)
            throws GeneralSecurityException {
        PBEKeySpec spec = new PBEKeySpec(password, salt, ITERATIONS, 256);
        byte[] key = null;
        try {
            key = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(mode, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
            cipher.updateAAD((FORMAT + ":1:" + engine).getBytes(StandardCharsets.UTF_8));
            return cipher.doFinal(input);
        } finally {
            spec.clearPassword();
            if (key != null) {
                Arrays.fill(key, (byte) 0);
            }
        }
    }

    private static void checkPassword(char[] password) throws BackupException {
        if (password.length > MAX_PASSWORD_LENGTH) {
            throw new BackupException("invalidFile");
        }
    }

    static String string(JsonObject object, String key) throws BackupException {
        if (!object.has(key) || !object.get(key).isJsonPrimitive()
                || !object.getAsJsonPrimitive(key).isString()) {
            throw new BackupException("invalidFile");
        }
        return object.get(key).getAsString();
    }

    /** Bounded recursion rejects deep trees before Gson can copy or serialize them. */
    static void checkJsonDepth(JsonElement value, int parentDepth) throws BackupException {
        if (!value.isJsonObject() && !value.isJsonArray()) {
            return;
        }
        int depth = parentDepth + 1;
        if (depth > MAX_JSON_DEPTH) {
            throw new BackupException("invalidFile");
        }
        Iterable<JsonElement> children = value.isJsonArray()
                ? value.getAsJsonArray() : value.getAsJsonObject().asMap().values();
        for (JsonElement child : children) {
            checkJsonDepth(child, depth);
        }
    }

    /** Strict syntax/depth preflight before Gson builds a tree (including embedded auth.json). */
    static JsonObject parseObject(String text) throws BackupException {
        if (text.length() > MAX_FILE_BYTES) {
            throw new BackupException("tooLarge");
        }
        try (JsonReader reader = new JsonReader(new StringReader(text))) {
            reader.setLenient(false);
            int depth = 0;
            while (reader.peek() != JsonToken.END_DOCUMENT) {
                switch (reader.peek()) {
                    case BEGIN_OBJECT -> {
                        reader.beginObject();
                        depth++;
                    }
                    case END_OBJECT -> {
                        reader.endObject();
                        depth--;
                    }
                    case BEGIN_ARRAY -> {
                        reader.beginArray();
                        depth++;
                    }
                    case END_ARRAY -> {
                        reader.endArray();
                        depth--;
                    }
                    case NAME -> reader.nextName();
                    case STRING, NUMBER -> reader.nextString();
                    case BOOLEAN -> reader.nextBoolean();
                    case NULL -> reader.nextNull();
                    default -> throw new BackupException("invalidFile");
                }
                if (depth > MAX_JSON_DEPTH) {
                    throw new BackupException("invalidFile");
                }
            }
            return JsonParser.parseString(text).getAsJsonObject();
        } catch (IOException | RuntimeException e) {
            throw new BackupException("invalidFile");
        }
    }
}
