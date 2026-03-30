package com.github.claudecodegui.ui.toolwindow;

import com.intellij.openapi.Disposable;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;

import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Project-scoped disposable holder for tool window listeners.
 */
@Service(Service.Level.PROJECT)
public final class ToolWindowLifecycleDisposableService implements Disposable {

    private final AtomicBoolean projectCloseListenerRegistered = new AtomicBoolean(false);

    public ToolWindowLifecycleDisposableService(@NotNull Project project) {
        Objects.requireNonNull(project, "project");
    }

    /**
     * Get the project-scoped disposable service instance.
     */
    public static ToolWindowLifecycleDisposableService getInstance(@NotNull Project project) {
        return project.getService(ToolWindowLifecycleDisposableService.class);
    }

    /**
     * Mark the project-closing listener as registered.
     *
     * @return true when the caller should perform registration.
     */
    public boolean markProjectCloseListenerRegistered() {
        return this.projectCloseListenerRegistered.compareAndSet(false, true);
    }

    @Override
    public void dispose() {
        // No-op. This service provides a project-scoped disposable parent.
    }
}
