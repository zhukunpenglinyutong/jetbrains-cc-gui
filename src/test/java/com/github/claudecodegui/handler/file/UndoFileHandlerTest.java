package com.github.claudecodegui.handler.file;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.util.FileChangeUndoPlan;
import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/** Exercises the real file restoration and project boundary without launching an IDE. */
public class UndoFileHandlerTest {
    /** Keeps filesystem fixtures isolated from project files. */
    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    /** Holds a single undo target steady while the IDE work queue waits. */
    @Test
    public void remembersTheSubmittedDirectoryForDeferredUndo() throws Exception {
        this.assertQueuedUndoDirectory("undo_file_changes");
    }

    /** Holds batch undo targets steady while the IDE work queue waits. */
    @Test
    public void remembersTheSubmittedDirectoryForDeferredBatchUndo() throws Exception {
        this.assertQueuedUndoDirectory("undo_all_file_changes");
    }

    /** An absolute filesystem target can keep the browser's original relative receipt identity. */
    @Test
    public void preservesTheDiffReceiptWithoutRetargetingItsAbsoluteUndo() throws Exception {
        this.assertQueuedUndoDirectory("undo_file_changes", true);
    }

    /** A completed disk undo keeps the reviewed chat identity after a window starts showing another chat. */
    @Test
    public void preservesTheReviewedSessionOnUndoSuccess() throws Exception {
        JsonObject identity = new JsonObject();
        identity.addProperty("sessionId", "reviewed-chat");
        identity.addProperty("provider", "codex");
        identity.add("ledgerKeys", JsonParser.parseString("[\"reviewed-operation\"]"));
        this.assertQueuedUndoDirectory("undo_file_changes", true, identity, false);
    }

    /** Explicit null remains distinct from the older receipt shape without a session field. */
    @Test
    public void preservesAnExplicitUnboundSessionOnUndoSuccess() throws Exception {
        JsonObject identity = new JsonObject();
        identity.add("sessionId", JsonNull.INSTANCE);
        identity.addProperty("provider", "codex");
        identity.add("ledgerKeys", JsonParser.parseString("[\"reviewed-operation\"]"));
        this.assertQueuedUndoDirectory("undo_file_changes", true, identity, false);
    }

    /** Path validation errors retain the same origin and relative browser identity as successful receipts. */
    @Test
    public void preservesTheReviewedSessionOnUndoValidationFailure() throws Exception {
        JsonObject identity = new JsonObject();
        identity.addProperty("sessionId", "reviewed-chat");
        identity.addProperty("provider", "codex");
        identity.add("ledgerKeys", JsonParser.parseString("[\"reviewed-operation\"]"));
        this.assertQueuedUndoDirectory("undo_file_changes", true, identity, true);
    }

    /** Restores a relative rename source in the submitted directory without borrowing the new session cwd. */
    @Test
    public void keepsRelativeRenameMetadataInTheSubmittedDirectory() throws Exception {
        Path root = this.temporary.newFolder().toPath();
        Path first = Files.createDirectory(root.resolve("first"));
        Path second = Files.createDirectory(root.resolve("second"));
        Project project = (Project) Proxy.newProxyInstance(Project.class.getClassLoader(), new Class<?>[]{Project.class},
                (proxy, method, args) -> "getBasePath".equals(method.getName()) ? root.toString() : null);
        HandlerContext context = new HandlerContext(project, null, null, null, null);
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setCwd(second.toString());
        context.setSession(session);
        UndoFileHandler handler = new UndoFileHandler(context);
        JsonArray operations = JsonParser.parseString("""
                [{"fileChangeKind":"update","moveFrom":"original.ts","oldString":"original\\n","newString":"edited\\n"}]
                """).getAsJsonArray();
        Method resolve = UndoFileHandler.class.getDeclaredMethod("resolveOperationPaths", JsonArray.class, String.class);
        resolve.setAccessible(true);
        JsonArray resolved = (JsonArray) resolve.invoke(handler, operations, first.toString());
        FileChangeUndoPlan plan = FileChangeUndoPlan.rebuild(first.resolve("renamed.ts").toString(), "edited\n", resolved);
        assertEquals(first.resolve("original.ts").toString(), plan.filePath());
        assertEquals("original\n", plan.content());
        assertEquals("original.ts", operations.get(0).getAsJsonObject().get("moveFrom").getAsString());
    }

