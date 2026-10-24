package com.github.claudecodegui.pet.office;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.*;

public class PetOfficeSharedStorageTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder();
    private static JsonObject object(Object... values) {
        JsonObject value = new JsonObject();
        for (int i = 0; i < values.length; i += 2) value.add((String) values[i], new Gson().toJsonTree(values[i + 1]));
        return value;
    }
    private static List<JsonObject> request(PetOfficeSharedStorage storage, String operation, JsonObject payload) throws IOException {
        return storage.request(UUID.randomUUID().toString(), operation, payload.toString());
    }
    private static byte[] image(int color) throws IOException {
        var image = new BufferedImage(32, 32, BufferedImage.TYPE_INT_RGB);
        image.setRGB(0, 0, color);
        var bytes = new ByteArrayOutputStream(); assertTrue(ImageIO.write(image, "png", bytes)); return bytes.toByteArray();
    }
    private static String begin(PetOfficeSharedStorage storage, int floor, byte[] bytes, String digest) throws IOException {
        String id = UUID.randomUUID().toString();
        request(storage, "backgroundBegin", object("floor", floor, "transferId", id, "byteLength", bytes.length, "digest", digest, "mime", "image/png"));
        return id;
    }
    private static void chunks(PetOfficeSharedStorage storage, String id, byte[] bytes) throws IOException {
        for (int offset = 0; offset < bytes.length; offset += 32768) request(storage, "backgroundChunk", object("transferId", id, "index", offset / 32768,
                "data", Base64.getEncoder().encodeToString(Arrays.copyOfRange(bytes, offset, Math.min(offset + 32768, bytes.length)))));
    }
    private static void write(PetOfficeSharedStorage storage, int floor, byte[] bytes) throws IOException {
        String id = begin(storage, floor, bytes, PetOfficeAppearanceService.digest(bytes)); chunks(storage, id, bytes);
        request(storage, "backgroundCommit", object("transferId", id));
    }
    private static byte[] read(PetOfficeSharedStorage storage, int floor) throws IOException {
        var packets = request(storage, "backgroundRead", object("floor", floor));
        var bytes = new ByteArrayOutputStream();
        for (var packet : packets) if (packet.get("type").getAsString().equals("chunk")) bytes.write(Base64.getDecoder().decode(packet.get("data").getAsString()));
        assertEquals(PetOfficeAppearanceService.digest(bytes.toByteArray()), packets.get(0).get("digest").getAsString());
        assertEquals("commit", packets.get(packets.size() - 1).get("type").getAsString());
        return bytes.toByteArray();
    }

    @Test public void floorsAndPreferencesSurviveAnOwnerChangeWithoutSharingOverlaySettings() throws Exception {
        Path root = PetOfficeTestRoot.create(temporary); byte[] a = image(0xff112233), b = image(0xff445566);
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow(); var storage = new PetOfficeSharedStorage(root, lease, () -> true)) {
            write(storage, 0, a); write(storage, 21, b);
            var defaults = new PetOfficePreferencesStore(root).read().state();
            var payload = object("expectedRevision", defaults.revision());
            var prefs = new Gson().toJsonTree(defaults.preferences()).getAsJsonObject(); prefs.addProperty("limitMiB", 96);
            payload.add("preferences", prefs); request(storage, "preferences", payload);
            assertThrows(IOException.class, () -> request(storage, "preferences", payload));
            assertNotNull(storage.error("request", "OFFICE_PREFERENCES_CONFLICT").get("state"));
        }
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow(); var storage = new PetOfficeSharedStorage(root, lease, () -> true)) {
            assertArrayEquals(a, read(storage, 0)); assertArrayEquals(b, read(storage, 21));
            assertEquals(96, new PetOfficePreferencesStore(root).read().state().preferences().limitMiB());
            request(storage, "backgroundRemove", object("floor", 0));
            assertTrue(request(storage, "backgroundRead", object("floor", 0)).get(0).get("empty").getAsBoolean());
            assertArrayEquals(b, read(storage, 21));
        }
    }

    @Test public void realSessionIdentifiersCanChangePetsIndependentlyAndSurviveTakeover() throws Exception {
        Path root = PetOfficeTestRoot.create(temporary);
        var json = new Gson();
        String first = UUID.randomUUID() + "/" + UUID.randomUUID() + "/" + UUID.randomUUID();
        String second = UUID.randomUUID() + "/" + UUID.randomUUID() + "/" + UUID.randomUUID();
        assertTrue(first.length() > 64);
        var overrides = new JsonObject();
        overrides.addProperty(first, "duck/spritesheet.png");
        overrides.addProperty(second, "builtin");
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow(); var storage = new PetOfficeSharedStorage(root, lease, () -> true)) {
            var prefs = json.toJsonTree(PetOfficePreferencesStore.defaults().preferences()).getAsJsonObject();
            prefs.add("appearanceOverrides", overrides);
            var response = request(storage, "preferences", object("expectedRevision", "initial", "preferences", prefs)).get(0);
            assertEquals("value", response.get("type").getAsString());
            assertEquals(overrides, response.getAsJsonObject("state").getAsJsonObject("preferences").getAsJsonObject("appearanceOverrides"));
        }
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow(); var storage = new PetOfficeSharedStorage(root, lease, () -> true)) {
            var restored = new PetOfficePreferencesStore(root).read();
            assertFalse(restored.recovered());
            assertEquals("duck/spritesheet.png", restored.state().preferences().appearanceOverrides().get(first));
            assertEquals("builtin", restored.state().preferences().appearanceOverrides().get(second));
            var prefs = json.toJsonTree(restored.state().preferences()).getAsJsonObject();
            prefs.getAsJsonObject("appearanceOverrides").remove(first);
            request(storage, "preferences", object("expectedRevision", restored.state().revision(), "preferences", prefs));
            var saved = new PetOfficePreferencesStore(root).read().state().preferences().appearanceOverrides();
            assertFalse(saved.containsKey(first));
            assertEquals("builtin", saved.get(second));
        }
    }

    @Test public void manySessionAppearancesFitTheDeclaredQuotaAndRecoverFromBackup() throws Exception {
        Path root = PetOfficeTestRoot.create(temporary);
        var json = new Gson();
        var overrides = new JsonObject();
        for (int index = 0; index < 128; index++) {
            overrides.addProperty(UUID.randomUUID() + "/" + UUID.randomUUID() + "/" + UUID.randomUUID(), "duck/spritesheet.png");
        }
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow(); var storage = new PetOfficeSharedStorage(root, lease, () -> true)) {
            var prefs = json.toJsonTree(PetOfficePreferencesStore.defaults().preferences()).getAsJsonObject();
            prefs.add("appearanceOverrides", overrides);
            request(storage, "preferences", object("expectedRevision", "initial", "preferences", prefs));
            var store = new PetOfficePreferencesStore(root);
            var saved = store.read();
            assertFalse(saved.recovered());
            assertEquals(128, saved.state().preferences().appearanceOverrides().size());
            assertTrue(Files.size(root.resolve(PetOfficePreferencesStore.FILE)) > 8192);
            store.update(saved.state().revision(), null, new PetOfficePreferencesStore.Bounds(10, 20, 1240, 900, true), lease);
            Files.writeString(root.resolve(PetOfficePreferencesStore.FILE), "invalid");
            var recovered = new PetOfficePreferencesStore(root).read();
            assertTrue(recovered.recovered());
            assertEquals(saved.state().preferences(), recovered.state().preferences());
        }
    }

    @Test public void partialWrongDigestAndOldPageCannotReplaceTheLastCompleteBackground() throws Exception {
        Path root = PetOfficeTestRoot.create(temporary); byte[] original = image(1), next = image(2); AtomicBoolean page = new AtomicBoolean(true);
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow(); var storage = new PetOfficeSharedStorage(root, lease, page::get)) {
            write(storage, 0, original);
            String id = begin(storage, 0, next, "0".repeat(64)); chunks(storage, id, next);
            assertThrows(IOException.class, () -> request(storage, "backgroundCommit", object("transferId", id)));
            assertArrayEquals(original, read(storage, 0));
            String partial = begin(storage, 0, next, PetOfficeAppearanceService.digest(next));
            assertThrows(IOException.class, () -> request(storage, "backgroundChunk", object("transferId", partial, "index", 1, "data", Base64.getEncoder().encodeToString(next))));
            chunks(storage, partial, next); page.set(false);
            assertThrows(IOException.class, () -> request(storage, "backgroundCommit", object("transferId", partial)));
            assertThrows(IOException.class, () -> request(storage, "backgroundRemove", object("floor", 0)));
            assertArrayEquals(original, Files.readAllBytes(root.resolve("background-0.bin")));
        }
    }

    @Test public void typedPathsLimitsAndStaticImageAdmissionRejectArbitraryStorageRequests() throws Exception {
        Path root = PetOfficeTestRoot.create(temporary);
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow(); var storage = new PetOfficeSharedStorage(root, lease, () -> true)) {
            assertThrows(IOException.class, () -> request(storage, "backgroundRead", object("floor", 22)));
            assertThrows(IOException.class, () -> request(storage, "backgroundRead", object("floor", 0, "path", "../foreign")));
            assertThrows(IOException.class, () -> request(storage, "execute", object()));
            assertThrows(IOException.class, () -> begin(storage, 0, new byte[4 * 1024 * 1024 + 1], "0".repeat(64)));
            assertThrows(IOException.class, () -> PetOfficeSharedStorage.validateBackground("GIF89a".getBytes(java.nio.charset.StandardCharsets.US_ASCII)));
            assertThrows(IOException.class, () -> new PetOfficeEndpointStore(root).writeBytes("../outside.bin", image(1), lease));
            for (String name : new String[]{"background-22.bin", "background-01.bin", "background--1.bin", "background-999.bin"}) {
                assertThrows(IOException.class, () -> new PetOfficeEndpointStore(root).writeBytes(name, image(1), lease));
            }
        }
    }

    @Test public void closeCancelsStagingAndReplayCannotCommitUnderTheNextOwner() throws Exception {
        Path root = PetOfficeTestRoot.create(temporary); byte[] bytes = image(3); String id;
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            var storage = new PetOfficeSharedStorage(root, lease, () -> true);
            id = begin(storage, 0, bytes, PetOfficeAppearanceService.digest(bytes)); chunks(storage, id, bytes); storage.close();
            assertThrows(IOException.class, () -> request(storage, "backgroundCommit", object("transferId", id)));
            assertFalse(Files.exists(root.resolve("background-0.bin")));
        }
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow(); var storage = new PetOfficeSharedStorage(root, lease, () -> true)) {
            assertThrows(IOException.class, () -> request(storage, "backgroundCommit", object("transferId", id)));
        }
    }

    @Test public void aggregateDiskQuotaRejectsTheNewFloorWithoutDeletingAdmittedBackgrounds() throws Exception {
        var image = new BufferedImage(1100, 1000, BufferedImage.TYPE_INT_RGB); var random = new java.util.Random(41);
        for (int x = 0; x < 1100; x++) { for (int y = 0; y < 1000; y++) image.setRGB(x, y, random.nextInt()); }
        var encoded = new ByteArrayOutputStream(); assertTrue(ImageIO.write(image, "png", encoded)); byte[] bytes = encoded.toByteArray();
        assertTrue(bytes.length * 5L < 16 * 1024 * 1024); assertTrue(bytes.length * 6L > 16 * 1024 * 1024);
        Path root = PetOfficeTestRoot.create(temporary);
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow(); var storage = new PetOfficeSharedStorage(root, lease, () -> true)) {
            for (int floor = 0; floor < 5; floor++) write(storage, floor, bytes);
            assertEquals("OFFICE_BACKGROUND_STORAGE_FULL", assertThrows(IOException.class, () -> write(storage, 5, bytes)).getMessage());
            assertFalse(Files.exists(root.resolve("background-5.bin"))); assertArrayEquals(bytes, read(storage, 0));
        }
    }

    @Test public void staticJpegIsAcceptedAndApngIsNotSilentlyReducedToOneFrame() throws Exception {
        var jpeg = new ByteArrayOutputStream();
        assertTrue(ImageIO.write(new BufferedImage(32, 32, BufferedImage.TYPE_INT_RGB), "jpeg", jpeg));
        assertEquals("image/jpeg", PetOfficeSharedStorage.validateBackground(jpeg.toByteArray()));
        byte[] png = image(12), animated = new byte[png.length + 12];
        System.arraycopy(png, 0, animated, 0, 33); System.arraycopy(new byte[]{'a', 'c', 'T', 'L'}, 0, animated, 37, 4);
        System.arraycopy(png, 33, animated, 45, png.length - 33);
        assertThrows(IOException.class, () -> PetOfficeSharedStorage.validateBackground(animated));
    }
    @org.junit.Test public void localPetChoicesRemainTypedAndPageFenced() throws Exception {
        var root = PetOfficeTestRoot.create(temporary);
        var valid = new java.util.concurrent.atomic.AtomicBoolean(true);
        var reads = new java.util.concurrent.atomic.AtomicInteger();
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow();
             var storage = new PetOfficeSharedStorage(root, lease, valid::get, () -> {
                 reads.incrementAndGet();
                 return java.util.List.of(new PetOfficeAppearanceService.Choice("builtin", "Robot"),
                         new PetOfficeAppearanceService.Choice("duck/spritesheet.png", "Duck"));
             })) {
            var response = storage.request("choices", "petChoices", "{}").get(0);
            assertEquals(2, response.getAsJsonArray("choices").size());
            assertFalse(response.toString().contains(root.toString()));
            assertThrows(IOException.class, () -> storage.request("bad", "petChoices", "{\"path\":\"outside\"}"));
            valid.set(false);
            assertThrows(IOException.class, () -> storage.request("old", "petChoices", "{}"));
            assertEquals(1, reads.get());
        }
    }
}
