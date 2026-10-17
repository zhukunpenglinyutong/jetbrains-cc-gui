package com.github.claudecodegui.handler.diff;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.util.FileChangeUndoPlan;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/** Keeps a native diff's filesystem identities steady while its UI decision is pending. */
public class EditableDiffHandlerTest {
    /** Keeps both workspace directories separate from project files. */
    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    /** A directory selection cannot retarget relative rename metadata before the diff opens. */
    @Test
    public void freezesRelativeRenameBeforeTheDiffWaitsOnTheEdt() throws Exception {
        this.assertNativeDecisionKeepsItsDirectory(true);
    }

    /** Reject still targets the opened file and retains its original browser receipt path. */
    @Test
    public void rejectsTheOpenedFileAfterTheWorkingDirectoryChanges() throws Exception {
        this.assertNativeDecisionKeepsItsDirectory(false);
    }

    /** A late rejection belongs to the reviewed chat rather than the chat now visible in its window. */
    @Test
    public void keepsTheReviewedChatWithItsUndoSubmission() throws Exception {
        this.assertNativeDecisionKeepsItsDirectory(false, true, "reviewed-chat");
    }

    /** An explicitly unbound review cannot borrow the subsequently opened chat identity. */
    @Test
    public void keepsAnExplicitUnboundChatWithItsUndoSubmission() throws Exception {
        this.assertNativeDecisionKeepsItsDirectory(false, true, null);
    }

    /** An accepted diff retains the reviewed chat after the window selects another chat. */
    @Test
    public void keepsTheReviewedChatWithItsApplyReceipt() throws Exception {
        this.assertNativeApplyKeepsItsOrigin("reviewed-chat", false);
    }

    /** An unbound accepted diff remains explicitly unbound in its browser receipt. */
    @Test
    public void keepsAnExplicitUnboundChatWithItsApplyReceipt() throws Exception {
        this.assertNativeApplyKeepsItsOrigin(null, false);
    }

    /** A failed apply retains its origin without claiming that the file was reviewed. */
    @Test
    public void keepsTheReviewedChatWithItsFailedApplyReceipt() throws Exception {
        this.assertNativeApplyKeepsItsOrigin("reviewed-chat", true);
    }

