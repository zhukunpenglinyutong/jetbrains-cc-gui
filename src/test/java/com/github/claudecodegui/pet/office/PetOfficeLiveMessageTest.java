package com.github.claudecodegui.pet.office;

import org.junit.Test;

import java.io.IOException;
import java.util.UUID;

import static org.junit.Assert.*;

public class PetOfficeLiveMessageTest {
    private final String page = UUID.randomUUID().toString();
    private String message(String body) { return "{\"pageGeneration\":\"" + page + "\"," + body + "}"; }
    @Test public void liveReadyAndAckHaveOnlyTheirExpectedFields() throws Exception {
        assertEquals(1, PetOfficePrototypeMessage.parse(message("\"command\":\"ready\",\"protocolVersion\":1")).protocolVersion());
        String body = "\"command\":\"sceneAck\",\"transferId\":\"" + UUID.randomUUID() + "\",\"sequence\":2";
        assertEquals(2, PetOfficePrototypeMessage.parse(message(body)).sequence());
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(message(body + ",\"sequence\":3")));
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(message(body + ",\"filePath\":\"unexpected\"")));
    }
    @Test public void assetRequestsNeverAcceptPathsOrMutableConfig() throws Exception {
        String body = "\"command\":\"asset\",\"requestId\":\"" + UUID.randomUUID()
                + "\",\"sourceKey\":\"instance/tab/binding\",\"appearanceRevision\":\"" + "a".repeat(64)
                + "\",\"assetDigest\":\"" + "b".repeat(64) + "\"";
        assertEquals("instance/tab/binding", PetOfficePrototypeMessage.parse(message(body)).field("sourceKey"));
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(message(body.replace("instance/tab/binding", "../tab/binding"))));
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(message(body.replace("\"assetDigest\":\"", "\"path\":\""))));
    }
    @Test public void navigationIsAnOpaqueTargetRequestAndNeverAnApproval() throws Exception {
        String body = "\"command\":\"navigate\",\"requestId\":\"" + UUID.randomUUID()
                + "\",\"sourceKey\":\"instance/tab/binding\",\"routeGeneration\":\"" + UUID.randomUUID() + "\",\"interactionId\":\"\"";
        assertEquals("navigate", PetOfficePrototypeMessage.parse(message(body)).command());
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(message(body.replace("navigate", "approve"))));
        assertThrows(IOException.class, () -> PetOfficePrototypeMessage.parse(message(body + ",\"prompt\":\"unexpected\"")));
    }
}
