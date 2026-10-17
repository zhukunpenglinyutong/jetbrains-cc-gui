package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class SubagentHistoryServiceStatusTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void returnsLightweightStatusesWithRequestMetadata() throws Exception {
        Path sessionsDir = temporaryFolder.newFolder("sessions").toPath();
        String parentId = "019fa70f-0653-73e2-a613-1fb0a9e83a2b";
        String childId = "019fb0fe-c344-7da0-9d10-20659f884100";
        Files.writeString(sessionsDir.resolve("rollout-parent-" + parentId + ".jsonl"),
                event("sub_agent_activity", "event_id", "call-123",
                        "agent_thread_id", childId, "agent_path", "/root/audit_ui").toString(),
                StandardCharsets.UTF_8);
        Files.writeString(sessionsDir.resolve("rollout-child-" + childId + ".jsonl"),
                String.join(System.lineSeparator(),
                        sessionMeta(childId, parentId, "/root/audit_ui").toString(),
                        event("task_started", "turn_id", "child-turn").toString(),
                        turnContext("child-turn").toString(),
                        responseMessage("transcript must stay local").toString(),
                        event("task_complete", "turn_id", "child-turn").toString()),
                StandardCharsets.UTF_8);

        CapturingJsCallback callback = new CapturingJsCallback();
        SubagentHistoryService service = new SubagentHistoryService(
                createContext(callback), new CodexSubagentHistoryLoader(sessionsDir));

        JsonObject request = new JsonObject();
        request.addProperty("sessionId", parentId);
        request.addProperty("provider", "codex");
        request.addProperty("requestId", parentId + ":1");
        JsonObject agent = new JsonObject();
        agent.addProperty("toolUseId", "call-123");
        agent.addProperty("agentPath", "/root/audit_ui");
        agent.addProperty("nativeTaskId", "followup-current");
        JsonArray agents = new JsonArray();
        agents.add(agent);
        request.add("agents", agents);

        service.handleLoadSubagentStatuses(request.toString());

        assertTrue(callback.await());
        assertEquals("onSubagentStatusesLoaded", callback.functionName);
        assertTrue(callback.payload.contains(parentId + ":1"));
        assertTrue(callback.payload.contains(childId));
        assertTrue(callback.payload.contains("completed"));
        assertTrue(callback.payload.contains("followup-current"));
        assertFalse(callback.payload.contains("messages"));
        assertFalse(callback.payload.contains("transcript must stay local"));
    }

    /** A full child read returns the followup identity captured before its asynchronous load. */
    @Test
    public void returnsTheSubmittedTaskIdentityWithTheChildTranscript() throws Exception {
        Path sessionsDir = this.temporaryFolder.newFolder("full-sessions").toPath();
        String parentId = "019fa70f-0653-73e2-a613-1fb0a9e83a2b";
        String childId = "019fb0fe-c344-7da0-9d10-20659f884100";
        Files.writeString(sessionsDir.resolve("rollout-parent-" + parentId + ".jsonl"),
                event("sub_agent_activity", "event_id", "full-call", "agent_thread_id", childId,
                        "agent_path", "/root/audit_ui").toString(), StandardCharsets.UTF_8);
        Files.writeString(sessionsDir.resolve("rollout-child-" + childId + ".jsonl"),
                String.join(System.lineSeparator(), sessionMeta(childId, parentId, "/root/audit_ui").toString(),
                        event("task_started", "turn_id", "child-turn").toString(), turnContext("child-turn").toString(),
                        responseMessage("Current task report").toString(), event("task_complete", "turn_id", "child-turn").toString()),
                StandardCharsets.UTF_8);
        CapturingJsCallback callback = new CapturingJsCallback();
        SubagentHistoryService service = new SubagentHistoryService(createContext(callback), new CodexSubagentHistoryLoader(sessionsDir));
        JsonObject request = new JsonObject();
        request.addProperty("sessionId", parentId);
        request.addProperty("provider", "codex");
        request.addProperty("toolUseId", "full-call");
        request.addProperty("nativeTaskId", "followup-current");
        request.addProperty("agentPath", "/root/audit_ui");
        service.handleLoadSubagentSession(request.toString());
        assertTrue(callback.await());
        assertEquals("onSubagentHistoryLoaded", callback.functionName);
        assertTrue(callback.payload.contains("followup-current"));
        assertTrue(callback.payload.contains("Current task report"));
    }

    /** A followup status read keeps the proven prior turn beside its current task identity. */
    @Test
    public void carriesThePriorTerminalTurnToNativeStatusReads() throws Exception {
        JsonObject result = object("agentId", "child-1", "status", "running", "latestTurnId", "old-turn",
                "nativeTaskPreviousTurnId", "old-turn");
        result.addProperty("success", true);
        result.addProperty("completed", false);
        NativeReadBridge bridge = new NativeReadBridge(result);
        CapturingJsCallback callback = new CapturingJsCallback();
        SubagentHistoryService service = new SubagentHistoryService(createContext(callback, bridge),
                new CodexSubagentHistoryLoader(this.temporaryFolder.newFolder("native-status").toPath()));
        JsonObject request = object("sessionId", "parent-1", "provider", "codex", "requestId", "status-1");
        JsonArray agents = new JsonArray();
        agents.add(object("toolUseId", "launch-1", "agentId", "child-1", "nativeTaskId", "followup-current",
                "nativeTaskPreviousTurnId", "old-turn"));
        request.add("agents", agents);
        service.handleLoadSubagentStatuses(request.toString());
        assertTrue(callback.await());
        assertTrue(bridge.params.has("nativeTaskPreviousTurnId"));
        assertEquals("old-turn", bridge.params.get("nativeTaskPreviousTurnId").getAsString());
        assertFalse(bridge.params.get("includeHistory").getAsBoolean());
        assertEquals("onSubagentStatusesLoaded", callback.functionName);
        assertTrue(callback.payload.contains("followup-current"));
        assertTrue(callback.payload.contains("old-turn"));
    }

    /** A newer native turn clears the prior exclusion while retaining the submitted task identity. */
    @Test
    public void carriesThePriorTerminalTurnToNativeTranscriptReadsAndClearsItForANewTurn() throws Exception {
        JsonObject result = object("agentId", "child-1", "status", "completed", "latestTurnId", "new-turn");
        result.addProperty("success", true);
        result.addProperty("completed", true);
        result.addProperty("nativeTaskPreviousTurnId", (String) null);
        result.add("messages", new JsonArray());
        NativeReadBridge bridge = new NativeReadBridge(result);
        CapturingJsCallback callback = new CapturingJsCallback();
        SubagentHistoryService service = new SubagentHistoryService(createContext(callback, bridge),
                new CodexSubagentHistoryLoader(this.temporaryFolder.newFolder("native-transcript").toPath()));
        service.handleLoadSubagentSession(object("sessionId", "parent-1", "provider", "codex", "toolUseId", "launch-1",
                "agentId", "child-1", "nativeTaskId", "followup-current", "nativeTaskPreviousTurnId", "old-turn").toString());
        assertTrue(callback.await());
        assertTrue(bridge.params.has("nativeTaskPreviousTurnId"));
        assertEquals("old-turn", bridge.params.get("nativeTaskPreviousTurnId").getAsString());
        assertTrue(bridge.params.get("includeHistory").getAsBoolean());
        assertEquals("onSubagentHistoryLoaded", callback.functionName);
        assertTrue(callback.payload.contains("followup-current"));
        assertTrue(callback.payload.contains("new-turn"));
        assertFalse(callback.payload.contains("old-turn"));
        assertTrue(callback.payload.contains("\\\"nativeTaskPreviousTurnId\\\":null"));
    }

    @Test
    public void rejectsRequestsAboveAgentLimitBeforeLoading() throws Exception {
        CapturingJsCallback callback = new CapturingJsCallback();
        SubagentHistoryService service = new SubagentHistoryService(
                createContext(callback), new CodexSubagentHistoryLoader(temporaryFolder.newFolder("empty").toPath()));
        JsonObject request = new JsonObject();
        request.addProperty("sessionId", "session-1");
        request.addProperty("provider", "codex");
        request.addProperty("requestId", "status-request-limit");
        JsonArray agents = new JsonArray();
        for (int i = 0; i <= CodexSubagentHistoryLoader.MAX_STATUS_REQUESTS; i++) {
            JsonObject agent = new JsonObject();
            agent.addProperty("toolUseId", "call-" + i);
            agents.add(agent);
        }
        request.add("agents", agents);

        service.handleLoadSubagentStatuses(request.toString());

        assertTrue(callback.await());
        assertEquals("onSubagentStatusesLoaded", callback.functionName);
        assertTrue(callback.payload.contains("Too many agents"));
        assertTrue(callback.payload.contains("\\\"success\\\":false"));
    }

    private static HandlerContext createContext(CapturingJsCallback callback) {
        return createContext(callback, null);
    }

    private static HandlerContext createContext(CapturingJsCallback callback, CodexSDKBridge bridge) {
        Project project = (Project) Proxy.newProxyInstance(
                SubagentHistoryServiceStatusTest.class.getClassLoader(),
                new Class<?>[]{Project.class},
                (proxy, method, args) -> switch (method.getName()) {
                    case "getBasePath" -> "D:\\Projects\\test";
                    case "getName" -> "test-project";
                    case "isDisposed" -> false;
                    case "toString" -> "test-project";
                    case "hashCode" -> 1;
                    case "equals" -> proxy == args[0];
                    default -> defaultValue(method.getReturnType());
                }
        );
        return new HandlerContext(project, null, bridge, null, callback);
    }

    private static Object defaultValue(Class<?> returnType) {
        if (!returnType.isPrimitive()) {
            return null;
        }
        if (boolean.class.equals(returnType)) {
            return false;
        }
        if (int.class.equals(returnType)) {
            return 0;
        }
        if (long.class.equals(returnType)) {
            return 0L;
        }
        if (double.class.equals(returnType)) {
            return 0D;
        }
        if (float.class.equals(returnType)) {
            return 0F;
        }
        if (short.class.equals(returnType)) {
            return (short) 0;
        }
        if (byte.class.equals(returnType)) {
            return (byte) 0;
        }
        if (char.class.equals(returnType)) {
            return (char) 0;
        }
        return null;
    }

    private static JsonObject sessionMeta(String id, String parentId, String agentPath) {
        JsonObject spawn = object("parent_thread_id", parentId, "agent_path", agentPath);
        JsonObject subagent = new JsonObject();
        subagent.add("thread_spawn", spawn);
        JsonObject source = new JsonObject();
        source.add("subagent", subagent);
        JsonObject payload = object("id", id);
        payload.add("source", source);
        return record("session_meta", payload);
    }

    private static JsonObject turnContext(String turnId) {
        return record("turn_context", object("turn_id", turnId));
    }

    private static JsonObject event(String type, String... properties) {
        JsonObject payload = object(properties);
        payload.addProperty("type", type);
        return record("event_msg", payload);
    }

    private static JsonObject responseMessage(String text) {
        JsonObject block = object("type", "output_text", "text", text);
        JsonArray content = new JsonArray();
        content.add(block);
        JsonObject payload = object("type", "message", "role", "assistant");
        payload.add("content", content);
        return record("response_item", payload);
    }

    private static JsonObject record(String type, JsonObject payload) {
        JsonObject record = new JsonObject();
        record.addProperty("type", type);
        record.add("payload", payload);
        return record;
    }

    private static JsonObject object(String... properties) {
        JsonObject object = new JsonObject();
        for (int i = 0; i < properties.length; i += 2) {
            object.addProperty(properties[i], properties[i + 1]);
        }
        return object;
    }

    private static final class NativeReadBridge extends CodexSDKBridge {
        private final JsonObject result;
        private volatile JsonObject params;

        private NativeReadBridge(JsonObject result) {
            this.result = result;
        }

        /** Captures local reader parameters without claiming a native writer. */
        @Override
        public CompletableFuture<JsonObject> readCodexNative(String method, String channelId, String cwd,
                                                             String threadId, JsonObject requestParams) {
            this.params = requestParams.deepCopy();
            return CompletableFuture.completedFuture(this.result.deepCopy());
        }
    }

    private static final class CapturingJsCallback implements HandlerContext.JsCallback {
        private final CountDownLatch latch = new CountDownLatch(1);
        private volatile String functionName;
        private volatile String payload;

        @Override
        public void callJavaScript(String name, String... args) {
            functionName = name;
            payload = args.length > 0 ? args[0] : "";
            latch.countDown();
        }

        @Override
        public String escapeJs(String str) {
            return str;
        }

        private boolean await() throws InterruptedException {
            return latch.await(5, TimeUnit.SECONDS);
        }
    }
}