    private void assertNativeApplyKeepsItsOrigin(String originalSessionId, boolean failWrite) throws Exception {
        Path root = this.temporary.newFolder().toPath();
        Path first = Files.createDirectory(root.resolve("first"));
        Path second = Files.createDirectory(root.resolve("second"));
        Path secondTarget = second.resolve("deleted.ts");
        Files.writeString(secondTarget, "other chat\n");
        List<Runnable> queued = new ArrayList<>();
        List<JsonObject> receipts = new ArrayList<>();
        Application previous = ApplicationManager.getApplication();
        Application application = (Application) Proxy.newProxyInstance(Application.class.getClassLoader(),
                new Class<?>[]{Application.class}, (proxy, method, args) -> {
                    if ("invokeLater".equals(method.getName())) queued.add((Runnable) args[0]);
                    return method.getReturnType() == boolean.class ? false : null;
                });
        ApplicationManager.setApplication(application);
        try {
            Project project = (Project) Proxy.newProxyInstance(Project.class.getClassLoader(), new Class<?>[]{Project.class},
                    (proxy, method, args) -> "getBasePath".equals(method.getName()) ? root.toString() : null);
            HandlerContext context = new HandlerContext(project, null, null, null, null);
            ClaudeSession session = new ClaudeSession(null, null, null, null);
            session.setCwd(first.toString());
            session.getState().setSessionId(originalSessionId);
            session.getState().setProvider("codex");
            context.setSession(session);
            DiffBrowserBridge bridge = new DiffBrowserBridge(context, new Gson()) {
                /** Records the legacy receipt so the origin regression exercises the old path too. */
                @Override
                public void sendDiffResult(String filePath, String action, String content, String error) {
                    this.sendDiffResult(filePath, action, content, error, null);
                }

                /** Captures the browser boundary while keeping the native decision routing real. */
                @Override
                public void sendDiffResult(String filePath, String action, String content, String error, JsonObject origin) {
                    JsonObject receipt = origin == null ? new JsonObject() : origin.deepCopy();
                    receipt.addProperty("filePath", filePath);
                    receipt.addProperty("action", action);
                    if (error != null) receipt.addProperty("error", error);
                    receipts.add(receipt);
                }
            };
            DiffFileOperations files = new DiffFileOperations(context) {
                private int validations;

                /** Lets the initial review open, then exercises the actual apply failure callback. */
                @Override
                public boolean isPathWithinProject(String filePath) {
                    return !failWrite || ++this.validations == 1;
                }
            };
            CompletableFuture<DiffResult> decision = new CompletableFuture<>();
            EditableDiffHandler handler = new EditableDiffHandler(context, new Gson(), bridge, files) {
                @Override
                void showEditableDiff(String filePath, String requestedPath, JsonArray operations, String status,
                                      boolean nativePatch, JsonObject origin) {
                    assertEquals(first.resolve("deleted.ts").toString(), filePath);
                    decision.thenAccept(result -> {
                        try {
                            Method route = EditableDiffHandler.class.getDeclaredMethod("handleNativeDiffResult",
                                    DiffResult.class, String.class, String.class, JsonArray.class, String.class, JsonObject.class);
                            route.setAccessible(true);
                            route.invoke(this, result, filePath, requestedPath, operations, status, origin);
                        } catch (ReflectiveOperationException error) {
                            throw new IllegalStateException(error);
                        }
                    });
                }
            };
            handler.handle("show_editable_diff", """
                    {"filePath":"deleted.ts","status":"D","operations":[
                     {"fileChangeKind":"delete","oldString":"old\\n","ledgerKey":"reviewed-deletion"}]}
                    """);
            queued.remove(0).run();
            ClaudeSession current = new ClaudeSession(null, null, null, null);
            current.setCwd(second.toString());
            current.getState().setSessionId("other-chat");
            context.setSession(current);
            decision.complete(DiffResult.apply(""));
            queued.remove(0).run();
            assertEquals(1, receipts.size());
            JsonObject receipt = receipts.get(0);
            assertTrue("Apply must retain an explicit source chat", receipt.has("sessionId"));
            assertEquals(originalSessionId, receipt.get("sessionId").isJsonNull() ? null : receipt.get("sessionId").getAsString());
            assertEquals("codex", receipt.get("provider").getAsString());
            assertEquals(JsonParser.parseString("[\"reviewed-deletion\"]"), receipt.get("ledgerKeys"));
            assertEquals("deleted.ts", receipt.get("filePath").getAsString());
            assertEquals("APPLY", receipt.get("action").getAsString());
            assertEquals(failWrite, receipt.has("error"));
            assertEquals("other chat\n", Files.readString(secondTarget));
        } finally {
            ApplicationManager.setApplication(previous);
        }
    }

    private void assertNativeDecisionKeepsItsDirectory(boolean switchBeforeOpening) throws Exception {
        this.assertNativeDecisionKeepsItsDirectory(switchBeforeOpening, false, null);
    }

