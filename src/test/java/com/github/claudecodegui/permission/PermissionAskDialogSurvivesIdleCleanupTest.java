package com.github.claudecodegui.permission;

import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Verifies that a session with a registered live dialog shower survives idle
 * cleanup and continues polling ask-user-question files, whereas an
 * unregistered or disposed-project session is reaped.
 */
public class PermissionAskDialogSurvivesIdleCleanupTest {

    private static final String QUESTION = "Как собираем architecture spine?";

    @Test
    public void liveChatStillShowsTheQuestionAfterADayWithoutOne() throws Exception {
        String sessionId = "ef224bf5-7f7b-4733-be80-fbcc01a5d5f7";
        Path dir = Files.createTempDirectory("perm-ask-live-");
        AtomicReference<JsonObject> shown = new AtomicReference<>();
        CountDownLatch shownLatch = new CountDownLatch(1);
        PermissionService service = PermissionService.createForTest(fakeProject(), sessionId, dir);
        try {
            service.registerAskUserQuestionDialogShower(fakeProject(), (requestId, questions) -> {
                shown.set(questions);
                shownLatch.countDown();
                return CompletableFuture.completedFuture(new JsonObject());
            });
            service.start();
            service.setLastActivityTimeForTest(System.currentTimeMillis() - TimeUnit.HOURS.toMillis(25));
            PermissionSessionRegistry.rememberForTest(sessionId, service);
            PermissionSessionRegistry.forceCleanupForTest();

            assertTrue(
                    "an open chat must keep its permission watcher",
                    PermissionSessionRegistry.isRememberedForTest(sessionId));

            writeQuestion(dir, sessionId);
            assertTrue(
                    "the question must reach the dialog",
                    shownLatch.await(8, TimeUnit.SECONDS));
            JsonObject payload = shown.get();
            assertNotNull(payload);
            assertEquals(QUESTION, payload.getAsJsonArray("questions").get(0).getAsJsonObject().get("question").getAsString());
            assertEquals(
                    "Coaching (рекомендую)",
                    payload.getAsJsonArray("questions").get(0).getAsJsonObject()
                            .getAsJsonArray("options").get(0).getAsJsonObject().get("label").getAsString());
        } finally {
            PermissionService.removeInstance(sessionId);
            service.stop();
            PermissionSessionRegistry.pauseCleanupForTest();
            deleteTree(dir);
        }
    }

    @Test
    public void reapedSessionDoesNotShowALaterQuestion() throws Exception {
        String sessionId = "abandoned-permission-session";
        Path dir = Files.createTempDirectory("perm-ask-dead-");
        CountDownLatch shownLatch = new CountDownLatch(1);
        Project project = fakeProject();
        PermissionService service = PermissionService.createForTest(project, sessionId, dir);
        try {
            service.registerAskUserQuestionDialogShower(project, (requestId, questions) -> {
                shownLatch.countDown();
                return CompletableFuture.completedFuture(new JsonObject());
            });
            service.start();
            service.unregisterAskUserQuestionDialogShower(project);
            service.setLastActivityTimeForTest(System.currentTimeMillis() - TimeUnit.HOURS.toMillis(25));
            PermissionSessionRegistry.rememberForTest(sessionId, service);
            PermissionSessionRegistry.forceCleanupForTest();

            assertFalse(PermissionSessionRegistry.isRememberedForTest(sessionId));
            writeQuestion(dir, sessionId);
            assertFalse(
                    "a stopped watcher must not open the dialog",
                    shownLatch.await(1500, TimeUnit.MILLISECONDS));
        } finally {
            PermissionService.removeInstance(sessionId);
            service.stop();
            PermissionSessionRegistry.pauseCleanupForTest();
            deleteTree(dir);
        }
    }

    @Test
    public void disposedProjectSessionIsReapedAfterADay() throws Exception {
        String sessionId = "disposed-project-permission-session";
        Path dir = Files.createTempDirectory("perm-ask-disposed-");
        CountDownLatch shownLatch = new CountDownLatch(1);
        AtomicBoolean projectDisposed = new AtomicBoolean(false);
        Project project = fakeProject(projectDisposed);
        PermissionService service = PermissionService.createForTest(project, sessionId, dir);
        try {
            service.registerAskUserQuestionDialogShower(project, (requestId, questions) -> {
                shownLatch.countDown();
                return CompletableFuture.completedFuture(new JsonObject());
            });
            service.start();
            projectDisposed.set(true);
            service.setLastActivityTimeForTest(System.currentTimeMillis() - TimeUnit.HOURS.toMillis(25));
            PermissionSessionRegistry.rememberForTest(sessionId, service);
            PermissionSessionRegistry.forceCleanupForTest();

            assertFalse(PermissionSessionRegistry.isRememberedForTest(sessionId));
            writeQuestion(dir, sessionId);
            assertFalse(
                    "a session whose project is disposed must not open the dialog",
                    shownLatch.await(1500, TimeUnit.MILLISECONDS));
        } finally {
            PermissionService.removeInstance(sessionId);
            service.stop();
            PermissionSessionRegistry.pauseCleanupForTest();
            deleteTree(dir);
        }
    }

    private static void writeQuestion(Path dir, String sessionId) throws Exception {
        String requestId = "ask-dac07403-98b7-4d0f-92cb-cd31e588a641";
        Path file = dir.resolve("ask-user-question-" + sessionId + "-" + requestId + ".json");
        String json = """
                {
                  "requestId": "%s",
                  "toolName": "AskUserQuestion",
                  "questions": [
                    {
                      "question": "%s",
                      "header": "",
                      "options": [
                        {"label": "Coaching (рекомендую)", "description": "Разбираем решения вместе."},
                        {"label": "Fast", "description": "Сразу пишу spine."}
                      ],
                      "multiSelect": false
                    }
                  ],
                  "cwd": "/tmp/plugin-ai-bridge",
                  "provider": "grok"
                }
                """.formatted(requestId, QUESTION);
        Files.writeString(file, json);
    }

    private static Project fakeProject() {
        return fakeProject(new AtomicBoolean(false));
    }

    private static Project fakeProject(AtomicBoolean disposed) {
        return (Project) Proxy.newProxyInstance(
                Project.class.getClassLoader(),
                new Class<?>[]{Project.class},
                (proxy, method, args) -> {
                    if ("getName".equals(method.getName()) || "toString".equals(method.getName())) {
                        return "smev-wrapper";
                    }
                    if ("isDisposed".equals(method.getName())) {
                        return disposed.get();
                    }
                    if ("equals".equals(method.getName())) {
                        return proxy == args[0];
                    }
                    if ("hashCode".equals(method.getName())) {
                        return System.identityHashCode(proxy);
                    }
                    Class<?> type = method.getReturnType();
                    if (type == boolean.class) {
                        return false;
                    }
                    if (type == int.class || type == short.class || type == byte.class) {
                        return 0;
                    }
                    if (type == long.class) {
                        return 0L;
                    }
                    if (type == float.class) {
                        return 0f;
                    }
                    if (type == double.class) {
                        return 0d;
                    }
                    if (type == char.class) {
                        return '\0';
                    }
                    return null;
                });
    }

    private static void deleteTree(Path dir) throws Exception {
        if (dir == null || !Files.exists(dir)) {
            return;
        }
        try (var walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (Exception ignored) {
                    // The watcher may still be releasing the directory.
                }
            });
        }
    }
}
