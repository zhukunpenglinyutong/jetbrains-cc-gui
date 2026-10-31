package com.github.claudecodegui.ui.toolwindow;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class PendingSelectionContextTest {
    @Test
    public void inactiveTabReplaysOnlyTheLatestSelectionWhenItsPageBecomesReady() {
        ClaudeChatWindow.PendingSelectionContext context = new ClaudeChatWindow.PendingSelectionContext();
        List<String> delivered = new ArrayList<>();
        for (int i = 0; i < 1000; i++) {
            context.update("@file-" + i + "#L1-2");
        }
        assertTrue(delivered.isEmpty());

        context.replay(delivered::add);

        assertEquals(List.of("@file-999#L1-2"), delivered);
    }

    @Test
    public void clearingWhileHiddenSupersedesPreviouslySelectedCode() {
        ClaudeChatWindow.PendingSelectionContext context = new ClaudeChatWindow.PendingSelectionContext();
        List<String> delivered = new ArrayList<>();
        context.update("@old-file#L1-5");
        context.update(null);

        context.replay(delivered::add);

        assertEquals(1, delivered.size());
        assertNull(delivered.get(0));
    }

    @Test
    public void recoveredPageGetsCurrentContextWithoutWaitingForAnotherEditorEvent() {
        ClaudeChatWindow.PendingSelectionContext context = new ClaudeChatWindow.PendingSelectionContext();
        List<String> firstPage = new ArrayList<>();
        List<String> recoveredPage = new ArrayList<>();
        context.update("@current-file");
        context.replay(firstPage::add);

        context.replay(recoveredPage::add);

        assertEquals(firstPage, recoveredPage);
        assertEquals(List.of("@current-file"), recoveredPage);
    }

    @Test
    public void unknownContextDoesNotClearANewPageAndOtherTabsKeepTheirOwnState() {
        ClaudeChatWindow.PendingSelectionContext first = new ClaudeChatWindow.PendingSelectionContext();
        ClaudeChatWindow.PendingSelectionContext second = new ClaudeChatWindow.PendingSelectionContext();
        List<String> delivered = new ArrayList<>();
        first.update("@first-tab");

        second.replay(delivered::add);
        assertTrue(delivered.isEmpty());
        second.update("@second-tab");
        first.replay(delivered::add);

        assertEquals(List.of("@first-tab"), delivered);
    }
}
