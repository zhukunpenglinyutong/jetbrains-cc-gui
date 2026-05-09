package com.github.claudecodegui.action.editor;

import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.LogicalPosition;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.fileTypes.FileTypes;
import com.intellij.testFramework.LightVirtualFile;
import org.junit.Assert;
import org.junit.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

public class SelectionReferenceBuilderTest {

    private static final int SELECTION_START_OFFSET = 10;
    private static final int SELECTION_END_OFFSET = 20;

    private final SelectionReferenceBuilder builder = new SelectionReferenceBuilder();

    @Test
    public void singleLineSelectionBuildsSingleLineReference() {
        SelectionReferenceBuilder.Result result = builder.buildFromRawSelection(
                "selected",
                "D:\\Code\\demo\\Foo.java",
                12,
                12
        );

        Assert.assertTrue(result.isSuccess());
        Assert.assertEquals("@D:\\Code\\demo\\Foo.java#L12", result.getReference());
    }

    @Test
    public void multiLineSelectionBuildsRangeReference() {
        SelectionReferenceBuilder.Result result = builder.buildFromRawSelection(
                "selected",
                "D:\\Code\\demo\\Foo.java",
                12,
                24
        );

        Assert.assertTrue(result.isSuccess());
        Assert.assertEquals("@D:\\Code\\demo\\Foo.java#L12-24", result.getReference());
    }

    @Test
    public void selectionEndingAtNextLineColumnZeroUsesPreviousLine() {
        SelectionReferenceBuilder.Result result = builder.build(createEditor("selected", 12, 24, 0), createFile("D:\\Code\\demo\\Foo.java"));

        Assert.assertTrue(result.isSuccess());
        Assert.assertEquals("@D:\\Code\\demo\\Foo.java#L12-23", result.getReference());
    }

    @Test
    public void blankSelectionFails() {
        SelectionReferenceBuilder.Result result = builder.buildFromRawSelection(
                "   ",
                "D:\\Code\\demo\\Foo.java",
                12,
                24
        );

        Assert.assertFalse(result.isSuccess());
        Assert.assertEquals("send.selectCodeFirst", result.getMessageKey());
    }

    @Test
    public void blankSelectionSkipsDocumentLookup() {
        SelectionModel selectionModel = (SelectionModel) Proxy.newProxyInstance(
                SelectionModel.class.getClassLoader(),
                new Class[]{SelectionModel.class},
                new SelectionModelHandler("   ", SELECTION_START_OFFSET, SELECTION_END_OFFSET)
        );
        Editor editor = (Editor) Proxy.newProxyInstance(
                Editor.class.getClassLoader(),
                new Class[]{Editor.class},
                (proxy, method, args) -> {
                    if ("getSelectionModel".equals(method.getName())) {
                        return selectionModel;
                    }
                    if ("getDocument".equals(method.getName())) {
                        throw new AssertionError("Document should not be requested for blank selections");
                    }
                    return defaultValue(method.getReturnType());
                }
        );

        SelectionReferenceBuilder.Result result = builder.build(editor, createFile("D:\\Code\\demo\\Foo.java"));

        Assert.assertFalse(result.isSuccess());
        Assert.assertEquals("send.selectCodeFirst", result.getMessageKey());
    }

    @Test
    public void blankPathFails() {
        SelectionReferenceBuilder.Result result = builder.buildFromRawSelection(
                "selected",
                "   ",
                12,
                24
        );

        Assert.assertFalse(result.isSuccess());
        Assert.assertEquals("send.cannotGetFilePath", result.getMessageKey());
    }

    @Test
    public void nullEditorFailsFast() {
        SelectionReferenceBuilder.Result editorResult = builder.build(null, createFile("D:\\Code\\demo\\Foo.java"));
        Assert.assertFalse(editorResult.isSuccess());
        Assert.assertEquals("send.cannotGetEditor", editorResult.getMessageKey());
    }

    @Test
    public void nullFileFailsFast() {
        SelectionReferenceBuilder.Result fileResult = builder.build(createEditor("selected", 11, 11), null);
        Assert.assertFalse(fileResult.isSuccess());
        Assert.assertEquals("send.cannotGetFile", fileResult.getMessageKey());
    }

