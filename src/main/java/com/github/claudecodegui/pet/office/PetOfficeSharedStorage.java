package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.pet.CodexPetImageSupport;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.Set;
import java.util.function.BooleanSupplier;

import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.fields;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.integer;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.string;

/** Page-owned typed storage. One bounded upload, atomic background replacement and revision-checked preferences. */
final class PetOfficeSharedStorage implements AutoCloseable {
    private static final Gson JSON = new Gson();
    private final PetOfficeEndpointStore files;
    private final PetOfficePreferencesStore preferences;
    private final PetOfficeRuntimeLease lease;
    private final BooleanSupplier pageValid;
    @FunctionalInterface
    interface PetChoices { List<PetOfficeAppearanceService.Choice> read() throws IOException; }
    private final PetChoices petChoices;
    private Upload upload;
    private final java.util.concurrent.ScheduledThreadPoolExecutor deadlines = new java.util.concurrent.ScheduledThreadPoolExecutor(1,
            task -> PetOfficeIpcServer.daemon(task, "Pet Office background deadline"));
    private java.util.concurrent.ScheduledFuture<?> uploadDeadline;
    private boolean closed;

    PetOfficeSharedStorage(Path directory, PetOfficeRuntimeLease lease, BooleanSupplier pageValid) {
        this(directory, lease, pageValid, () -> List.of(new PetOfficeAppearanceService.Choice("builtin", "Built-in robot")));
    }

    PetOfficeSharedStorage(Path directory, PetOfficeRuntimeLease lease, BooleanSupplier pageValid, PetChoices petChoices) {
        this.petChoices = petChoices;
        files = new PetOfficeEndpointStore(directory);
        preferences = new PetOfficePreferencesStore(directory);
        this.lease = lease;
        this.pageValid = pageValid;
        deadlines.setRemoveOnCancelPolicy(true);
    }

