package com.github.claudecodegui.action.editor;

import com.intellij.openapi.actionSystem.ActionGroup;
import com.intellij.openapi.actionSystem.ActionManager;
import com.intellij.openapi.actionSystem.ActionPopupMenu;
import com.intellij.openapi.actionSystem.ActionToolbar;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.actionSystem.DataContext;
import com.intellij.openapi.actionSystem.KeyboardShortcut;
import com.intellij.openapi.actionSystem.Presentation;
import com.intellij.openapi.actionSystem.TimerListener;
import com.intellij.openapi.actionSystem.ex.AnActionListener;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.fileTypes.FileTypes;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.testFramework.LightVirtualFile;
import org.junit.After;
import org.junit.Assert;
import org.junit.Test;

import java.awt.Component;
import java.awt.event.InputEvent;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.Collections;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public class CopySelectionReferenceActionTest {

    private final CopySelectionReferenceAction action = new CopySelectionReferenceAction(new SelectionReferenceBuilder());

    @After
    public void tearDown() {
        CopySelectionReferenceAction.resetClipboardWriter();
    }

    @Test
    public void successfulResultWritesExactReferenceToClipboardWriter() {
        AtomicReference<String> written = new AtomicReference<>();
        CopySelectionReferenceAction.setClipboardWriterForTest(written::set);

        action.handleBuildResult(null, SelectionReferenceBuilder.Result.success("@D:\\Code\\demo\\Foo.java#L12-24"));

        Assert.assertEquals("@D:\\Code\\demo\\Foo.java#L12-24", written.get());
    }

    @Test
    public void failedResultDoesNotWriteAnything() {
        AtomicBoolean called = new AtomicBoolean(false);
        CopySelectionReferenceAction.setClipboardWriterForTest(text -> called.set(true));

        action.handleBuildResult(null, SelectionReferenceBuilder.Result.failure("send.selectCodeFirst"));

        Assert.assertFalse(called.get());
    }

    @Test
    public void clipboardWriterFailureIsSwallowed() {
        CopySelectionReferenceAction.setClipboardWriterForTest(text -> {
            throw new RuntimeException("boom");
        });

        action.handleBuildResult(null, SelectionReferenceBuilder.Result.success("@D:\\Code\\demo\\Foo.java#L1"));
    }

    @Test
    public void updateShowsActionForNonBlankSelectionOnly() {
        AnActionEvent event = createEvent(createDataContext(createEditor("selected"), null, createProject()));

        action.update(event);

        Assert.assertTrue(event.getPresentation().isVisible());
        Assert.assertTrue(event.getPresentation().isEnabled());
    }

    @Test
    public void updateShowsActionForWhitespaceSelection() {
        AnActionEvent event = createEvent(createDataContext(createEditor("   "), null, createProject()));

        action.update(event);

        Assert.assertTrue(event.getPresentation().isVisible());
        Assert.assertTrue(event.getPresentation().isEnabled());
    }

    @Test
    public void updateHidesActionForEmptySelection() {
        AnActionEvent event = createEvent(createDataContext(createEditor(""), null, createProject()));

        action.update(event);

        Assert.assertFalse(event.getPresentation().isVisible());
        Assert.assertFalse(event.getPresentation().isEnabled());
    }

    @Test
    public void updateHidesActionForNullEditor() {
        AnActionEvent event = createEvent(createDataContext(null, null, createProject()));

        action.update(event);

        Assert.assertFalse(event.getPresentation().isVisible());
        Assert.assertFalse(event.getPresentation().isEnabled());
    }

    @Test
    public void updateHidesActionForNullProject() {
        AnActionEvent event = createEvent(createDataContext(createEditor("selected"), null));

        action.update(event);

        Assert.assertFalse(event.getPresentation().isVisible());
        Assert.assertFalse(event.getPresentation().isEnabled());
    }

    @Test
    public void buildSelectionReferenceUsesVirtualFileWithoutProject() {
        VirtualFile virtualFile = createFile("D:\\Code\\demo\\Foo.java");
        Editor editor = createEditor("selected");
        RecordingSelectionReferenceBuilder builder = new RecordingSelectionReferenceBuilder();
        CopySelectionReferenceAction testAction = new CopySelectionReferenceAction(builder);
        AnActionEvent event = createEvent(createDataContext(editor, virtualFile));

        SelectionReferenceBuilder.Result result = testAction.buildSelectionReference(event);

        Assert.assertTrue(result.isSuccess());
        Assert.assertSame(editor, builder.editor);
        Assert.assertSame(virtualFile, builder.file);
    }

    @SuppressWarnings("removal")
    private static AnActionEvent createEvent(DataContext dataContext) {
        return new AnActionEvent(null, dataContext, "TestPlace", new Presentation(), new TestActionManager(), 0);
    }

    private static DataContext createDataContext(Editor editor, VirtualFile virtualFile) {
        return createDataContext(editor, virtualFile, null);
    }

    private static DataContext createDataContext(Editor editor, VirtualFile virtualFile, Project project) {
        return dataId -> {
            if (CommonDataKeys.EDITOR.getName().equals(dataId)) {
                return editor;
            }
            if (CommonDataKeys.VIRTUAL_FILE.getName().equals(dataId)) {
                return virtualFile;
            }
            if (CommonDataKeys.PROJECT.getName().equals(dataId)) {
                return project;
            }
            return null;
        };
    }

    private static Project createProject() {
        return (Project) Proxy.newProxyInstance(
                Project.class.getClassLoader(),
                new Class[]{Project.class},
                (proxy, method, args) -> defaultValue(method.getReturnType(), proxy, args)
        );
    }

    private static Editor createEditor(String selectedText) {
        SelectionModel selectionModel = (SelectionModel) Proxy.newProxyInstance(
                SelectionModel.class.getClassLoader(),
                new Class[]{SelectionModel.class},
                new SelectionModelHandler(selectedText)
        );
        return (Editor) Proxy.newProxyInstance(
                Editor.class.getClassLoader(),
                new Class[]{Editor.class},
                (proxy, method, args) -> {
                    if ("getSelectionModel".equals(method.getName())) {
                        return selectionModel;
                    }
                    return defaultValue(method.getReturnType(), proxy, args);
                }
        );
    }

    private static VirtualFile createFile(String path) {
        return new LightVirtualFile("Foo.java", FileTypes.PLAIN_TEXT, "") {
            @Override
            public String getPath() {
                return path;
            }
        };
    }

    private static Object defaultValue(Class<?> returnType, Object proxy, Object[] args) {
        return defaultValue(returnType);
    }

    private static Object defaultValue(Class<?> returnType) {
        if (!returnType.isPrimitive()) {
            return null;
        }
        if (returnType == boolean.class) {
            return false;
        }
        if (returnType == int.class) {
            return 0;
        }
        if (returnType == long.class) {
            return 0L;
        }
        if (returnType == double.class) {
            return 0.0d;
        }
        if (returnType == float.class) {
            return 0f;
        }
        if (returnType == short.class) {
            return (short) 0;
        }
        if (returnType == byte.class) {
            return (byte) 0;
        }
        if (returnType == char.class) {
            return '\u0000';
        }
        return null;
    }

    private static final class SelectionModelHandler implements InvocationHandler {
        private final String selectedText;

        private SelectionModelHandler(String selectedText) {
            this.selectedText = selectedText;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) {
            if ("getSelectedText".equals(method.getName())) {
                return selectedText;
            }
            return defaultValue(method.getReturnType());
        }
    }

    private static final class RecordingSelectionReferenceBuilder extends SelectionReferenceBuilder {
        private Editor editor;
        private VirtualFile file;

        @Override
        public Result build(Editor editor, VirtualFile file) {
            this.editor = editor;
            this.file = file;
            return Result.success("@D:\\Code\\demo\\Foo.java#L1");
        }
    }

    @SuppressWarnings("removal")
    private static final class TestActionManager extends ActionManager {
        @Override
        public ActionPopupMenu createActionPopupMenu(String place, ActionGroup group) {
            return null;
        }

        @Override
        public ActionToolbar createActionToolbar(String place, ActionGroup group, boolean horizontal) {
            return null;
        }

        @Override
        public AnAction getAction(String id) {
            return null;
        }

        @Override
        public String getId(AnAction action) {
            return null;
        }

        @Override
        public void registerAction(String actionId, AnAction action) {
        }

        @Override
        public void registerAction(String actionId, AnAction action,
                                   com.intellij.openapi.extensions.PluginId pluginId) {
        }

        @Override
        public void unregisterAction(String actionId) {
        }

        @Override
        public void replaceAction(String actionId, AnAction newAction) {
        }

        @Override
        public String[] getActionIds(String idPrefix) {
            return new String[0];
        }

        @Override
        public java.util.List<String> getActionIdList(String idPrefix) {
            return Collections.emptyList();
        }

        @Override
        public boolean isGroup(String actionId) {
            return false;
        }

        @Override
        public AnAction getActionOrStub(String id) {
            return null;
        }

        @Override
        public void addTimerListener(TimerListener listener) {
        }

        @Override
        public void removeTimerListener(TimerListener listener) {
        }

        @Override
        public void addAnActionListener(AnActionListener listener) {
        }

        @Override
        public com.intellij.openapi.util.ActionCallback tryToExecute(AnAction action,
                                                                     InputEvent inputEvent,
                                                                     Component contextComponent,
                                                                     String place,
                                                                     boolean now) {
            return com.intellij.openapi.util.ActionCallback.DONE;
        }

        @Override
        public void addAnActionListener(AnActionListener listener,
                                        com.intellij.openapi.Disposable parentDisposable) {
        }

        @Override
        public KeyboardShortcut getKeyboardShortcut(String actionId) {
            return null;
        }
    }

}
