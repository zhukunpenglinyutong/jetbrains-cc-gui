package com.github.claudecodegui.provider.common;

import com.intellij.openapi.project.Project;

import java.util.Map;
import java.util.WeakHashMap;

/**
 * Tracks how many UI windows still reference the shared bridges for a project.
 * The last disposer performs actual bridge shutdown.
 */
public final class SharedBridgeReferenceCounter {

    private static final Object LOCK = new Object();
    private static final Map<Project, Integer> COUNTS = new WeakHashMap<>();

    private SharedBridgeReferenceCounter() {
    }

    public static void retain(Project project) {
        synchronized (LOCK) {
            COUNTS.put(project, COUNTS.getOrDefault(project, 0) + 1);
        }
    }

    public static boolean release(Project project) {
        synchronized (LOCK) {
            Integer count = COUNTS.get(project);
            if (count == null || count <= 1) {
                COUNTS.remove(project);
                return true;
            }
            COUNTS.put(project, count - 1);
            return false;
        }
    }
}