    @Test
    public void successRejectsNullReference() {
        NullPointerException exception = Assert.assertThrows(
                NullPointerException.class,
                () -> SelectionReferenceBuilder.Result.success(null)
        );

        Assert.assertEquals("reference", exception.getMessage());
    }

    private static Editor createEditor(String selectedText, int startLineNumber, int endLineNumber, int endColumn) {
        SelectionModel selectionModel = (SelectionModel) Proxy.newProxyInstance(
                SelectionModel.class.getClassLoader(),
                new Class[]{SelectionModel.class},
                new SelectionModelHandler(selectedText, SELECTION_START_OFFSET, SELECTION_END_OFFSET)
        );
        Document document = (Document) Proxy.newProxyInstance(
                Document.class.getClassLoader(),
                new Class[]{Document.class},
                new DocumentHandler(startLineNumber - 1, endLineNumber - 1, SELECTION_START_OFFSET, SELECTION_END_OFFSET)
        );
        return (Editor) Proxy.newProxyInstance(
                Editor.class.getClassLoader(),
                new Class[]{Editor.class},
                new EditorHandler(selectionModel, document, endColumn)
        );
    }

    private static Editor createEditor(String selectedText, int startLineNumber, int endLineNumber) {
        return createEditor(selectedText, startLineNumber, endLineNumber, 1);
    }

    private static com.intellij.openapi.vfs.VirtualFile createFile(String path) {
        return new LightVirtualFile("Foo.java", FileTypes.PLAIN_TEXT, "") {
            @Override
            public String getPath() {
                return path;
            }
        };
    }

    private static final class EditorHandler implements InvocationHandler {
        private final SelectionModel selectionModel;
        private final Document document;
        private final int endColumn;

        private EditorHandler(SelectionModel selectionModel, Document document, int endColumn) {
            this.selectionModel = selectionModel;
            this.document = document;
            this.endColumn = endColumn;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) {
            String name = method.getName();
            if ("getSelectionModel".equals(name)) {
                return selectionModel;
            }
            if ("getDocument".equals(name)) {
                return document;
            }
            if ("offsetToLogicalPosition".equals(name)) {
                // This test intentionally only models the end-column behavior.
                return new LogicalPosition(0, endColumn);
            }
            if ("isDisposed".equals(name)) {
                return false;
            }
            if ("equals".equals(name)) {
                return proxy == args[0];
            }
            if ("hashCode".equals(name)) {
                return System.identityHashCode(proxy);
            }
            if ("toString".equals(name)) {
                return "test-editor";
            }
            return defaultValue(method.getReturnType());
        }
    }

    private static final class SelectionModelHandler implements InvocationHandler {
        private final String selectedText;
        private final int startOffset;
        private final int endOffset;

        private SelectionModelHandler(String selectedText, int startOffset, int endOffset) {
            this.selectedText = selectedText;
            this.startOffset = startOffset;
            this.endOffset = endOffset;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) {
            String name = method.getName();
            if ("getSelectedText".equals(name)) {
                return selectedText;
            }
            if ("getSelectionStart".equals(name)) {
                return startOffset;
            }
            if ("getSelectionEnd".equals(name)) {
                return endOffset;
            }
            if ("equals".equals(name)) {
                return proxy == args[0];
            }
            if ("hashCode".equals(name)) {
                return System.identityHashCode(proxy);
            }
            if ("toString".equals(name)) {
                return "test-selection-model";
            }
            return defaultValue(method.getReturnType());
        }
    }

    private static final class DocumentHandler implements InvocationHandler {
        private final int startLineNumber;
        private final int endLineNumber;
        private final int startOffset;
        private final int endOffset;

        private DocumentHandler(int startLineNumber, int endLineNumber, int startOffset, int endOffset) {
            this.startLineNumber = startLineNumber;
            this.endLineNumber = endLineNumber;
            this.startOffset = startOffset;
            this.endOffset = endOffset;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) {
            String name = method.getName();
            if ("getLineNumber".equals(name)) {
                int offset = (Integer) args[0];
                if (offset == startOffset) {
                    return startLineNumber;
                }
                if (offset == endOffset) {
                    return endLineNumber;
                }
                throw new AssertionError("Unexpected offset: " + offset);
            }
            if ("equals".equals(name)) {
                return proxy == args[0];
            }
            if ("hashCode".equals(name)) {
                return System.identityHashCode(proxy);
            }
            if ("toString".equals(name)) {
                return "test-document";
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
}
