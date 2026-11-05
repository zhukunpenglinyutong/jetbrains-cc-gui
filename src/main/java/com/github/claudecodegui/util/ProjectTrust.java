package com.github.claudecodegui.util;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Key;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.List;
import java.util.function.Consumer;

public final class ProjectTrust {

    private static final Logger LOG = Logger.getInstance(ProjectTrust.class);

    record TrustLookup(String className, String methodName) {
    }

    static final List<TrustLookup> LOOKUPS = List.of(
            new TrustLookup("com.intellij.ide.trustedProjects.TrustedProjects", "isProjectTrusted"),
            new TrustLookup("com.intellij.ide.impl.TrustedProjects", "isTrusted")
    );

    private static final Key<Boolean> UNTRUSTED_NOTICE_SHOWN = Key.create("ccgui.untrustedProjectNoticeShown");

    private ProjectTrust() {
    }

    public static boolean isTrusted(Project project) {
        return isTrusted(project, LOOKUPS);
    }

    public static boolean isTrustedForClaude(Project project, Consumer<Project> untrustedNotice) {
        return isTrustedForClaude(project, LOOKUPS, untrustedNotice);
    }

    static boolean isTrustedForClaude(Project project, List<TrustLookup> lookups, Consumer<Project> untrustedNotice) {
        boolean trusted = isTrusted(project, lookups);
        if (!trusted && project != null && untrustedNotice != null && project.getUserData(UNTRUSTED_NOTICE_SHOWN) == null) {
            project.putUserData(UNTRUSTED_NOTICE_SHOWN, Boolean.TRUE);
            untrustedNotice.accept(project);
        }
        return trusted;
    }

    static boolean isTrusted(Project project, List<TrustLookup> lookups) {
        if (project == null) {
            return false;
        }
        Method method = resolveTrustMethod(lookups);
        if (method == null) {
            LOG.warn("[ProjectTrust] No project trust API found; treating the project as untrusted");
            return false;
        }
        try {
            return Boolean.TRUE.equals(method.invoke(null, project));
        } catch (ReflectiveOperationException | RuntimeException error) {
            LOG.warn("[ProjectTrust] Project trust check failed; treating the project as untrusted: " + error);
            return false;
        }
    }

    static Method resolveTrustMethod(List<TrustLookup> lookups) {
        for (TrustLookup lookup : lookups) {
            try {
                Method method = Class.forName(lookup.className()).getMethod(lookup.methodName(), Project.class);
                if (Modifier.isStatic(method.getModifiers())
                        && (method.getReturnType() == boolean.class || method.getReturnType() == Boolean.class)) {
                    return method;
                }
            } catch (ClassNotFoundException | NoSuchMethodException | LinkageError ignored) {
            }
        }
        return null;
    }
}