    private void assertQueuedUndoDirectory(String type) throws Exception {
        this.assertQueuedUndoDirectory(type, false);
    }

    private void assertQueuedUndoDirectory(String type, boolean receiptAlias) throws Exception {
        this.assertQueuedUndoDirectory(type, receiptAlias, new JsonObject(), false);
    }

    private void assertQueuedUndoDirectory(String type, boolean receiptAlias, JsonObject receiptIdentity, boolean invalidTarget) throws Exception {
        Path root = this.temporary.newFolder().toPath();
        Path first = Files.createDirectory(root.resolve("first"));
        Path second = Files.createDirectory(root.resolve("second"));
        Files.writeString(first.resolve("created.ts"), "submitted creation\n");
        Files.writeString(second.resolve("created.ts"), "other directory\n");
        List<Runnable> queued = new ArrayList<>();
        List<JsonObject> replies = new ArrayList<>();
        Application previous = ApplicationManager.getApplication();
        Application application = (Application) Proxy.newProxyInstance(Application.class.getClassLoader(),
                new Class<?>[]{Application.class}, (proxy, method, args) -> {
                    if ("invokeLater".equals(method.getName())) queued.add((Runnable) args[0]);
                    if ("executeOnPooledThread".equals(method.getName())) queued.add((Runnable) args[0]);
                    return method.getReturnType() == boolean.class ? false : null;
                });
        ApplicationManager.setApplication(application);
        try {
            Project project = (Project) Proxy.newProxyInstance(Project.class.getClassLoader(), new Class<?>[]{Project.class},
                    (proxy, method, args) -> "getBasePath".equals(method.getName()) ? root.toString() : null);
            HandlerContext context = new HandlerContext(project, null, null, null, new HandlerContext.JsCallback() {
                /** Captures the handler's actual completion receipt. */
                @Override
                public void callJavaScript(String name, String... args) {
                    replies.add(JsonParser.parseString(args[0]).getAsJsonObject());
                }

                /** Leaves result JSON unchanged in this non-browser receiver. */
                @Override
                public String escapeJs(String value) { return value; }
            });
            ClaudeSession session = new ClaudeSession(null, null, null, null);
            session.setCwd(first.toString());
            context.setSession(session);
            UndoFileHandler handler = new UndoFileHandler(context) {
                @Override
                void deleteFile(String filePath) throws Exception {
                    // Replace only the IDE filesystem adapter; routing and queued resolution stay real.
                    Files.delete(Path.of(filePath));
                }
            };
            JsonObject fileRequest = new JsonObject();
            fileRequest.addProperty("filePath", invalidTarget ? root.getParent().resolve("outside.ts").toString()
                    : receiptAlias ? first.resolve("created.ts").toString() : "created.ts");
            fileRequest.addProperty("status", "A");
            fileRequest.add("operations", new JsonArray());
            if (receiptAlias) fileRequest.addProperty("resultFilePath", "created.ts");
            for (var entry : receiptIdentity.entrySet()) fileRequest.add(entry.getKey(), entry.getValue().deepCopy());
            String file = fileRequest.toString();
            handler.handle(type, "undo_all_file_changes".equals(type) ? "{\"files\":[" + file + "]}" : file);
            assertEquals(1, queued.size());
            session.setCwd(second.toString());
            session.getState().setSessionId("other-chat");
            for (int index = 0; index < queued.size(); index++) queued.get(index).run();
            assertEquals(1, replies.size());
            assertEquals(!invalidTarget, replies.get(0).get("success").getAsBoolean());
            if ("undo_file_changes".equals(type)) {
                assertEquals("created.ts", replies.get(0).get("filePath").getAsString());
                assertEquals(receiptIdentity.has("sessionId"), replies.get(0).has("sessionId"));
                assertEquals(receiptIdentity.has("provider"), replies.get(0).has("provider"));
                assertEquals(receiptIdentity.has("ledgerKeys"), replies.get(0).has("ledgerKeys"));
                for (var entry : receiptIdentity.entrySet()) {
                    assertEquals(entry.getValue(), replies.get(0).get(entry.getKey()));
                }
            }
            assertEquals("Only the submitted creation may be undone", invalidTarget, Files.exists(first.resolve("created.ts")));
            assertEquals("other directory\n", Files.readString(second.resolve("created.ts")));
        } finally {
            ApplicationManager.setApplication(previous);
        }
    }

