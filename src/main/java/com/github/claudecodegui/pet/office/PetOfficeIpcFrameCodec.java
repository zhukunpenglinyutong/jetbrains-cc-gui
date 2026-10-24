package com.github.claudecodegui.pet.office;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.StringReader;
import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/** Dedicated bounded framing. Unknown schemas and duplicate fields never reach participant authority. */
final class PetOfficeIpcFrameCodec {
    static final int MAX_FRAME_BYTES = 64 * 1024;
    private static final int MAX_DEPTH = 32;
    private static final int MAX_SOURCE_KEY_LENGTH = 3 * 128 + 2;

    private enum JsonContext { ROOT, PREFERENCES, APPEARANCE_OVERRIDES, OTHER }

    private PetOfficeIpcFrameCodec() { }

    static void write(OutputStream output, JsonObject object) throws IOException {
        byte[] bytes = object.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length == 0 || bytes.length > MAX_FRAME_BYTES) {
            throw new IOException("OFFICE_IPC_FRAME_CAPACITY");
        }
        DataOutputStream stream = new DataOutputStream(output);
        stream.writeInt(bytes.length);
        stream.write(bytes);
        stream.flush();
    }

    static JsonObject read(InputStream input) throws IOException {
        DataInputStream stream = new DataInputStream(input);
        int length = stream.readInt();
        if (length <= 0 || length > MAX_FRAME_BYTES) {
            throw new IOException("OFFICE_IPC_FRAME_CAPACITY");
        }
        byte[] bytes = new byte[length];
        stream.readFully(bytes);
        return parse(bytes);
    }

    static JsonObject parse(byte[] bytes) throws IOException {
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            try (JsonReader reader = new JsonReader(new StringReader(text))) {
                reader.setLenient(false);
                JsonElement value = readValue(reader, 0, JsonContext.ROOT);
                if (!value.isJsonObject() || reader.peek() != JsonToken.END_DOCUMENT) {
                    throw new IOException("OFFICE_IPC_JSON_INVALID");
                }
                return value.getAsJsonObject();
            }
        } catch (RuntimeException invalid) {
            throw new IOException("OFFICE_IPC_JSON_INVALID");
        }
    }

    private static JsonElement readValue(JsonReader reader, int depth, JsonContext context) throws IOException {
        if (depth > MAX_DEPTH) {
            throw new IOException("OFFICE_IPC_JSON_DEPTH");
        }
        switch (reader.peek()) {
            case BEGIN_OBJECT:
                JsonObject object = new JsonObject();
                Set<String> fields = new HashSet<>();
                // Only this typed preference map uses composite session identities as JSON member names.
                boolean overrides = context == JsonContext.APPEARANCE_OVERRIDES;
                int maxNameLength = overrides ? MAX_SOURCE_KEY_LENGTH : 64;
                int maxFields = overrides ? PetOfficeSessionRegistry.MAX_SOURCES : 32;
                reader.beginObject();
                while (reader.hasNext()) {
                    String name = reader.nextName();
                    if (name.length() > maxNameLength || !fields.add(name) || fields.size() > maxFields) {
                        throw new IOException("OFFICE_IPC_JSON_FIELDS");
                    }
                    object.add(name, readValue(reader, depth + 1, memberContext(context, name)));
                }
                reader.endObject();
                return object;
            case BEGIN_ARRAY:
                JsonArray array = new JsonArray();
                reader.beginArray();
                while (reader.hasNext()) {
                    if (array.size() >= PetOfficeSessionRegistry.MAX_SOURCES) {
                        throw new IOException("OFFICE_IPC_JSON_ARRAY_CAPACITY");
                    }
                    array.add(readValue(reader, depth + 1, JsonContext.OTHER));
                }
                reader.endArray();
                return array;
            case STRING:
                String text = reader.nextString();
                if (text.length() > MAX_FRAME_BYTES) {
                    throw new IOException("OFFICE_IPC_JSON_STRING_CAPACITY");
                }
                return new JsonPrimitive(text);
            case NUMBER:
                String number = reader.nextString();
                if (number.length() > 32) {
                    throw new IOException("OFFICE_IPC_JSON_NUMBER_INVALID");
                }
                return new JsonPrimitive(new BigDecimal(number));
            case BOOLEAN:
                return new JsonPrimitive(reader.nextBoolean());
            default:
                throw new IOException("OFFICE_IPC_JSON_INVALID");
        }
    }

    private static JsonContext memberContext(JsonContext parent, String name) {
        if (parent == JsonContext.ROOT && "preferences".equals(name)) {
            return JsonContext.PREFERENCES;
        }
        if (parent == JsonContext.PREFERENCES && "appearanceOverrides".equals(name)) {
            return JsonContext.APPEARANCE_OVERRIDES;
        }
        return JsonContext.OTHER;
    }

    static void fields(JsonObject object, String... names) throws IOException {
        if (!object.keySet().equals(Set.of(names))) {
            throw new IOException("OFFICE_IPC_FIELDS_INVALID");
        }
    }

    static String string(JsonObject object, String name, int max) throws IOException {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new IOException("OFFICE_IPC_FIELD_INVALID");
        }
        String result = value.getAsString();
        if (result.codePointCount(0, result.length()) > max || result.chars().anyMatch(Character::isISOControl)) {
            throw new IOException("OFFICE_IPC_FIELD_INVALID");
        }
        return result;
    }

    static long integer(JsonObject object, String name, long max) throws IOException {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
            throw new IOException("OFFICE_IPC_FIELD_INVALID");
        }
        try {
            String number = value.getAsString();
            if (!number.matches("[0-9]{1,16}")) {
                throw new NumberFormatException();
            }
            long result = Long.parseLong(number);
            if (result < 0 || result > max) {
                throw new ArithmeticException();
            }
            return result;
        } catch (ArithmeticException | NumberFormatException invalid) {
            throw new IOException("OFFICE_IPC_FIELD_INVALID");
        }
    }

    static String identifier(JsonObject object, String name, boolean optional) throws IOException {
        String value = string(object, name, 128);
        if (!(optional && value.isEmpty()) && (!value.matches("[A-Za-z0-9._-]{1,128}") || value.equals(".") || value.equals(".."))) {
            throw new IOException("OFFICE_IPC_ID_INVALID");
        }
        return value;
    }
}
