package com.github.claudecodegui.ui.toolwindow;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.popup.Balloon;
import com.intellij.openapi.wm.IdeFocusManager;
import com.intellij.openapi.wm.RegisterToolWindowTask;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowAnchor;
import com.intellij.openapi.wm.ToolWindowBalloonShowOptions;
import com.intellij.openapi.wm.ToolWindowManager;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import static org.junit.Assert.*;

public class ToolWindowStripeSupportTest {
    private static final class Fixture {
        LegacyManager manager;
        ToolWindowAnchor anchor = ToolWindowAnchor.LEFT;
        boolean stripe;
        boolean ignoreClassicSetter;
        boolean disposed;
        boolean projectDisposed;
        int anchorChanges;
        int stripeChanges;
        final Project project = (Project) Proxy.newProxyInstance(Project.class.getClassLoader(),
                new Class<?>[]{Project.class}, (proxy, method, args) -> {
                    if (method.getName().equals("isDisposed")) return projectDisposed;
                    if (method.getName().equals("getService")) return manager;
                    throw new AssertionError("Unexpected project operation: " + method.getName());
                });
        final ToolWindow window = (ToolWindow) Proxy.newProxyInstance(ToolWindow.class.getClassLoader(),
                new Class<?>[]{ToolWindow.class}, (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "getProject": return project;
                        case "getId": return "CCG";
                        case "getAnchor": return anchor;
                        case "setAnchor": anchor = (ToolWindowAnchor) args[0]; anchorChanges++; return null;
                        case "isDisposed": return disposed;
                        case "isShowStripeButton": return stripe;
                        case "setShowStripeButton":
                            stripeChanges++;
                            if (!ignoreClassicSetter) stripe = (boolean) args[0];
                            return null;
                        case "setTitle": case "setStripeTitle": return null;
                        // Activating/hiding the panel or touching content would steal focus or start JCEF.
                        default: throw new AssertionError("Unexpected tool window operation: " + method.getName());
                    }
                });

        Fixture(boolean newUI) {
            manager = newUI ? new NewUIManager() : new LegacyManager();
            if (manager instanceof NewUIManager) ((NewUIManager) manager).fixture = this;
        }

        void restore() { ToolWindowStripeSupport.pinToRight(manager, window); }
    }

    /** No new UI method, matching the optional API fallback on older platform builds. */
    public static class LegacyManager extends ToolWindowManager {
        final List<Runnable> queued = new ArrayList<>();
        @Override public void invokeLater(Runnable runnable) { queued.add(runnable); }
        @Override public IdeFocusManager getFocusManager() { throw new AssertionError(); }
        @Override public boolean canShowNotification(String id) { throw new AssertionError(); }
        @Override public ToolWindow registerToolWindow(RegisterToolWindowTask task) { throw new AssertionError(); }
        @Override public void unregisterToolWindow(String id) { throw new AssertionError(); }
        @Override public void activateEditorComponent() { throw new AssertionError(); }
        @Override public boolean isEditorComponentActive() { throw new AssertionError(); }
        @Override public String[] getToolWindowIds() { throw new AssertionError(); }
        @Override public Set<String> getToolWindowIdSet() { throw new AssertionError(); }
        @Override public String getActiveToolWindowId() { throw new AssertionError(); }
        @Override public String getLastActiveToolWindowId() { throw new AssertionError(); }
        @Override public ToolWindow getToolWindow(String id) { throw new AssertionError(); }
        @Override public void notifyByBalloon(ToolWindowBalloonShowOptions options) { throw new AssertionError(); }
        @Override public Balloon getToolWindowBalloon(String id) { throw new AssertionError(); }
        @Override public boolean isMaximized(ToolWindow window) { throw new AssertionError(); }
        @Override public void setMaximized(ToolWindow window, boolean maximized) { throw new AssertionError(); }
    }

    public static final class NewUIManager extends LegacyManager {
        Fixture fixture;
        int updates;
        public void setVisibleOnLargeStripe(String id, boolean visible) {
            assertEquals("CCG", id);
            assertTrue(visible);
            fixture.stripe = visible;
            updates++;
        }
    }

    @Test
    public void factoryPinsSavedLayoutBeforeRegistrationButDefersAnchorChanges() {
        Fixture f = new Fixture(false);
        new ClaudeSDKToolWindow().init(f.window);
        assertTrue(f.stripe);
        assertEquals(ToolWindowAnchor.LEFT, f.anchor);
        assertEquals(1, f.manager.queued.size());
        f.manager.queued.get(0).run();
        assertEquals(ToolWindowAnchor.RIGHT, f.anchor);
        assertEquals(1, f.anchorChanges);
    }

    @Test
    public void classicUIRestoresHiddenSavedLauncherWithoutOpeningContent() {
        Fixture f = new Fixture(false);
        f.restore();
        assertTrue(f.stripe);
        assertEquals(ToolWindowAnchor.RIGHT, f.anchor);
        assertEquals(1, f.stripeChanges);
    }

    @Test
    public void newUIRestoresLauncherEvenWhenPublicSetterDoesNothing() {
        Fixture f = new Fixture(true);
        f.ignoreClassicSetter = true;
        f.restore();
        assertTrue(f.stripe);
        assertEquals(ToolWindowAnchor.RIGHT, f.anchor);
        assertEquals(1, ((NewUIManager) f.manager).updates);
    }

    @Test
    public void alreadyPinnedBackendDoesNotRepublishTheClientLayout() {
        Fixture f = new Fixture(true);
        f.anchor = ToolWindowAnchor.RIGHT;
        f.stripe = true;
        f.restore();
        assertEquals(0, f.anchorChanges);
        assertEquals(0, f.stripeChanges);
        assertEquals(0, ((NewUIManager) f.manager).updates);
    }

    @Test
    public void alreadyPinnedClassicUIRequiresNoLayoutChanges() {
        Fixture f = new Fixture(false);
        f.anchor = ToolWindowAnchor.RIGHT;
        f.stripe = true;
        f.restore();
        assertEquals(0, f.anchorChanges);
        assertEquals(0, f.stripeChanges);
    }

    @Test
    public void queuedPinIsCancelledWhenWindowOrProjectCloses() {
        for (boolean closeProject : new boolean[]{false, true}) {
            Fixture f = new Fixture(true);
            new ClaudeSDKToolWindow().init(f.window);
            f.projectDisposed = closeProject;
            f.disposed = !closeProject;
            f.manager.queued.get(0).run();
            assertEquals(ToolWindowAnchor.LEFT, f.anchor);
            assertEquals(0, ((NewUIManager) f.manager).updates);
        }
    }
}
