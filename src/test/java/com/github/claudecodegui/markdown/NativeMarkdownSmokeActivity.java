package com.github.claudecodegui.markdown;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.SaveAndSyncHandler;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.command.WriteCommandAction;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.TextEditorWithPreview;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.StartupActivity;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.jcef.JBCefApp;
import org.intellij.plugins.markdown.settings.MarkdownSettings;
import org.jetbrains.annotations.NotNull;

import javax.swing.Timer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;

/** Development-only plugin entry point, excluded from the product JAR. */
public final class NativeMarkdownSmokeActivity implements StartupActivity.DumbAware {
    @Override
    public void runActivity(@NotNull Project project) {
        String directory = System.getProperty("ccgui.markdown.smoke.dir");
        if (directory == null || !directory.equals(project.getBasePath())) return;
        ApplicationManager.getApplication().invokeLater(() -> {
            Path folder = Path.of(directory);
            var file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(folder.resolve("review.md"));
            if (file == null) return;
            MarkdownSettings.getInstance(project).setSplitLayout(TextEditorWithPreview.Layout.SHOW_EDITOR_AND_PREVIEW);
            FileEditorManager.getInstance(project).openFile(file, true);
            var chat = ToolWindowManager.getInstance(project).getToolWindow("CCG");
            if (chat != null) chat.show();
            AtomicInteger port = new AtomicInteger();
            String[] lastCommand = { "" };
            Timer timer = new Timer(1000, event -> ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    Integer debuggingPort = JBCefApp.getInstance().getRemoteDebuggingPort();
                    port.set(debuggingPort == null ? 0 : debuggingPort);
                    Path commands = folder.resolve("command.json");
                    if (Files.exists(commands)) {
                        JsonObject command = new Gson().fromJson(Files.readString(commands), JsonObject.class);
                        String id = command.get("id").getAsString();
                        if (!id.equals(lastCommand[0])) {
                            lastCommand[0] = id;
                            var document = FileDocumentManager.getInstance().getDocument(file);
                            if (document != null && command.has("prepend")) {
                                WriteCommandAction.runWriteCommandAction(project, () -> document.insertString(0, command.get("prepend").getAsString()));
                            }
                            if (document != null && command.has("replace")) {
                                WriteCommandAction.runWriteCommandAction(project, () -> document.setText(command.get("replace").getAsString()));
                            }
                            if (command.has("reopen")) {
                                FileEditorManager.getInstance(project).closeFile(file);
                                FileEditorManager.getInstance(project).openFile(file, true);
                            }
                            if (command.has("save")) {
                                FileDocumentManager.getInstance().saveAllDocuments();
                                SaveAndSyncHandler.getInstance().scheduleSave(new SaveAndSyncHandler.SaveTask(project, true), true);
                            }
                            if (command.has("newChat")) {
                                var window = ClaudeSDKToolWindow.getSelectedChatWindow(project);
                                if (window != null) window.getSessionLifecycleManager().createNewSession();
                            }
                            if (command.has("exit")) {
                                ApplicationManager.getApplication().invokeLater(() -> {
                                    FileDocumentManager.getInstance().saveAllDocuments();
                                    project.save();
                                    ApplicationManager.getApplication().exit(true, true, false);
                                });
                            }
                        }
                    }
                    JsonObject state = new JsonObject();
                    state.addProperty("port", port.get());
                    state.addProperty("commandId", lastCommand[0]);
                    var window = ClaudeSDKToolWindow.getSelectedChatWindow(project);
                    if (window != null) state.addProperty("chatTargetId", window.getReviewTargetId());
                    state.add("reviews", new Gson().toJsonTree(MarkdownReviewService.getInstance(project).snapshotState()));
                    Files.writeString(folder.resolve("state.json"), state.toString());
                } catch (Exception error) {
                    com.intellij.openapi.diagnostic.Logger.getInstance(getClass()).warn("Native Markdown smoke failed", error);
                }
            }, ModalityState.nonModal()));
            Disposer.register(project, () -> timer.stop());
            timer.start();
        }, ModalityState.nonModal());
    }
}
