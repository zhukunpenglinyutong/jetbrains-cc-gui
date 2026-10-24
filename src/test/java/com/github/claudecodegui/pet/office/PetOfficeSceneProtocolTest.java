package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.session.SessionState;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.Assert.*;

public class PetOfficeSceneProtocolTest {
    private final String page = UUID.randomUUID().toString();
    private PetOfficeSceneProtocol.Scene scene(int count) {
        PetOfficeSessionRegistry registry = new PetOfficeSessionRegistry("instance-A");
        PetOfficeAppearanceService appearances = new PetOfficeAppearanceService(java.nio.file.Path.of("."), () -> null);
        Map<String, PetOfficeAppearanceService.Appearance> visuals = new LinkedHashMap<>();
        for (int i = 0; i < count; i++) {
            registry.register(new PetOfficeSessionRegistry.Metadata("tab-" + i, "IC", "IDEA", "project-A", "测试项目", "AI " + i), new SessionState());
        }
        var snapshot = registry.snapshot();
        for (var source : snapshot.sources()) { visuals.put(PetOfficeSessionRegistry.key(source.sourceKey()), appearances.resolve(PetOfficeAppearanceService.defaultConfiguration())); }
        return new PetOfficeSceneProtocol.Scene(snapshot, visuals);
    }
    @Test public void all256SourcesSurviveChunkingWithinTheFrameLimitAndDigest() throws Exception {
        var transfer = PetOfficeSceneProtocol.scene(page, 1, scene(256));
        ByteArrayOutputStream assembled = new ByteArrayOutputStream();
        var begin = JsonParser.parseString(transfer.frames().get(0)).getAsJsonObject();
        assertTrue(transfer.frames().size() > 3);
        for (String frame : transfer.frames()) {
            assertTrue(frame.getBytes(StandardCharsets.UTF_8).length <= PetOfficeSceneProtocol.MAX_FRAME_BYTES);
            var value = JsonParser.parseString(frame).getAsJsonObject();
            if (value.get("type").getAsString().equals("SCENE_CHUNK")) { assembled.write(Base64.getDecoder().decode(value.get("data").getAsString())); }
        }
        assertEquals(begin.get("digest").getAsString(), PetOfficeAppearanceService.digest(assembled.toByteArray()));
        var complete = JsonParser.parseString(assembled.toString(StandardCharsets.UTF_8)).getAsJsonObject();
        assertEquals(256, complete.getAsJsonObject("snapshot").getAsJsonArray("sources").size());
        assertEquals(256, complete.getAsJsonObject("appearances").size());
        assertEquals("SCENE_COMMIT", JsonParser.parseString(transfer.frames().get(transfer.frames().size() - 1)).getAsJsonObject().get("type").getAsString());
    }
    @Test public void unsentEdtWorkNeverAccumulatesAndTimeoutStartsAfterSending() throws Exception {
        AtomicLong clock = new AtomicLong();
        PetOfficeSceneDelivery delivery = new PetOfficeSceneDelivery(page, clock::get);
        var first = delivery.prepare(scene(1)); clock.set(30_000_000_000L);
        assertFalse(delivery.canSend()); assertNull(delivery.prepare(scene(1)));
        delivery.markSent(first); assertFalse(delivery.canSend());
        clock.addAndGet(10_000_000_000L); assertTrue(delivery.canSend());
        var second = delivery.prepare(scene(0)); assertNotNull(second);
        assertFalse(delivery.acceptAck(first.id(), first.sequence()));
        assertTrue(delivery.acceptAck(second.id(), second.sequence()));
        assertTrue(delivery.canSend()); delivery.close(); assertFalse(delivery.canSend());
    }
    @Test public void resyncDuringDispatchAndEarlyAckDoNotPoisonTheNextScene() throws Exception {
        PetOfficeSceneDelivery delivery = new PetOfficeSceneDelivery(page);
        var first = delivery.prepare(scene(1)); delivery.requestResync();
        assertTrue(delivery.acceptAck(first.id(), first.sequence())); delivery.markSent(first);
        var second = delivery.prepare(scene(0)); delivery.markSent(second);
        assertFalse(delivery.canSend()); assertTrue(delivery.acceptAck(second.id(), second.sequence()));
    }
    @Test public void assetBytesMustMatchTheAdmittedDigestAndLength() throws Exception {
        byte[] bytes = new byte[]{1, 2, 3};
        var manifest = new PetOfficeAppearanceService.Manifest(PetOfficeAppearanceService.digest(bytes), "image", "image/png", 1, 1, 3);
        var transfer = PetOfficeSceneProtocol.asset(page, UUID.randomUUID().toString(), "instance/tab/binding", "a".repeat(64), manifest, bytes);
        assertEquals(3, transfer.frames().size());
        assertThrows(java.io.IOException.class, () -> PetOfficeSceneProtocol.asset(page, UUID.randomUUID().toString(), "instance/tab/binding", "a".repeat(64), manifest, new byte[]{3, 2, 1}));
        assertNull(new PetOfficeSceneDelivery(page).appearance("instance/tab/binding", "a".repeat(64), manifest.digest()));
    }

    @Test public void foreignSourceOwnersRequireAnExplicitBoundedParticipantSet() throws Exception {
        var foreign = PetOfficeParticipantFixture.snapshot("other", 1, 1, 1);
        var merged = new PetOfficeSessionRegistry.CompleteSnapshot(1, "owner", "leader", 1, 1,
                foreign.sources(), foreign.recentResults(), false);
        var accepted = new PetOfficeSceneProtocol.Scene(merged, Map.of(), java.util.List.of("owner", "other"));
        var transfer = PetOfficeSceneProtocol.scene(page, 1, accepted);
        assertNotNull(transfer);
        assertThrows(IllegalArgumentException.class, () -> new PetOfficeSceneProtocol.Scene(merged, Map.of()));
        assertThrows(IllegalArgumentException.class, () -> new PetOfficeSceneProtocol.Scene(merged, Map.of(), java.util.List.of("other")));
        assertThrows(IllegalArgumentException.class, () -> new PetOfficeSceneProtocol.Scene(merged, Map.of(), java.util.List.of("owner", "owner")));
    }
}
