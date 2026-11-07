package com.github.claudecodegui.ui;

import com.intellij.openapi.util.Key;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.ui.content.Content;
import org.junit.Test;

import javax.swing.Icon;
import javax.swing.ImageIcon;
import javax.swing.JPanel;
import java.awt.image.BufferedImage;
import java.lang.reflect.Proxy;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.*;

public class ChatWindowDelegateUnreadTest {
    private static final class Tab {
        final AtomicReference<Icon> icon = new AtomicReference<>();
        final AtomicReference<String> name = new AtomicReference<>("AI test");
        final Map<Key<?>, Object> data = new HashMap<>();
        final Content content = (Content) Proxy.newProxyInstance(Content.class.getClassLoader(),
                new Class<?>[]{Content.class}, (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "getIcon": return icon.get();
                        case "setIcon":
                            icon.set((Icon) args[0]);
                            return null;
                        case "getUserData": return data.get(args[0]);
                        case "putUserData": data.put((Key<?>) args[0], args[1]); return null;
                        case "getDisplayName": return name.get();
                        case "setDisplayName": name.set((String) args[0]); return null;
                        default: return method.getReturnType() == boolean.class ? false : null;
                    }
                });
    }

    /** Real delegate and icon changes, with a controllable EDT queue and no native browser. */
    private static final class Fixture {
        final AtomicBoolean selected = new AtomicBoolean();
        final AtomicBoolean showing = new AtomicBoolean(true);
        final AtomicBoolean ready = new AtomicBoolean(true);
        final AtomicBoolean disposed = new AtomicBoolean();
        final AtomicInteger saves = new AtomicInteger();
        final AtomicReference<Tab> tab = new AtomicReference<>(new Tab());
        final ArrayDeque<Runnable> queue = new ArrayDeque<>();
        final JPanel panel = new JPanel() {
            @Override public boolean isShowing() { return showing.get(); }
        };
        final ChatWindowDelegate.DelegateHost host = (ChatWindowDelegate.DelegateHost) Proxy.newProxyInstance(
                ChatWindowDelegate.DelegateHost.class.getClassLoader(),
                new Class<?>[]{ChatWindowDelegate.DelegateHost.class}, (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "getParentContent": return tab.get().content;
                        case "getMainPanel": return panel;
                        case "getOriginalTabName": return "AI test";
                        case "isActiveContent": return selected.get();
                        case "isFrontendReady": return ready.get();
                        case "isDisposed": return disposed.get();
                        case "persistTabSessionState": saves.incrementAndGet(); return null;
                        default: return method.getReturnType() == boolean.class ? false : null;
                    }
                });
        final ChatWindowDelegate delegate = new ChatWindowDelegate(host, queue::add);
        void drain() { while (!queue.isEmpty()) queue.removeFirst().run(); }
    }

    @Test
    public void aBackgroundCompletionPersistsUntilReadWithoutReplacingTheTabIcon() {
        Fixture f = new Fixture();
        Icon original = new ImageIcon(new BufferedImage(16, 16, BufferedImage.TYPE_INT_ARGB));
        f.tab.get().icon.set(original);
        f.delegate.onTurnCompleted(() -> true);
        f.drain();
        assertTrue(f.delegate.hasUnread());
        assertTrue(f.tab.get().name.get().contains("#3FA05B"));
        assertEquals("AI test", CompletedTabTitle.plain(f.tab.get().content));
        assertSame(original, f.tab.get().icon.get());
        assertNull(f.tab.get().data.get(ToolWindow.SHOW_CONTENT_ICON));
        for (int i = 0; i < 100; i++) f.delegate.onTurnCompleted(() -> true);
        assertTrue(f.queue.isEmpty());
        assertEquals(1, f.saves.get());
    }

    @Test
    public void visibleCompletionsStayRead() {
        Fixture f = new Fixture();
        f.selected.set(true);
        f.delegate.onTurnCompleted(() -> true); f.drain();
        assertFalse(f.delegate.hasUnread());
        assertEquals("AI test", f.tab.get().name.get());
        assertEquals(0, f.saves.get());
    }

    @Test
    public void onlyAVisibleReadySelectionClearsTheDot() {
        Fixture f = new Fixture();
        f.delegate.onTurnCompleted(() -> true); f.drain();
        f.selected.set(true); f.showing.set(false);
        f.delegate.markTabReadIfVisible(); f.drain();
        assertTrue(f.delegate.hasUnread());
        f.showing.set(true); f.ready.set(false);
        f.delegate.markTabReadIfVisible(); f.drain();
        assertTrue(f.delegate.hasUnread());
        f.ready.set(true);
        f.delegate.markTabReadIfVisible(); f.drain();
        assertFalse(f.delegate.hasUnread());
        assertEquals("AI test", f.tab.get().name.get());
        assertEquals(2, f.saves.get());
    }

    @Test
    public void aNewTurnInvalidatesQueuedCompletionAndClearsAnOlderDot() {
        Fixture f = new Fixture();
        f.delegate.onTurnCompleted(() -> true);
        f.delegate.onTurnStarted(); f.drain();
        assertFalse(f.delegate.hasUnread());
        f.delegate.onTurnCompleted(() -> true); f.drain();
        assertTrue(f.delegate.hasUnread());
        f.delegate.onTurnStarted(); f.drain();
        assertFalse(f.delegate.hasUnread());
        assertEquals("AI test", f.tab.get().name.get());
    }

    @Test
    public void theNextCompletionIsNotLostWhenAnOldCompletionWasStillQueued() {
        Fixture f = new Fixture();
        f.delegate.onTurnCompleted(() -> false);
        f.delegate.onTurnStarted();
        f.delegate.onTurnCompleted(() -> true); f.drain();
        assertTrue(f.delegate.hasUnread());
    }

    @Test
    public void queuedCompletionResamplesTaskVisibilityAndDisposal() {
        Fixture f = new Fixture();
        AtomicBoolean stillCompleted = new AtomicBoolean(true);
        f.delegate.onTurnCompleted(stillCompleted::get); stillCompleted.set(false); f.drain();
        assertFalse(f.delegate.hasUnread());
        f.delegate.onTurnCompleted(() -> true); f.selected.set(true); f.drain();
        assertFalse(f.delegate.hasUnread());
        f.selected.set(false); f.delegate.onTurnCompleted(() -> true); f.disposed.set(true); f.drain();
        assertFalse(f.delegate.hasUnread());
        assertEquals(0, f.saves.get());
    }

    @Test
    public void restoringUnreadDoesNotGenerateANewReplyOrClearItUntilRead() {
        Fixture f = new Fixture();
        f.delegate.restoreUnread(true); f.drain();
        assertTrue(f.delegate.hasUnread());
        assertEquals(0, f.saves.get());
        assertTrue(f.tab.get().name.get().contains("#3FA05B"));
        f.selected.set(true); f.delegate.markTabReadIfVisible(); f.drain();
        assertFalse(f.delegate.hasUnread());
        assertEquals("AI test", f.tab.get().name.get());
    }

    @Test
    public void reattachingTransfersTheDotAndReleasesTheOldContent() {
        Fixture f = new Fixture();
        f.delegate.onTurnCompleted(() -> true); f.drain();
        Tab original = f.tab.get(); f.tab.set(new Tab());
        f.delegate.refreshUnreadBadge(); f.drain();
        assertEquals("AI test", original.name.get());
        assertTrue(f.tab.get().name.get().contains("#3FA05B"));
        assertTrue(f.delegate.hasUnread());
    }

    @Test
    public void statusAndRenameChangesKeepTheDotOutOfThePlainTitle() {
        Fixture f = new Fixture();
        Application previous = ApplicationManager.getApplication();
        Application app = (Application) Proxy.newProxyInstance(Application.class.getClassLoader(),
                new Class<?>[]{Application.class}, (proxy, method, args) -> {
                    if (method.getName().equals("invokeLater")) f.queue.add((Runnable) args[0]);
                    return method.getReturnType() == boolean.class ? false : null;
                });
        try {
            ApplicationManager.setApplication(app);
            f.delegate.onTurnCompleted(() -> true); f.drain();
            f.delegate.updateTabStatus(ChatWindowDelegate.TabAnswerStatus.ANSWERING); f.drain();
            f.delegate.updateTabStatus(ChatWindowDelegate.TabAnswerStatus.IDLE); f.drain();
            assertTrue(f.delegate.hasUnread());
            assertEquals("AI test", CompletedTabTitle.plain(f.tab.get().content));
            CompletedTabTitle.setPlain(f.tab.get().content, "renamed <A&B>");
            assertEquals("renamed <A&B>", CompletedTabTitle.plain(f.tab.get().content));
            assertTrue(f.tab.get().name.get().contains("#3FA05B"));
            f.selected.set(true); f.delegate.markTabReadIfVisible(); f.drain();
            assertEquals("renamed <A&B>", f.tab.get().name.get());
        } finally {
            f.delegate.dispose();
            ApplicationManager.setApplication(previous);
        }
    }
}
