package com.github.claudecodegui.action.vcs;

import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.actionSystem.ActionGroup;
import com.intellij.openapi.actionSystem.ActionManager;
import com.intellij.openapi.actionSystem.ActionPopupMenu;
import com.intellij.openapi.actionSystem.ActionToolbar;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.actionSystem.KeyboardShortcut;
import com.intellij.openapi.actionSystem.Presentation;
import com.intellij.openapi.actionSystem.TimerListener;
import com.intellij.openapi.actionSystem.ex.AnActionListener;
import com.intellij.openapi.project.Project;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.io.InputStream;
import java.awt.Component;
import java.awt.event.InputEvent;
import java.lang.reflect.Field;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Verifies that commit-action presentation updates respect feature enablement
 * without resolving a chat window or entering its provider prewarm lifecycle.
 */
public class GenerateCommitMessageActionTest {
    @Rule
    public final TemporaryFolder temporaryHome = new TemporaryFolder();

    private Field cachedHome;
    private Object originalHome;

    /** Redirects settings reads to an isolated home without touching user configuration. */
    @Before
    public void setUp() throws Exception {
        cachedHome = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        cachedHome.setAccessible(true);
        originalHome = cachedHome.get(null);
        cachedHome.set(null, temporaryHome.getRoot().getAbsolutePath());
    }

    /** Restores the shared home-directory cache after each isolated action update. */
    @After
    public void tearDown() throws Exception {
        cachedHome.set(null, originalHome);
    }

    /** Codex-only configuration must remain enabled without resolving Claude's chat host. */
    @Test
    public void codexPresentationUpdatesDoNotResolveAChatWindow() throws Exception {
        writeConfiguration(true);
        RuntimeGuardClassLoader loader = new RuntimeGuardClassLoader();
        AnAction action = loader.createAction();
        AnActionEvent event = createEvent(createProject());

        action.update(event);
        action.update(event);

        assertTrue(event.getPresentation().isEnabled());
        assertTrue(event.getPresentation().isVisible());
        assertEquals("Presentation updates must not enter provider prewarm", 0, loader.chatWindowLookups);
    }

    /** Disabling commit generation must hide the action without speculative provider startup. */
    @Test
    public void disabledGenerationDoesNotResolveAChatWindow() throws Exception {
        writeConfiguration(false);
        RuntimeGuardClassLoader loader = new RuntimeGuardClassLoader();
        AnAction action = loader.createAction();
        AnActionEvent event = createEvent(createProject());

        action.update(event);

        assertFalse(event.getPresentation().isEnabled());
        assertFalse(event.getPresentation().isVisible());
        assertEquals("Disabled actions must not enter provider prewarm", 0, loader.chatWindowLookups);
    }

    /** A project-less action update must remain hidden without consulting a runtime host. */
    @Test
    public void missingProjectKeepsTheActionHidden() throws Exception {
        RuntimeGuardClassLoader loader = new RuntimeGuardClassLoader();
        AnAction action = loader.createAction();
        AnActionEvent event = createEvent(null);

        action.update(event);

        assertFalse(event.getPresentation().isEnabled());
        assertFalse(event.getPresentation().isVisible());
        assertEquals(0, loader.chatWindowLookups);
    }

    /** Writes the reported Codex-only setup, with no configured Claude provider. */
    private void writeConfiguration(boolean enabled) throws IOException {
        Path directory = temporaryHome.getRoot().toPath().resolve(".codemoss");
        Files.createDirectories(directory);
        Files.writeString(directory.resolve("config.json"),
                "{\"commitGenerationEnabled\":" + enabled
                        + ",\"commitAi\":{\"provider\":\"codex\"},\"claude\":{\"providers\":{}}}");
    }

    /** Builds a presentation event with an inert action manager and no IDE application. */
    @SuppressWarnings("removal")
    private static AnActionEvent createEvent(Project project) {
        return new AnActionEvent(null,
                dataId -> CommonDataKeys.PROJECT.getName().equals(dataId) ? project : null,
                "Vcs.MessageActionGroup", new Presentation(), new PresentationActionManager(), 0);
    }

    /** Supplies only project presence; these tests must not require a real project or IDE UI. */
    private static Project createProject() {
        return (Project) Proxy.newProxyInstance(Project.class.getClassLoader(), new Class<?>[]{Project.class},
                (proxy, method, args) -> switch (method.getName()) {
                    case "hashCode" -> System.identityHashCode(proxy);
                    case "equals" -> proxy == args[0];
                    case "isDisposed", "isDefault", "isOpen" -> false;
                    case "getName" -> "commit-presentation-test";
                    default -> null;
                });
    }

