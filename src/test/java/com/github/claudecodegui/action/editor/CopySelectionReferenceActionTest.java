package com.github.claudecodegui.action.editor;

import com.intellij.openapi.actionSystem.ActionManager;
import com.intellij.openapi.actionSystem.ActionPopupMenu;
import com.intellij.openapi.actionSystem.ActionToolbar;
import com.intellij.openapi.actionSystem.ActionGroup;
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

    private final CopySelectionReferenceAction action = new CopySelectionReferenceAction(
            new SelectionReferenceBuilder(),
            "Copy AI Reference",
            "Copy the selected code location as an AI reference"
    );

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
        AnActionEvent event = createEvent(createDataContext(createProject(), createEditor("selected")));

        action.update(event);

        Assert.assertTrue(event.getPresentation().isVisible());
        Assert.assertTrue(event.getPresentation().isEnabled());
    }

    @Test
    public void updateHidesActionForBlankSelection() {
        AnActionEvent event = createEvent(createDataContext(createProject(), createEditor("   ")));

        action.update(event);

        Assert.assertFalse(event.getPresentation().isVisible());
        Assert.assertFalse(event.getPresentation().isEnabled());
    }

    private static AnActionEvent createEvent(DataContext dataContext) {
        return new AnActionEvent(null, dataContext, "TestPlace", new Presentation(), new TestActionManager(), 0);
    }

    private static DataContext createDataContext(Project project, Editor editor) {
        return dataId -> {
            if (CommonDataKeys.PROJECT.getName().equals(dataId)) {
                return project;
            }
            if (CommonDataKeys.EDITOR.getName().equals(dataId)) {
                return editor;
            }
            return null;
        };
    }

    private static Project createProject() {
        return (Project) Proxy.newProxyInstance(
                Project.class.getClassLoader(),
                new Class[]{Project.class},
                new SimpleHandler("test-project")
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

    private static final class SimpleHandler implements InvocationHandler {
        private final String text;

        private SimpleHandler(String text) {
            this.text = text;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) {
            if ("getName".equals(method.getName())) {
                return text;
            }
            return defaultValue(method.getReturnType());
        }
    }

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
