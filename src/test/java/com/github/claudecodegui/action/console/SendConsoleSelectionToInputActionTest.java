package com.github.claudecodegui.action.console;

import com.intellij.execution.ui.ConsoleView;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import org.junit.Assert;
import org.junit.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

public class SendConsoleSelectionToInputActionTest {

    @Test
    public void blankSelectionIsIgnored() {
        Assert.assertNull(SendConsoleSelectionToInputAction.resolveSelectedText(createConsoleView("   ")));
    }

    @Test
    public void fallbackSupportsConsoleViewImplementation() {
        Assert.assertEquals("payload", SendConsoleSelectionToInputAction.resolveSelectedText(createConsoleView("payload")));
    }

    @Test
    public void unsupportedObjectReturnsNull() {
        Assert.assertNull(SendConsoleSelectionToInputAction.resolveSelectedText(new Object()));
    }

    private static ConsoleView createConsoleView(String selectedText) {
        Editor editor = createEditor(selectedText);
        return (ConsoleView) Proxy.newProxyInstance(
                ConsoleView.class.getClassLoader(),
                new Class[]{ConsoleViewWithEditor.class},
                new ConsoleViewInvocationHandler(editor)
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
                new EditorSelectionHandler(selectionModel)
        );
    }

    private interface ConsoleViewWithEditor extends ConsoleView {
        Editor getEditor();
    }

    private static final class ConsoleViewInvocationHandler implements InvocationHandler {
        private final Editor editor;

        ConsoleViewInvocationHandler(Editor editor) {
            this.editor = editor;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) {
            if ("getEditor".equals(method.getName())) {
                return editor;
            }
            return defaultValue(method.getReturnType());
        }
    }

    private static final class SelectionModelHandler implements InvocationHandler {
        private final String selectedText;

        SelectionModelHandler(String selectedText) {
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

    private static final class EditorSelectionHandler implements InvocationHandler {
        private final SelectionModel selectionModel;

        EditorSelectionHandler(SelectionModel selectionModel) {
            this.selectionModel = selectionModel;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) {
            if ("getSelectionModel".equals(method.getName())) {
                return selectionModel;
            }
            return defaultValue(method.getReturnType());
        }
    }

    private static Object defaultValue(Class<?> returnType) {
        if (!returnType.isPrimitive()) {
            return null;
        }
        if (returnType == boolean.class) {
            return false;
        }
        if (returnType == byte.class) {
            return (byte) 0;
        }
        if (returnType == short.class) {
            return (short) 0;
        }
        if (returnType == int.class) {
            return 0;
        }
        if (returnType == long.class) {
            return 0L;
        }
        if (returnType == float.class) {
            return 0f;
        }
        if (returnType == double.class) {
            return 0d;
        }
        if (returnType == char.class) {
            return '\0';
        }
        return null;
    }
}
