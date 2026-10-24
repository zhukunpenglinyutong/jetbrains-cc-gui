package com.github.claudecodegui.pet.office;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;

import static org.junit.Assert.*;

public class PetOfficeParticipantSnapshotCodecTest {
    @Test
    public void displayOnlySchemaRejectsPathsSessionIdsAndContradictoryWaits() throws Exception {
        reject(value -> value.addProperty("projectPath", "unregistered"));
        reject(value -> source(value).addProperty("sessionId", "unregistered"));
        reject(value -> source(value).getAsJsonObject("metadata").addProperty("contentHandleId", "other"));
        reject(value -> source(value).getAsJsonObject("execution").addProperty("bindingEpoch", "other"));
        reject(value -> source(value).getAsJsonObject("execution").addProperty("waitReason", "QUESTION"));
        reject(value -> source(value).getAsJsonObject("execution").addProperty("pendingInteractionId", "interaction"));
        reject(value -> source(value).getAsJsonObject("execution").addProperty("pendingInteractionCount", 1));
        reject(value -> source(value).getAsJsonObject("execution").addProperty("phase", "WAITING_USER"));
        reject(value -> value.getAsJsonArray("sources").add(source(value).deepCopy()));
        reject(value -> value.addProperty("connectionEpoch", "other"));
    }

    @Test
    public void anExplicitOwnedQuestionRetainsItsIdentityAndCounts() throws Exception {
        JsonObject value = fixture();
        JsonObject execution = source(value).getAsJsonObject("execution");
        execution.addProperty("phase", "WAITING_USER");
        execution.addProperty("waitReason", "QUESTION");
        execution.addProperty("pendingInteractionId", "question-1");
        execution.addProperty("pendingInteractionCount", 2);
        var snapshot = decode(value);
        assertEquals("question-1", snapshot.sources().get(0).execution().pendingInteractionId());
        assertEquals(2, snapshot.sources().get(0).execution().pendingInteractionCount());
    }

    @Test
    public void unicodeLabelsUseTheSameCodePointLimitAsTheLocalPublisher() throws Exception {
        JsonObject value = fixture();
        String label = new String(Character.toChars(0x1F680)).repeat(160);
        source(value).getAsJsonObject("metadata").addProperty("projectLabel", label);
        assertEquals(label, decode(value).sources().get(0).metadata().projectLabel());
        source(value).getAsJsonObject("metadata").addProperty("projectLabel", label + "x");
        assertThrows(IOException.class, () -> decode(value));
    }

    private static void reject(Consumer<JsonObject> mutation) throws Exception {
        JsonObject value = fixture();
        mutation.accept(value);
        assertThrows(IOException.class, () -> decode(value));
    }

    private static JsonObject fixture() throws IOException {
        return PetOfficeIpcFrameCodec.parse(PetOfficeParticipantSnapshotCodec.encode(PetOfficeParticipantFixture.snapshot("idea", 1, 1, 1), "connection"));
    }

    private static JsonObject source(JsonObject value) {
        return value.getAsJsonArray("sources").get(0).getAsJsonObject();
    }

    private static PetOfficeSessionRegistry.CompleteSnapshot decode(JsonObject value) throws IOException {
        return PetOfficeParticipantSnapshotCodec.decode(value.toString().getBytes(StandardCharsets.UTF_8), "idea", "connection");
    }
}
