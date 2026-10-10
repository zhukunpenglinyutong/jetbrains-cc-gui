package com.github.claudecodegui.clawbot;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** Length-prefixed JSON framing that rejects oversized payloads before allocation. */
final class ClawBotIpcFrameCodec {

    static final int DEFAULT_MAX_FRAME_BYTES = 64 * 1024;

    private ClawBotIpcFrameCodec() {
    }

    static void write(OutputStream output, JsonObject object, int maxFrameBytes) throws IOException {
        byte[] bytes = object.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length == 0 || bytes.length > maxFrameBytes) {
            throw new IOException("CLAWBOT_IPC_FRAME_TOO_LARGE");
        }
        DataOutputStream data = new DataOutputStream(output);
        data.writeInt(bytes.length);
        data.write(bytes);
        data.flush();
    }

    static JsonObject read(InputStream input, int maxFrameBytes) throws IOException {
        DataInputStream data = new DataInputStream(input);
        int length;
        try {
            length = data.readInt();
        } catch (EOFException error) {
            throw new IOException("CLAWBOT_IPC_FRAME_EOF", error);
        }
        if (length <= 0 || length > maxFrameBytes) {
            throw new IOException("CLAWBOT_IPC_FRAME_TOO_LARGE");
        }
        byte[] bytes = new byte[length];
        try {
            data.readFully(bytes);
        } catch (EOFException error) {
            throw new IOException("CLAWBOT_IPC_FRAME_EOF", error);
        }
        try {
            String json = new String(bytes, StandardCharsets.UTF_8);
            if (!JsonParser.parseString(json).isJsonObject()) {
                throw new IOException("CLAWBOT_IPC_JSON_INVALID");
            }
            return JsonParser.parseString(json).getAsJsonObject();
        } catch (RuntimeException error) {
            throw new IOException("CLAWBOT_IPC_JSON_INVALID", error);
        }
    }
}
