package com.github.claudecodegui.ui.toolwindow;

import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.ComponentManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.util.messages.MessageBusConnection;
import com.intellij.util.messages.Topic;
import kotlin.Unit;
import kotlin.jvm.functions.Function2;

import java.lang.reflect.Proxy;
import java.util.Collection;
import java.util.Collections;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;

/** Pins each remote client's launcher, including clients connected after project startup. */
final class RemoteToolWindowStripeSupport {
    private static final Logger LOG = Logger.getInstance(RemoteToolWindowStripeSupport.class);
    private final ToolWindowManager manager;
    private final ToolWindow window;
    private final ClassLoader loader;
    private final Class<?> sessionClass;
    private final Set<Object> boundSessions = Collections.newSetFromMap(new WeakHashMap<>());

    private RemoteToolWindowStripeSupport(ToolWindowManager manager, ToolWindow window) throws ClassNotFoundException {
        this.manager = manager;
        this.window = window;
        this.loader = manager.getClass().getClassLoader();
        this.sessionClass = loader.loadClass("com.intellij.openapi.client.ClientProjectSession");
    }

    // Remote APIs live in an optional IDE plugin; local and older IDEs must not link to them.
    static void install(ToolWindowManager manager, ToolWindow window) {
        if (!manager.getClass().getName().startsWith("com.jetbrains.rdserver.")
                || window.isDisposed() || window.getProject().isDisposed()) {
            return;
        }
        try {
            new RemoteToolWindowStripeSupport(manager, window).subscribe();
        } catch (ClassNotFoundException | NoSuchMethodException ignored) {
            LOG.debug("[ToolWindow] Remote stripe API is unavailable on this IDE build");
        } catch (ReflectiveOperationException | RuntimeException e) {
            LOG.warn("[ToolWindow] Could not initialize remote stripe synchronization", e);
        }
    }

    // Subscribe before enumerating sessions so opening or reconnecting a project cannot be missed.
    private void subscribe() throws ReflectiveOperationException {
        Class<?> listenerClass = loader.loadClass("com.jetbrains.rdserver.core.RemoteClientSessionListener");
        Object companion = listenerClass.getField("Companion").get(null);
        Topic<?> topic = (Topic<?>) companion.getClass().getMethod("getTOPIC").invoke(companion);
        Object listener = Proxy.newProxyInstance(loader, new Class<?>[]{listenerClass}, (proxy, method, args) -> {
            if (method.getDeclaringClass() == Object.class) {
                return switch (method.getName()) {
                    case "hashCode" -> System.identityHashCode(proxy);
                    case "equals" -> proxy == args[0];
                    default -> "CC GUI remote stripe listener";
                };
            }
            if (method.getName().equals("beforeProjectSessionInitialized")
                    || method.getName().equals("projectSessionInitialized")) {
                bindLater(args[1]);
            }
            return null;
        });
        MessageBusConnection connection = ApplicationManager.getApplication().getMessageBus().connect(window.getDisposable());
        subscribeListener(connection, topic, listener);

        Class<?> kindClass = loader.loadClass("com.intellij.openapi.client.ClientKind");
        Collection<?> sessions = (Collection<?>) loader.loadClass("com.intellij.openapi.client.ClientSessionsManager")
                .getMethod("getProjectSessions", Project.class, kindClass)
                .invoke(null, window.getProject(), kindClass.getField("REMOTE").get(null));
        for (Object session : sessions) {
            bindLater(session);
        }
    }

    private static <L> void subscribeListener(MessageBusConnection connection, Topic<L> topic, Object listener) {
        connection.subscribe(topic, topic.getListenerClass().cast(listener));
    }

    // Model registration can happen after the session event; view() covers existing and later entries.
    private void bindLater(Object session) {
        Runnable bind = () -> {
            if (window.isDisposed() || window.getProject().isDisposed() || ((ComponentManager) session).isDisposed()) {
                return;
            }
            try {
                if (sessionClass.getMethod("getProject").invoke(session) != window.getProject()) {
                    return;
                }
                if (!boundSessions.add(session)) {
                    return;
                }
                Object solution = loader.loadClass("com.jetbrains.rdserver.core.RemoteSessionKt")
                        .getMethod("getProtocolModel", sessionClass).invoke(null, session);
                Object model = loader.loadClass("com.jetbrains.rd.ide.model.ToolWindowModel_GeneratedKt")
                        .getMethod("getToolWindowModel", loader.loadClass("com.jetbrains.rd.ide.model.Solution"))
                        .invoke(null, solution);
                Object entries = model.getClass().getMethod("getAvailableToolWindows").invoke(model);

                // The registration ends on either client disconnect or plugin/tool-window disposal.
                Disposable registration = Disposer.newDisposable("CC GUI remote stripe");
                Disposer.register(window.getDisposable(), registration);
                Class<?> lifetimes = loader.loadClass("com.intellij.openapi.rd.LifetimeDisposableExKt");
                Class<?> lifetimeClass = loader.loadClass("com.jetbrains.rd.util.lifetime.Lifetime");
                Object sessionLifetime = lifetimes.getMethod("createLifetime", Disposable.class).invoke(null, session);
                lifetimes.getMethod("attachAsChildTo", Disposable.class, lifetimeClass).invoke(null, registration, sessionLifetime);
                Object lifetime = lifetimes.getMethod("createLifetime", Disposable.class).invoke(null, registration);
                Function2<Object, Map.Entry<?, ?>, Unit> onEntry = (entryLifetime, entry) -> {
                    pinEntry(entry);
                    return Unit.INSTANCE;
                };
                loader.loadClass("com.jetbrains.rd.util.reactive.IViewableMap")
                        .getMethod("view", lifetimeClass, Function2.class).invoke(entries, lifetime, onEntry);
            } catch (ReflectiveOperationException | RuntimeException e) {
                boundSessions.remove(session);
                LOG.warn("[ToolWindow] Could not bind the remote stripe model", e);
            }
        };
        // Install the observer before the IDE publishes the new session's window models.
        if (ApplicationManager.getApplication().isDispatchThread()) {
            bind.run();
        } else {
            manager.invokeLater(bind);
        }
    }

    // Initialize only a fresh model, before the IDE publishes its real availability.
    // Changing an existing model's availability hides/reparents its native JCEF views.
    static void pinEntry(Map.Entry<?, ?> entry) {
        if (!ClaudeSDKToolWindow.TOOL_WINDOW_ID.equals(entry.getKey())) {
            return;
        }
        try {
            Object model = entry.getValue();
            Object available = model.getClass().getMethod("getAvailable").invoke(model);
            if (available.getClass().getMethod("getValueOrNull").invoke(available) != null) {
                return;
            }
            Object toolWindow = model.getClass().getMethod("getToolWindow").invoke(model);
            Object state = toolWindow.getClass().getMethod("getState").invoke(toolWindow);
            if (state.getClass().getMethod("getValueOrNull").invoke(state) != null) {
                return;
            }
            Object largeStripe = model.getClass().getMethod("isVisibleOnLargeStripe").invoke(model);
            largeStripe.getClass().getMethod("set", Object.class).invoke(largeStripe, true);
            // The client must see the pinned flag before availability creates its stripe button.
            available.getClass().getMethod("set", Object.class).invoke(available, false);
        } catch (NoSuchMethodException ignored) {
            LOG.debug("[ToolWindow] Remote new UI stripe properties are unavailable on this IDE build");
        } catch (ReflectiveOperationException | RuntimeException e) {
            LOG.warn("[ToolWindow] Could not pin the remote launcher", e);
        }
    }
}
