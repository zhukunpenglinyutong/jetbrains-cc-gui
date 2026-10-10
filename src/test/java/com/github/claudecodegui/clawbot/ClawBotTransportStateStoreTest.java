package com.github.claudecodegui.clawbot;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class ClawBotTransportStateStoreTest {

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void persistsUncertainIdsWithoutMessageContent() throws Exception {
        Path runtime = temporaryFolder.newFolder("transport-state").toPath();
        ClawBotTransportStateStore store = new ClawBotTransportStateStore(runtime);

        store.save("cursor-1", List.of("message-1", "message-2"), List.of("message-2"));

        ClawBotTransportStateStore.State state = store.load();
        assertEquals(List.of("message-1", "message-2"), state.seenMessageIds());
        assertEquals(List.of("message-2"), state.uncertainMessageIds());
        String persisted = Files.readString(runtime.resolve("transport-state.json"), StandardCharsets.UTF_8);
        assertTrue(persisted.contains("uncertainMessageIds"));
        assertTrue(!persisted.contains("context-token") && !persisted.contains("message text"));
    }

    @Test
    public void loadsLegacyStateWithoutUncertainIds() throws Exception {
        Path runtime = temporaryFolder.newFolder("legacy-transport-state").toPath();
        Files.writeString(runtime.resolve("transport-state.json"),
                "{\"cursor\":\"cursor-1\",\"seenMessageIds\":[\"message-1\"]}", StandardCharsets.UTF_8);

        ClawBotTransportStateStore.State state = new ClawBotTransportStateStore(runtime).load();

        assertEquals(List.of("message-1"), state.seenMessageIds());
        assertTrue(state.uncertainMessageIds().isEmpty());
    }
}
