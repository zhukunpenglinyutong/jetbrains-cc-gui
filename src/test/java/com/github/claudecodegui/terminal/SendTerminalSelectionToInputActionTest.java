package com.github.claudecodegui.terminal;

import org.junit.After;
import org.junit.Assert;
import org.junit.Test;

public class SendTerminalSelectionToInputActionTest {

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
}