    /** Recreates a deleted file with its complete baseline. */
    @Test
    public void restoresADeletedFileOnDisk() throws Exception {
        Path deleted = this.temporary.getRoot().toPath().resolve("nested/deleted.ts");
        this.restore(deleted, deleted, "original\n");
        assertEquals("original\n", Files.readString(deleted));
    }

    /** Restores a renamed file before removing its current path. */
    @Test
    public void movesTheBaselineBackOnDisk() throws Exception {
        Path root = this.temporary.getRoot().toPath();
        Path current = root.resolve("moved.ts");
        Path original = root.resolve("original.ts");
        Files.writeString(current, "edited\n");
        this.restore(current, original, "original\n");
        assertFalse(Files.exists(current));
        assertEquals("original\n", Files.readString(original));
    }

    /** An occupied source cannot be overwritten or cause the edited file to disappear. */
    @Test
    public void protectsAnOccupiedRenameSource() throws Exception {
        Path root = this.temporary.getRoot().toPath();
        Path current = root.resolve("moved.ts");
        Path original = root.resolve("original.ts");
        Files.writeString(current, "edited\n");
        Files.writeString(original, "user content\n");
        assertThrows(InvocationTargetException.class, () -> this.restore(current, original, "baseline\n"));
        assertEquals("user content\n", Files.readString(original));
        assertEquals("edited\n", Files.readString(current));
    }

    /** Resolves relative paths in the project and rejects traversal and directory targets. */
    @Test
    public void rejectsPathsOutsideTheProject() throws Exception {
        Path root = this.temporary.newFolder("project").toPath();
        Project project = (Project) Proxy.newProxyInstance(Project.class.getClassLoader(), new Class<?>[]{Project.class},
                (proxy, method, args) -> "getBasePath".equals(method.getName()) ? root.toString() : null);
        HandlerContext context = new HandlerContext(project, null, null, null, null);
        UndoFileHandler handler = new UndoFileHandler(context);
        Method validate = UndoFileHandler.class.getDeclaredMethod("isValidFilePath", String.class);
        validate.setAccessible(true);
        assertTrue((boolean) validate.invoke(handler, "src/file.ts"));
        assertFalse((boolean) validate.invoke(handler, "../outside.ts"));
        assertFalse((boolean) validate.invoke(handler, root.toString()));
        JsonObject op = new JsonObject();
        op.addProperty("fileChangeKind", "update");
        op.addProperty("moveFrom", "../outside.ts");
        JsonArray operations = new JsonArray();
        operations.add(op);
        Method undo = UndoFileHandler.class.getDeclaredMethod("restoreNativeEdits", String.class, String.class, JsonArray.class);
        undo.setAccessible(true);
        InvocationTargetException failure = assertThrows(InvocationTargetException.class,
                () -> undo.invoke(handler, "src/file.ts", "R", operations));
        assertTrue(failure.getCause() instanceof IllegalArgumentException);
    }

    private void restore(Path current, Path original, String content) throws Exception {
        Method restore = UndoFileHandler.class.getDeclaredMethod("restoreFileBaseline", Path.class, Path.class, String.class, Charset.class);
        restore.setAccessible(true);
        restore.invoke(new UndoFileHandler(null), current, original, content, StandardCharsets.UTF_8);
    }
}
