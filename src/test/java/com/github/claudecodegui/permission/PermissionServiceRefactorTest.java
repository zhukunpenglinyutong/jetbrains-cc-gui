package com.github.claudecodegui.permission;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

public class PermissionServiceRefactorTest {

    @Test
    public void decisionStoreRemembersToolAndParameterScopesIndependently() {
        PermissionDecisionStore store = new PermissionDecisionStore();
        JsonObject editInputs = new JsonObject();
        editInputs.addProperty("file_path", "/tmp/demo.txt");

        assertEquals(null, store.getToolDecision("Edit"));
        assertEquals(null, store.getParameterDecision("Edit", editInputs));

        store.rememberParameterDecision("Edit", editInputs, PermissionService.PermissionResponse.ALLOW_ALWAYS);
        assertEquals(
                PermissionService.PermissionResponse.ALLOW_ALWAYS,
                store.getParameterDecision("Edit", editInputs)
        );

        store.rememberToolDecision("Edit", PermissionService.PermissionResponse.ALLOW_ALWAYS);
        assertEquals(PermissionService.PermissionResponse.ALLOW_ALWAYS, store.getToolDecision("Edit"));
        assertEquals(1, store.getToolMemorySize());
        assertEquals(1, store.getParameterMemorySize());

        store.clear();
        assertEquals(0, store.getToolMemorySize());
        assertEquals(0, store.getParameterMemorySize());
    }

    @Test
    public void fileProtocolCleanupRemovesOnlyCurrentSessionFiles() throws IOException {
        Path permissionDir = Files.createTempDirectory("permission-protocol-cleanup");
        try {
            PermissionFileProtocol protocol = new PermissionFileProtocol(
                    permissionDir,
                    "session-a",
                    new Gson(),
                    (tag, message) -> {
                    }
            );

            Path ownResponse = Files.writeString(permissionDir.resolve("response-session-a-1.json"), "{}");
            Path ownRequest = Files.writeString(permissionDir.resolve("request-session-a-2.json"), "{}");
            Path ownAsk = Files.writeString(permissionDir.resolve("ask-user-question-session-a-3.json"), "{}");
            Path ownPlan = Files.writeString(permissionDir.resolve("plan-approval-session-a-4.json"), "{}");
            Path otherSession = Files.writeString(permissionDir.resolve("response-session-b-1.json"), "{}");
            Path unrelated = Files.writeString(permissionDir.resolve("notes.txt"), "keep");

            protocol.cleanupSessionFiles();

            assertFalse(Files.exists(ownResponse));
            assertFalse(Files.exists(ownRequest));
            assertFalse(Files.exists(ownAsk));
            assertFalse(Files.exists(ownPlan));
            assertTrue(Files.exists(otherSession));
            assertTrue(Files.exists(unrelated));
        } finally {
            deleteDirectory(permissionDir);
        }
    }

    @Test
    public void fileProtocolListsOnlyCurrentSessionRequests() throws IOException {
        Path permissionDir = Files.createTempDirectory("permission-protocol-list");
        try {
            PermissionFileProtocol protocol = new PermissionFileProtocol(
                    permissionDir,
                    "session-a",
                    new Gson(),
                    (tag, message) -> {
                    }
            );

            Files.writeString(permissionDir.resolve("request-session-a-1.json"), "{}");
            Files.writeString(permissionDir.resolve("request-session-b-1.json"), "{}");
            Files.writeString(permissionDir.resolve("ask-user-question-session-a-2.json"), "{}");
            Files.writeString(permissionDir.resolve("ask-user-question-response-session-a-2.json"), "{}");
            Files.writeString(permissionDir.resolve("plan-approval-session-a-3.json"), "{}");
            Files.writeString(permissionDir.resolve("plan-approval-response-session-a-3.json"), "{}");

            assertEquals(1, protocol.listPermissionRequestFiles().length);
            assertEquals(1, protocol.listAskUserQuestionRequestFiles().length);
            assertEquals(1, protocol.listPlanApprovalRequestFiles().length);
        } finally {
            deleteDirectory(permissionDir);
        }
    }

    @Test
    public void fileProtocolWritesExpectedResponsePayloads() throws IOException {
        Path permissionDir = Files.createTempDirectory("permission-protocol-write");
        try {
            PermissionFileProtocol protocol = new PermissionFileProtocol(
                    permissionDir,
                    "session-a",
                    new Gson(),
                    (tag, message) -> {
                    }
            );

            JsonObject answers = new JsonObject();
            answers.addProperty("Question 1", "Answer 1");

            protocol.writePermissionResponse("req-1", true);
            protocol.writeAskUserQuestionResponse("req-2", answers);
            protocol.writePlanApprovalResponse("req-3", true, "acceptEdits");

            JsonObject permissionResponse = readJson(permissionDir.resolve("response-session-a-req-1.json"));
            JsonObject askResponse = readJson(permissionDir.resolve("ask-user-question-response-session-a-req-2.json"));
            JsonObject planResponse = readJson(permissionDir.resolve("plan-approval-response-session-a-req-3.json"));

            assertTrue(permissionResponse.get("allow").getAsBoolean());
            assertEquals("Answer 1", askResponse.getAsJsonObject("answers").get("Question 1").getAsString());
            assertTrue(planResponse.get("approved").getAsBoolean());
            assertEquals("acceptEdits", planResponse.get("targetMode").getAsString());
        } finally {
            deleteDirectory(permissionDir);
        }
    }

    private JsonObject readJson(Path path) throws IOException {
        assertTrue(Files.exists(path));
        JsonObject object = new Gson().fromJson(Files.readString(path), JsonObject.class);
        assertNotNull(object);
        return object;
    }

    private void deleteDirectory(Path dir) throws IOException {
        if (dir == null || !Files.exists(dir)) {
            return;
        }
        Files.walk(dir)
                .sorted(Comparator.reverseOrder())
                .forEach(path -> {
                    try {
                        Files.deleteIfExists(path);
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                });
    }
}