    private void assertNativeDecisionKeepsItsDirectory(boolean switchBeforeOpening, boolean inspectSession, String originalSessionId)
            throws Exception {
        Path root = this.temporary.newFolder().toPath();
        Path first = Files.createDirectory(root.resolve("first"));
        Path second = Files.createDirectory(root.resolve("second"));
        Files.writeString(first.resolve("renamed.ts"), "edited\n");
        Files.writeString(second.resolve("renamed.ts"), "edited\n");
        List<Runnable> queued = new ArrayList<>();
        Application previous = ApplicationManager.getApplication();
        Application application = (Application) Proxy.newProxyInstance(Application.class.getClassLoader(),
                new Class<?>[]{Application.class}, (proxy, method, args) -> {
                    if ("invokeLater".equals(method.getName())) queued.add((Runnable) args[0]);
                    return method.getReturnType() == boolean.class ? false : null;
                });
        ApplicationManager.setApplication(application);
        try {
            Project project = (Project) Proxy.newProxyInstance(Project.class.getClassLoader(), new Class<?>[]{Project.class},
                    (proxy, method, args) -> "getBasePath".equals(method.getName()) ? root.toString() : null);
            HandlerContext context = new HandlerContext(project, null, null, null, null);
            ClaudeSession session = new ClaudeSession(null, null, null, null);
            session.setCwd(first.toString());
            session.getState().setSessionId(originalSessionId);
            session.getState().setProvider("codex");
            context.setSession(session);
            List<JsonObject> undos = new ArrayList<>();
            CompletableFuture<DiffResult> decision = new CompletableFuture<>();
            List<JsonArray> shownOperations = new ArrayList<>();
            EditableDiffHandler handler = new EditableDiffHandler(context, new Gson(),
                    new DiffBrowserBridge(context, new Gson()), new DiffFileOperations(context), undos::add) {
                @Override
                void showEditableDiff(String filePath, String requestedPath, JsonArray operations, String status,
                                      boolean nativePatch, JsonObject reviewOrigin) {
                    // Only the external diff UI is replaced; routing, capture and decision submission stay real.
                    assertTrue(nativePatch);
                    assertEquals(first.resolve("renamed.ts").toString(), filePath);
                    shownOperations.add(operations);
                    decision.thenAccept(result -> {
                        try {
                            Method route = EditableDiffHandler.class.getDeclaredMethod("handleNativeDiffResult",
                                    DiffResult.class, String.class, String.class, JsonArray.class, String.class, JsonObject.class);
                            route.setAccessible(true);
                            route.invoke(this, result, filePath, requestedPath, operations, status, reviewOrigin);
                        } catch (ReflectiveOperationException error) {
                            throw new IllegalStateException(error);
                        }
                    });
                }
            };
            JsonObject request = JsonParser.parseString("""
                    {"filePath":"renamed.ts","status":"R","operations":[
                     {"fileChangeKind":"update","moveFrom":"original.ts","oldString":"original\\n","newString":"middle\\n","ledgerKey":"reviewed-operation"},
                     {"fileChangeKind":"update","oldString":"middle\\n","newString":"edited\\n","ledgerKey":"reviewed-operation"}]}
                    """).getAsJsonObject();
            handler.handle("show_editable_diff", request.toString());
            assertEquals(1, queued.size());
            if (switchBeforeOpening) session.setCwd(second.toString());
            queued.remove(0).run();
            if (switchBeforeOpening) {
                assertEquals(first.resolve("original.ts").toString(),
                        shownOperations.get(0).get(0).getAsJsonObject().get("moveFrom").getAsString());
            }
            session.setCwd(second.toString());
            if (inspectSession) {
                ClaudeSession current = new ClaudeSession(null, null, null, null);
                current.getState().setSessionId("other-chat");
                current.setCwd(second.toString());
                context.setSession(current);
            }
            decision.complete(DiffResult.reject());
            assertEquals(1, undos.size());
            JsonObject undo = undos.get(0);
            assertEquals(first.resolve("renamed.ts").toString(), undo.get("filePath").getAsString());
            assertEquals("renamed.ts", undo.get("resultFilePath").getAsString());
            if (inspectSession) {
                assertTrue("The review must preserve an explicit origin, including null", undo.has("sessionId"));
                assertEquals(originalSessionId, undo.get("sessionId").isJsonNull() ? null : undo.get("sessionId").getAsString());
                assertEquals("codex", undo.get("provider").getAsString());
                assertEquals(JsonParser.parseString("[\"reviewed-operation\"]"), undo.get("ledgerKeys"));
            }
            FileChangeUndoPlan restored = FileChangeUndoPlan.rebuild(undo.get("filePath").getAsString(), "edited\n",
                    undo.getAsJsonArray("operations"));
            assertEquals(first.resolve("original.ts").toString(), restored.filePath());
            assertEquals("original\n", restored.content());
            assertEquals("original.ts", request.getAsJsonArray("operations").get(0).getAsJsonObject().get("moveFrom").getAsString());
            assertEquals("edited\n", Files.readString(second.resolve("renamed.ts")));
        } finally {
            ApplicationManager.setApplication(previous);
        }
    }
}
