package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Native history rows must expose the same writer protection as legacy history. */
public class CodexNativeDataHandlerTest {

    @Test
    public void listedThreadsHeldByAnotherWindowAreMarkedBeforeReachingTheWebview() {
        JsonObject response = JsonParser.parseString("{\"data\":[{\"id\":\"foreign\"},{\"id\":\"free\"}]}")
                .getAsJsonObject();
        List<String> published = new ArrayList<>();
        CodexSDKBridge bridge = new CodexSDKBridge() {
            @Override
            public CompletableFuture<JsonObject> readCodexNative(
                    String method, String channelId, String cwd, String threadId, JsonObject params) {
                assertEquals("codex.listThreads", method);
                return CompletableFuture.completedFuture(response);
            }

            @Override
            public boolean hasCodexThreadOwner(String threadId) {
                return "foreign".equals(threadId);
            }

            @Override
            public boolean ownsCodexThread(String threadId) {
                return false;
            }
        };
        try {
            HandlerContext context = new HandlerContext(null, null, bridge, null, new HandlerContext.JsCallback() {
                @Override
                public void callJavaScript(String functionName, String... args) {
                    if ("onCodexNativeData".equals(functionName)) {
                        published.add(args[0]);
                    }
                }

                @Override
                public String escapeJs(String str) {
                    return str;
                }
            });

            assertTrue(new CodexNativeDataHandler(context).handle("codex_native_list_threads", "{\"requestId\":\"r1\"}"));

            assertEquals(1, published.size());
            JsonArray rows = JsonParser.parseString(published.get(0)).getAsJsonObject().getAsJsonArray("data");
            assertTrue(rows.get(0).getAsJsonObject().get("running").getAsBoolean());
            assertTrue(rows.get(0).getAsJsonObject().get("ownedElsewhere").getAsBoolean());
            assertFalse(rows.get(1).getAsJsonObject().get("running").getAsBoolean());
            assertFalse(rows.get(1).getAsJsonObject().has("ownedElsewhere"));
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void confirmationRemainsRelativeToProjectAfterOpeningACrossDirectoryThread() throws Exception {
        org.junit.rules.TemporaryFolder temporary = new org.junit.rules.TemporaryFolder();
        temporary.create();
        CodexSDKBridge bridge = null;
        try {
            var root = temporary.getRoot().toPath();
            var project = com.github.claudecodegui.provider.common.GitHistoryTestRepositories.create(
                    root.resolve("project"), "https://host/team/game.git");
            var clone = com.github.claudecodegui.provider.common.GitHistoryTestRepositories.create(
                    root.resolve("clone"), "git@host:team/game.git");
            JsonObject response = new JsonObject();
            JsonArray rows = new JsonArray();
            for (var path : List.of(project, clone)) {
                JsonObject row = new JsonObject();
                row.addProperty("id", path.getFileName().toString());
                row.addProperty("cwd", path.toString());
                rows.add(row);
            }
            response.add("data", rows);
            var done = new java.util.concurrent.CountDownLatch(1);
            var result = new java.util.concurrent.atomic.AtomicReference<JsonObject>();
            bridge = new CodexSDKBridge() {
                @Override public CompletableFuture<JsonObject> readCodexNative(
                        String method, String channel, String cwd, String thread, JsonObject params) {
                    assertEquals(clone.toString(), cwd);
                    return CompletableFuture.completedFuture(response);
                }
            };
            var settings = new com.github.claudecodegui.settings.CodemossSettingsService() {
                @Override public boolean getSessionGitRepositoryMatchingEnabled() { return true; }
            };
            var ideProject = (com.intellij.openapi.project.Project) java.lang.reflect.Proxy.newProxyInstance(
                    getClass().getClassLoader(), new Class<?>[]{com.intellij.openapi.project.Project.class},
                    (proxy, method, args) -> method.getName().equals("getBasePath") ? project.toString() : null);
            HandlerContext context = new HandlerContext(ideProject, null, bridge, settings, new HandlerContext.JsCallback() {
                @Override public void callJavaScript(String function, String... args) {
                    result.set(JsonParser.parseString(args[0]).getAsJsonObject()); done.countDown();
                }
                @Override public String escapeJs(String value) { return value; }
            }) {
                @Override public String resolveEffectiveWorkingDirectory() { return project.toString(); }
            };
            JsonObject payload = new JsonObject(); payload.addProperty("cwd", clone.toString());
            assertTrue(new CodexNativeDataHandler(context).handle("codex_native_list_threads", payload.toString()));
            assertTrue(done.await(5, java.util.concurrent.TimeUnit.SECONDS));
            assertFalse(result.get().has("error"));
            JsonArray listed = result.get().getAsJsonArray("data");
            assertEquals(2, listed.size());
            assertFalse(listed.get(0).getAsJsonObject().get("requiresCwdConfirmation").getAsBoolean());
            assertTrue(listed.get(1).getAsJsonObject().get("requiresCwdConfirmation").getAsBoolean());
        } finally {
            if (bridge != null) bridge.cleanupAllProcesses();
            temporary.delete();
        }
    }
}
