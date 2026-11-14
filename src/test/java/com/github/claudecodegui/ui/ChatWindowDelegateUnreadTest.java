package com.github.claudecodegui.ui;

import com.intellij.openapi.util.Key;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.ui.content.Content;
import com.intellij.util.SVGLoader;
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
        /** Like the platform tab label, setIcon repaints and reads SHOW_CONTENT_ICON only then. */
        final AtomicReference<Icon> painted = new AtomicReference<>();
        final AtomicReference<String> name = new AtomicReference<>("AI test");
        final Map<Key<?>, Object> data = new HashMap<>();
        final Content content = (Content) Proxy.newProxyInstance(Content.class.getClassLoader(),
                new Class<?>[]{Content.class}, (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "getIcon": return icon.get();
                        case "setIcon":
                            icon.set((Icon) args[0]);
                            painted.set(Boolean.TRUE.equals(data.get(ToolWindow.SHOW_CONTENT_ICON))
                                    ? (Icon) args[0] : null);
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
    public void backgroundRepliesSetOnePersistentBadgeWithoutPerTokenUpdates() {
        Fixture f = new Fixture();
        for (int i = 0; i < 100; i++) f.delegate.onAssistantActivity();
        assertEquals(1, f.queue.size());
        f.drain();
        assertTrue(f.delegate.hasUnread());
        assertNotNull(f.tab.get().icon.get());
        assertEquals(Boolean.TRUE, f.tab.get().data.get(ToolWindow.SHOW_CONTENT_ICON));
        for (int i = 0; i < 100; i++) f.delegate.onAssistantActivity();
        assertTrue(f.queue.isEmpty());
        assertEquals(1, f.saves.get());
    }

    @Test
    public void badgeIsPaintedWhenSetAndTheHiddenIconStaysHiddenWhenCleared() {
        Fixture f = new Fixture();
        f.tab.get().icon.set(new ImageIcon(new BufferedImage(16, 16, BufferedImage.TYPE_INT_ARGB)));
        f.delegate.onAssistantActivity(); f.drain();
        assertNotNull(f.tab.get().painted.get());
        f.selected.set(true);
        f.delegate.markTabReadIfVisible(); f.drain();
        assertNull(f.tab.get().painted.get());
    }

    @Test
    public void visibleRepliesStayReadAndPreserveExistingIcons() {
        Fixture f = new Fixture();
        Icon original = new ImageIcon(new BufferedImage(16, 16, BufferedImage.TYPE_INT_ARGB));
        f.tab.get().icon.set(original);
        f.selected.set(true);
        f.delegate.onAssistantActivity(); f.drain();
        assertFalse(f.delegate.hasUnread());
        assertSame(original, f.tab.get().icon.get());
        assertEquals(0, f.saves.get());
    }

    @Test
    public void onlyAVisibleReadySelectionClearsTheBadgeAndRestoresTheIcon() {
        Fixture f = new Fixture();
        Icon original = new ImageIcon(new BufferedImage(16, 16, BufferedImage.TYPE_INT_ARGB));
        f.tab.get().icon.set(original);
        f.delegate.onAssistantActivity(); f.drain();
        f.selected.set(true); f.showing.set(false);
        f.delegate.markTabReadIfVisible(); f.drain();
        assertTrue(f.delegate.hasUnread());
        f.showing.set(true); f.ready.set(false);
        f.delegate.markTabReadIfVisible(); f.drain();
        assertTrue(f.delegate.hasUnread());
        f.ready.set(true);
        f.delegate.markTabReadIfVisible(); f.drain();
        assertFalse(f.delegate.hasUnread());
        assertSame(original, f.tab.get().icon.get());
        assertNull(f.tab.get().data.get(ToolWindow.SHOW_CONTENT_ICON));
        assertEquals(2, f.saves.get());
    }

    @Test
    public void queuedActivityResamplesSelectionAndIgnoresClosedTabs() {
        Fixture f = new Fixture();
        f.delegate.onAssistantActivity(); f.selected.set(true); f.drain();
        assertFalse(f.delegate.hasUnread());
        f.selected.set(false); f.delegate.onAssistantActivity(); f.disposed.set(true); f.drain();
        assertFalse(f.delegate.hasUnread());
        assertEquals(0, f.saves.get());
    }

    @Test
    public void restoringUnreadDoesNotGenerateANewMessageOrClearItUntilRead() {
        Fixture f = new Fixture();
        f.delegate.restoreUnread(true); f.drain();
        assertTrue(f.delegate.hasUnread());
        assertEquals(0, f.saves.get());
        assertNotNull(f.tab.get().icon.get());
        f.selected.set(true); f.delegate.markTabReadIfVisible(); f.drain();
        assertFalse(f.delegate.hasUnread());
        assertEquals(1, f.saves.get());
    }

    @Test
    public void reattachingTransfersTheBadgeAndReleasesTheOldContent() {
        Fixture f = new Fixture();
        f.delegate.onAssistantActivity(); f.drain();
        Tab original = f.tab.get(); f.tab.set(new Tab());
        f.delegate.refreshTabIndicator(); f.drain();
        assertNull(original.icon.get());
        assertNotNull(f.tab.get().icon.get());
        assertTrue(f.delegate.hasUnread());
    }

    @Test
    public void answeringOutranksUnreadAndIdleRestoresTheCompletedDot() {
        Fixture f = new Fixture();
        f.delegate.onAssistantActivity(); f.drain();
        Icon unreadIcon = f.tab.get().icon.get();
        f.delegate.updateTabStatus(ChatWindowDelegate.TabAnswerStatus.ANSWERING); f.drain();
        assertNotSame(unreadIcon, f.tab.get().icon.get());
        f.delegate.updateTabStatus(ChatWindowDelegate.TabAnswerStatus.IDLE); f.drain();
        assertSame(unreadIcon, f.tab.get().icon.get());
        assertTrue(f.delegate.hasUnread());
        assertEquals("AI test", f.tab.get().name.get());
    }

    @Test
    public void statusPrecedenceIsAnsweringThenFailedThenCompleted() {
        assertSame(ChatWindowDelegate.TabIndicator.ANSWERING,
                ChatWindowDelegate.resolveTabIndicator(ChatWindowDelegate.TabAnswerStatus.ANSWERING, true, true));
        assertSame(ChatWindowDelegate.TabIndicator.ERROR,
                ChatWindowDelegate.resolveTabIndicator(ChatWindowDelegate.TabAnswerStatus.IDLE, false, true));
        assertSame(ChatWindowDelegate.TabIndicator.ERROR,
                ChatWindowDelegate.resolveTabIndicator(ChatWindowDelegate.TabAnswerStatus.ERROR, true, false));
        // A completion echo arriving after a failure must not repaint the turn green.
        assertSame(ChatWindowDelegate.TabIndicator.ERROR,
                ChatWindowDelegate.resolveTabIndicator(ChatWindowDelegate.TabAnswerStatus.COMPLETED, false, true));
        assertSame(ChatWindowDelegate.TabIndicator.COMPLETED,
                ChatWindowDelegate.resolveTabIndicator(ChatWindowDelegate.TabAnswerStatus.IDLE, true, false));
        assertSame(ChatWindowDelegate.TabIndicator.COMPLETED,
                ChatWindowDelegate.resolveTabIndicator(ChatWindowDelegate.TabAnswerStatus.COMPLETED, false, false));
        assertNull(ChatWindowDelegate.resolveTabIndicator(ChatWindowDelegate.TabAnswerStatus.IDLE, false, false));
    }

    @Test
    public void aFailedTurnStaysRedInABackgroundTabUntilTheTabIsRead() {
        Fixture f = new Fixture();
        f.showing.set(false);
        f.delegate.onTurnFailed(); f.drain();
        Icon red = f.tab.get().icon.get();
        assertNotNull(red);
        f.delegate.updateTabStatus(ChatWindowDelegate.TabAnswerStatus.COMPLETED); f.drain();
        assertSame(red, f.tab.get().icon.get());
        f.selected.set(true); f.showing.set(true);
        f.delegate.markTabReadIfVisible(); f.drain();
        assertNull(f.tab.get().icon.get());
    }

    @Test
    public void aNewTurnClearsTheFailureColor() {
        Fixture f = new Fixture();
        f.showing.set(false);
        f.delegate.onTurnFailed(); f.drain();
        Icon red = f.tab.get().icon.get();
        f.delegate.updateTabStatus(ChatWindowDelegate.TabAnswerStatus.ANSWERING); f.drain();
        assertNotSame(red, f.tab.get().icon.get());
        f.delegate.updateTabStatus(ChatWindowDelegate.TabAnswerStatus.IDLE); f.drain();
        assertNull(f.tab.get().icon.get());
    }

    @Test
    public void statusDotResourcesPaintBlueGreenAndRed() throws Exception {
        // A running turn is blue, a finished turn is green, a failed turn is red.
        assertDotColor("/icons/tab-status-streaming.svg", 0x2F80ED);
        assertDotColor("/icons/tab-status-completed.svg", 0x22C55E);
        assertDotColor("/icons/tab-status-error.svg", 0xEF4444);
    }

    private static void assertDotColor(String resource, int expectedRgb) throws Exception {
        // IconLoader stays inactive in a headless test JVM; use its SVG renderer directly.
        java.awt.Image rendered = SVGLoader.load(ChatWindowDelegate.class.getResource(resource), 1f);
        BufferedImage image = new BufferedImage(rendered.getWidth(null), rendered.getHeight(null), BufferedImage.TYPE_INT_ARGB);
        java.awt.Graphics2D graphics = image.createGraphics();
        try { graphics.drawImage(rendered, 0, 0, null); } finally { graphics.dispose(); }
        int pixel = image.getRGB(image.getWidth() / 2, image.getHeight() / 2);
        assertEquals(255, pixel >>> 24);
        for (int shift = 0; shift <= 16; shift += 8) {
            int expected = (expectedRgb >>> shift) & 0xFF;
            int actual = (pixel >>> shift) & 0xFF;
            assertTrue(resource + " channel " + shift + " was " + actual + ", expected " + expected,
                    Math.abs(expected - actual) <= 2);
        }
    }
}
