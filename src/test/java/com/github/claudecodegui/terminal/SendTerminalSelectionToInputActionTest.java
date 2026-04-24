package com.github.claudecodegui.terminal;

import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.ActionManager;
import com.intellij.openapi.actionSystem.ActionPopupMenu;
import com.intellij.openapi.actionSystem.ActionToolbar;
import com.intellij.openapi.actionSystem.ActionGroup;
import com.intellij.openapi.actionSystem.DataContext;
import com.intellij.openapi.actionSystem.DataKey;
import com.intellij.openapi.actionSystem.KeyboardShortcut;
import com.intellij.openapi.actionSystem.Presentation;
import com.intellij.openapi.actionSystem.TimerListener;
import com.intellij.openapi.actionSystem.ex.AnActionListener;
import org.junit.After;
import org.junit.Assert;
import org.junit.Test;

import java.awt.Component;
import java.awt.event.InputEvent;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;

public class SendTerminalSelectionToInputActionTest {
    private static final ActionManager TEST_ACTION_MANAGER = new TestActionManager();

    @After
    public void tearDown() {
        SendTerminalSelectionToInputAction.resetSelectionProvider();
    }

    @Test
    public void validSelectionIsReturned() {
        SendTerminalSelectionToInputAction.setSelectionProvider(event -> "payload");
        Assert.assertEquals("payload", SendTerminalSelectionToInputAction.resolveSelectedText(null));
    }

    @Test
    public void terminalPromptPopupPlaceShouldBeVisible() {
        Assert.assertTrue(SendTerminalSelectionToInputAction.isTerminalPopupPlace("Terminal.PromptContextMenu"));
    }

    @Test
    public void terminalOutputPopupPlaceShouldBeVisible() {
        Assert.assertTrue(SendTerminalSelectionToInputAction.isTerminalPopupPlace("Terminal.OutputContextMenu"));
    }

    @Test
    public void reworkedTerminalPopupPlaceShouldBeVisible() {
        Assert.assertTrue(SendTerminalSelectionToInputAction.isTerminalPopupPlace("Terminal.ReworkedTerminalContextMenu"));
    }

    @Test
    public void reworkedTerminalViewContextShouldMakeActionVisible() {
        SendTerminalSelectionToInputAction action = new SendTerminalSelectionToInputAction();
        AnActionEvent event = createEvent(createTerminalViewContext(new FakeTerminalView("payload")));

        action.update(event);

        Assert.assertTrue(event.getPresentation().isVisible());
        Assert.assertTrue(event.getPresentation().isEnabled());
    }

    @Test
    public void unrelatedPopupPlaceShouldNotBeTreatedAsTerminalPopup() {
        Assert.assertFalse(SendTerminalSelectionToInputAction.isTerminalPopupPlace("EditorPopupMenu"));
    }

    @Test
    public void blankSelectionIsFiltered() {
        SendTerminalSelectionToInputAction.setSelectionProvider(event -> "   ");
        Assert.assertNull(SendTerminalSelectionToInputAction.resolveSelectedText(null));
    }

    @Test
    public void unsupportedEditorReturnsNull() {
        SendTerminalSelectionToInputAction.setSelectionProvider(event -> null);
        Assert.assertNull(SendTerminalSelectionToInputAction.resolveSelectedText(null));
    }

    @Test
    public void reworkedTerminalSelectionIsResolvedReflectively() {
        SendTerminalSelectionToInputAction.setSelectionProvider(event -> null);

        AnActionEvent event = createEvent(createTerminalViewContext(new FakeTerminalView("payload")));

        Assert.assertEquals("payload", SendTerminalSelectionToInputAction.resolveSelectedText(event));
    }

    @Test
    public void terminalFeaturesRegisterActionForReworkedTerminalContextMenu() throws IOException {
        try (InputStream stream = getClass().getClassLoader().getResourceAsStream("META-INF/terminal-features.xml")) {
            Assert.assertNotNull("terminal-features.xml should be on the test classpath", stream);
            String xml = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
            Assert.assertTrue(xml.contains("group-id=\"Terminal.ReworkedTerminalContextMenu\""));
        }
    }

    private static AnActionEvent createEvent(DataContext dataContext) {
        return new AnActionEvent(null, dataContext, "TestPlace", new Presentation(), TEST_ACTION_MANAGER, 0);
    }

    private static DataContext createTerminalViewContext(Object terminalView) {
        DataKey<Object> terminalViewKey = DataKey.create("TerminalView");
        return dataId -> terminalViewKey.getName().equals(dataId) ? terminalView : null;
    }

    private static final class FakeTerminalView {
        private final FakeSelectionModel selectionModel = new FakeSelectionModel();
        private final FakeOutputModels outputModels;

        private FakeTerminalView(String selectedText) {
            outputModels = new FakeOutputModels(new FakeStateFlow(new FakeOutputModel(selectedText)));
        }

        public FakeSelectionModel getTextSelectionModel() {
            return selectionModel;
        }

        public FakeOutputModels getOutputModels() {
            return outputModels;
        }
    }

    private static final class FakeSelectionModel {
        public FakeSelection getSelection() {
            return new FakeSelection();
        }
    }

    private static final class FakeSelection {
        public Object getStartOffset() {
            return new Object();
        }

        public Object getEndOffset() {
            return new Object();
        }
    }

    private static final class FakeOutputModels {
        private final FakeStateFlow active;

        private FakeOutputModels(FakeStateFlow active) {
            this.active = active;
        }

        public FakeStateFlow getActive() {
            return active;
        }
    }

    private static final class FakeStateFlow {
        private final FakeOutputModel value;

        private FakeStateFlow(FakeOutputModel value) {
            this.value = value;
        }

        public FakeOutputModel getValue() {
            return value;
        }
    }

    private static final class FakeOutputModel {
        private final String selectedText;

        private FakeOutputModel(String selectedText) {
            this.selectedText = selectedText;
        }

        public CharSequence getText(Object startOffset, Object endOffset) {
            return selectedText;
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
        public com.intellij.openapi.actionSystem.AnAction getAction(String id) {
            return null;
        }

        @Override
        public String getId(com.intellij.openapi.actionSystem.AnAction action) {
            return null;
        }

        @Override
        public void registerAction(String actionId, com.intellij.openapi.actionSystem.AnAction action) {
        }

        @Override
        public void registerAction(String actionId, com.intellij.openapi.actionSystem.AnAction action, com.intellij.openapi.extensions.PluginId pluginId) {
        }

        @Override
        public void unregisterAction(String actionId) {
        }

        @Override
        public void replaceAction(String actionId, com.intellij.openapi.actionSystem.AnAction newAction) {
        }

        @Override
        public String[] getActionIds(String idPrefix) {
            return new String[0];
        }

        @Override
        public List<String> getActionIdList(String idPrefix) {
            return Collections.emptyList();
        }

        @Override
        public boolean isGroup(String actionId) {
            return false;
        }

        @Override
        public com.intellij.openapi.actionSystem.AnAction getActionOrStub(String id) {
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
        public com.intellij.openapi.util.ActionCallback tryToExecute(com.intellij.openapi.actionSystem.AnAction action,
                                                                     InputEvent inputEvent,
                                                                     Component contextComponent,
                                                                     String place,
                                                                     boolean now) {
            return com.intellij.openapi.util.ActionCallback.DONE;
        }

        @Override
        public void addAnActionListener(AnActionListener listener, com.intellij.openapi.Disposable parentDisposable) {
        }

        @Override
        public KeyboardShortcut getKeyboardShortcut(String actionId) {
            return null;
        }
    }
}