    synchronized List<JsonObject> request(String requestId, String operation, String payload) throws IOException {
        requireCurrent();
        JsonObject value = PetOfficeIpcFrameCodec.parse(payload.getBytes(StandardCharsets.UTF_8));
        List<JsonObject> result = new ArrayList<>();
        JsonObject reply = reply(requestId, "value");
        switch (operation) {
            case "petChoices":
                fields(value);
                var choices = petChoices.read();
                requireCurrent();
                reply.add("choices", JSON.toJsonTree(choices));
                break;
            case "preferences":
                fields(value, "expectedRevision", "preferences");
                synchronized (lease) {
                    requireCurrent();
                    var next = preferences.update(string(value, "expectedRevision", 64),
                            PetOfficePreferencesStore.preferences(value.getAsJsonObject("preferences")), null, lease);
                    reply.add("state", JSON.toJsonTree(next));
                }
                break;
            case "backgroundRead":
                fields(value, "floor");
                byte[] bytes = files.readBytes(background(value));
                if (bytes == null) {
                    reply.addProperty("empty", true);
                    break;
                }
                String mime = validateBackground(bytes);
                JsonObject begin = reply(requestId, "begin");
                begin.addProperty("byteLength", bytes.length);
                begin.addProperty("digest", PetOfficeAppearanceService.digest(bytes));
                begin.addProperty("mime", mime);
                result.add(begin);
                for (int offset = 0; offset < bytes.length; offset += 32768) {
                    JsonObject chunk = reply(requestId, "chunk");
                    chunk.addProperty("index", offset / 32768);
                    chunk.addProperty("data", Base64.getEncoder().encodeToString(Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + 32768))));
                    result.add(chunk);
                }
                result.add(reply(requestId, "commit"));
                return result;
            case "backgroundBegin":
                fields(value, "floor", "transferId", "byteLength", "digest", "mime");
                if (upload != null && !upload.expired()) {
                    throw new IOException("OFFICE_BACKGROUND_BUSY");
                }
                upload = new Upload(value);
                if (uploadDeadline != null) {
                    uploadDeadline.cancel(false);
                }
                Upload pending = upload;
                uploadDeadline = deadlines.schedule(() -> {
                    synchronized (PetOfficeSharedStorage.this) {
                        if (upload == pending) {
                            upload = null;
                        }
                    }
                }, 15, java.util.concurrent.TimeUnit.SECONDS);
                break;
            case "backgroundChunk":
                fields(value, "transferId", "index", "data");
                upload(value).chunk(value);
                break;
            case "backgroundCommit":
                fields(value, "transferId");
                Upload complete = upload(value);
                upload = null;
                uploadDeadline.cancel(false);
                byte[] captured = complete.finish();
                if (!validateBackground(captured).equals(complete.mime)) {
                    throw new IOException("OFFICE_BACKGROUND_INVALID");
                }
                long retained = captured.length;
                for (int floor = 0; floor < PetOfficeSessionRegistry.MAX_FLOORS; floor++) {
                    if (floor != complete.floor) {
                        retained += files.byteLength("background-" + floor + ".bin");
                    }
                }
                if (retained > 16 * 1024 * 1024) {
                    throw new IOException("OFFICE_BACKGROUND_STORAGE_FULL");
                }
                synchronized (lease) {
                    requireCurrent();
                    files.writeBytes("background-" + complete.floor + ".bin", captured, lease);
                }
                break;
            case "backgroundRemove":
                fields(value, "floor");
                synchronized (lease) {
                    requireCurrent();
                    files.removeBytes(background(value), lease);
                }
                break;
            default:
                throw new IOException("OFFICE_IPC_REQUEST_UNSUPPORTED");
        }
        requireCurrent();
        result.add(reply);
        return result;
    }

    JsonObject error(String requestId, String code) {
        JsonObject value = reply(requestId, "error");
        value.addProperty("code", code);
        if ("OFFICE_PREFERENCES_CONFLICT".equals(code)) {
            try {
                value.add("state", JSON.toJsonTree(preferences.read().state()));
            } catch (IOException ignored) {
                // Invalid authoritative preferences do not acquire a replacement renderer permission.
            }
        }
        return value;
    }

    private void requireCurrent() throws IOException {
        if (closed || !lease.isValid() || !pageValid.getAsBoolean()) {
            throw new IOException("OFFICE_STALE_PAGE");
        }
    }

    private Upload upload(JsonObject value) throws IOException {
        if (upload == null || upload.expired() || !upload.id.equals(string(value, "transferId", 64))) {
            upload = null;
            throw new IOException("OFFICE_BACKGROUND_EXPIRED");
        }
        return upload;
    }

    private static String background(JsonObject value) throws IOException { return "background-" + integer(value, "floor", PetOfficeSessionRegistry.MAX_FLOORS - 1) + ".bin"; }

    private static JsonObject reply(String requestId, String type) {
        JsonObject value = new JsonObject();
        value.addProperty("requestId", requestId);
        value.addProperty("type", type);
        return value;
    }

    static String validateBackground(byte[] bytes) throws IOException {
        String mime = null;
        for (String extension : new String[]{"png", "jpeg", "webp"}) {
            mime = CodexPetImageSupport.detectMimeType(Path.of("background." + extension), bytes);
            if (mime != null) {
                break;
            }
        }
        var size = CodexPetImageSupport.readDimensions(mime, bytes);
        if (bytes == null || bytes.length == 0 || bytes.length > PetOfficeAppearanceService.MAX_IMAGE_BYTES || mime == null
                || !CodexPetImageSupport.hasSafeDimensions(size) || (long) size.getWidth() * size.getHeight() > 4 * 1024 * 1024
                || !CodexPetImageSupport.hasSafeFrameBudget(mime, bytes)) {
            throw new IOException("OFFICE_BACKGROUND_INVALID");
        }
        // Office backgrounds are static: do not accept APNG or animated WebP as a silent first-frame preview.
        if (mime.equals("image/png")) {
            for (int offset = 8; offset + 12 <= bytes.length;) {
                int length = java.nio.ByteBuffer.wrap(bytes, offset, 4).getInt();
                if (length < 0 || length > bytes.length - offset - 12) {
                    throw new IOException("OFFICE_BACKGROUND_INVALID");
                }
                if (new String(bytes, offset + 4, 4, StandardCharsets.US_ASCII).equals("acTL")) {
                    throw new IOException("OFFICE_BACKGROUND_INVALID");
                }
                offset += length + 12;
            }
        } else if (mime.equals("image/webp")) {
            for (int offset = 12; offset + 8 <= bytes.length;) {
                int length = java.nio.ByteBuffer.wrap(bytes, offset + 4, 4).order(java.nio.ByteOrder.LITTLE_ENDIAN).getInt();
                if (length < 0 || length > bytes.length - offset - 8) {
                    throw new IOException("OFFICE_BACKGROUND_INVALID");
                }
                String kind = new String(bytes, offset, 4, StandardCharsets.US_ASCII);
                if (kind.equals("ANIM") || kind.equals("ANMF")) {
                    throw new IOException("OFFICE_BACKGROUND_INVALID");
                }
                offset += length + 8 + (length & 1);
            }
        }
        return mime;
    }

    @Override
    public synchronized void close() {
        closed = true;
        upload = null;
        deadlines.shutdownNow();
    }

    private static final class Upload {
        private final String id;
        private final int floor;
        private final int length;
        private final String digest;
        private final String mime;
        private final ByteArrayOutputStream bytes;
        private final long startedAt = System.nanoTime();
        private int next;

        private Upload(JsonObject value) throws IOException {
            id = PetOfficeIpcFrameCodec.identifier(value, "transferId", false);
            floor = (int) integer(value, "floor", PetOfficeSessionRegistry.MAX_FLOORS - 1);
            length = (int) integer(value, "byteLength", PetOfficeAppearanceService.MAX_IMAGE_BYTES);
            digest = string(value, "digest", 64);
            mime = string(value, "mime", 32);
            if (length == 0 || !digest.matches("[a-f0-9]{64}") || !Set.of("image/png", "image/jpeg", "image/webp").contains(mime)) {
                throw new IOException("OFFICE_BACKGROUND_INVALID");
            }
            bytes = new ByteArrayOutputStream(length);
        }

        private boolean expired() { return System.nanoTime() - startedAt >= java.util.concurrent.TimeUnit.SECONDS.toNanos(15); }

        private void chunk(JsonObject value) throws IOException {
            String data = string(value, "data", 44000);
            byte[] part;
            try {
                part = Base64.getDecoder().decode(data);
            } catch (IllegalArgumentException invalid) {
                throw new IOException("OFFICE_BACKGROUND_INVALID");
            }
            if (integer(value, "index", 127) != next || bytes.size() >= length || part.length != Math.min(32768, length - bytes.size())
                    || !Base64.getEncoder().encodeToString(part).equals(data)) {
                throw new IOException("OFFICE_BACKGROUND_INVALID");
            }
            bytes.write(part);
            next++;
        }

        private byte[] finish() throws IOException {
            byte[] complete = bytes.toByteArray();
            if (complete.length != length || !digest.equals(PetOfficeAppearanceService.digest(complete))) {
                throw new IOException("OFFICE_BACKGROUND_INVALID");
            }
            return complete;
        }
    }
}