    /**
     * Runs the real action while vetoing chat-window resolution. The veto records
     * the old prewarm path even though that path catches and suppresses failures.
     */
    private static final class RuntimeGuardClassLoader extends ClassLoader {
        private static final String ACTION_CLASS = GenerateCommitMessageAction.class.getName();
        private int chatWindowLookups;

        /** Shares platform/settings types while isolating the action's static prewarm state. */
        private RuntimeGuardClassLoader() {
            super(GenerateCommitMessageAction.class.getClassLoader());
        }

        /** Instantiates the production action in this guarded loader. */
        private AnAction createAction() throws ReflectiveOperationException {
            return (AnAction) loadClass(ACTION_CLASS).getConstructor().newInstance();
        }

        /** Prevents a regression from reaching real chat windows, native UI, or CLI processes. */
        @Override
        protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
            if ("com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow".equals(name)) {
                chatWindowLookups++;
                throw new ClassNotFoundException("Presentation updates must not resolve a chat window");
            }
            if (!ACTION_CLASS.equals(name)) {
                return super.loadClass(name, resolve);
            }
            synchronized (getClassLoadingLock(name)) {
                Class<?> loaded = findLoadedClass(name);
                if (loaded == null) {
                    String resource = name.replace('.', '/') + ".class";
                    try (InputStream stream = getParent().getResourceAsStream(resource)) {
                        if (stream == null) {
                            throw new ClassNotFoundException(name);
                        }
                        byte[] bytes = stream.readAllBytes();
                        loaded = defineClass(name, bytes, 0, bytes.length);
                    } catch (IOException error) {
                        throw new ClassNotFoundException(name, error);
                    }
                }
                if (resolve) {
                    resolveClass(loaded);
                }
                return loaded;
            }
        }
    }

    /** Supplies the event's required manager without IDE services or registered actions. */
    @SuppressWarnings("removal")
    private static final class PresentationActionManager extends ActionManager {
        /** No popup is needed for a presentation update. */
        @Override
        public ActionPopupMenu createActionPopupMenu(String place, ActionGroup group) { return null; }

        /** No toolbar is constructed by this fixture. */
        @Override
        public ActionToolbar createActionToolbar(String place, ActionGroup group, boolean horizontal) { return null; }

        /** No actions are registered in the fixture. */
        @Override
        public AnAction getAction(String id) { return null; }

        /** No action identifiers are required by the event. */
        @Override
        public String getId(AnAction action) { return null; }

        /** Ignores registration because presentation updates do not dispatch actions. */
        @Override
        public void registerAction(String id, AnAction action) { }

        /** Ignores plugin-scoped registration for the same isolated event. */
        @Override
        public void registerAction(String id, AnAction action, com.intellij.openapi.extensions.PluginId pluginId) { }

        /** No registered action needs removal. */
        @Override
        public void unregisterAction(String id) { }

        /** No registered action needs replacement. */
        @Override
        public void replaceAction(String id, AnAction action) { }

        /** Exposes an empty registry to legacy callers. */
        @Override
        public String[] getActionIds(String prefix) { return new String[0]; }

        /** Exposes an empty registry to current callers. */
        @Override
        public java.util.List<String> getActionIdList(String prefix) { return Collections.emptyList(); }

        /** The fixture does not contain action groups. */
        @Override
        public boolean isGroup(String id) { return false; }

        /** The fixture does not contain lazily registered actions either. */
        @Override
        public AnAction getActionOrStub(String id) { return null; }

        /** Keeps presentation tests free of action-system timers. */
        @Override
        public void addTimerListener(TimerListener listener) { }

        /** No action-system timer has been registered. */
        @Override
        public void removeTimerListener(TimerListener listener) { }

        /** No listener is needed when only update is invoked. */
        @Override
        public void addAnActionListener(AnActionListener listener) { }

        /** No disposable-scoped listener is needed either. */
        @Override
        public void addAnActionListener(AnActionListener listener, com.intellij.openapi.Disposable parent) { }

        /** Prevents the event fixture from dispatching real actions. */
        @Override
        public com.intellij.openapi.util.ActionCallback tryToExecute(AnAction action, InputEvent input,
                Component component, String place, boolean now) {
            return com.intellij.openapi.util.ActionCallback.DONE;
        }

        /** No shortcut lookup is needed for this action presentation. */
        @Override
        public KeyboardShortcut getKeyboardShortcut(String id) { return null; }
    }
}
