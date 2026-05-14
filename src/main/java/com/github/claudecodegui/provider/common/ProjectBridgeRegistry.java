package com.github.claudecodegui.provider.common;

import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.intellij.openapi.project.Project;

import java.util.Map;
import java.util.WeakHashMap;

/**
 * Provides project-scoped shared SDK bridge instances so each tab does not
 * create and own an independent daemon/process tree.
 */
public final class ProjectBridgeRegistry {

    private static final Object LOCK = new Object();
    private static final Map<Project, SharedBridges> REGISTRY = new WeakHashMap<>();

    private ProjectBridgeRegistry() {
    }

    public static SharedBridges get(Project project) {
        synchronized (LOCK) {
            SharedBridges existing = REGISTRY.get(project);
            if (existing != null) {
                return existing;
            }
            SharedBridges created = new SharedBridges(new ClaudeSDKBridge(), new CodexSDKBridge());
            REGISTRY.put(project, created);
            return created;
        }
    }

    public static void remove(Project project) {
        synchronized (LOCK) {
            REGISTRY.remove(project);
        }
    }

    public static final class SharedBridges {
        private final ClaudeSDKBridge claudeBridge;
        private final CodexSDKBridge codexBridge;

        private SharedBridges(ClaudeSDKBridge claudeBridge, CodexSDKBridge codexBridge) {
            this.claudeBridge = claudeBridge;
            this.codexBridge = codexBridge;
        }

        public ClaudeSDKBridge getClaudeBridge() {
            return claudeBridge;
        }

        public CodexSDKBridge getCodexBridge() {
            return codexBridge;
        }
    }
}
