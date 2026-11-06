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

    record ConfirmLookup(String className, String methodName) {
    }

    static final List<ConfirmLookup> CONFIRM_LOOKUPS = List.of(
            new ConfirmLookup("com.intellij.ide.trustedProjects.TrustedProjectsDialog", "confirmLoadingUntrustedProject"),
            new ConfirmLookup("com.intellij.ide.impl.TrustedProjects", "confirmLoadingUntrustedProject")
    );

    private static final Key<Boolean> UNTRUSTED_NOTICE_SHOWN = Key.create("ccgui.untrustedProjectNoticeShown");
    private static final Key<Boolean> OUTSIDE_CWD_NOTICE_SHOWN = Key.create("ccgui.outsideWorkingDirectoryNoticeShown");

    private ProjectTrust() {
    }

    public static boolean isTrusted(Project project) {
        return isTrusted(project, LOOKUPS);
    }

    public static boolean isTrustedForClaude(Project project, Consumer<Project> untrustedNotice) {
        return isTrustedForClaude(project, LOOKUPS, untrustedNotice);
    }

    /**
     * Whether Claude may load project settings for a request that runs in {@code cwd}.
     *
     * <p>The IDE asks about the project, but settings load from the working directory. A
     * working directory outside the project is a different repository the IDE never asked
     * about, so it is untrusted even when the project is trusted.
     */
    public static boolean isTrustedForClaude(Project project, String cwd, Consumer<Project> untrustedNotice,
                                             Consumer<Project> outsideWorkingDirectoryNotice) {
        return isTrustedForClaude(project, cwd, LOOKUPS, untrustedNotice, outsideWorkingDirectoryNotice);
    }

    static boolean isTrustedForClaude(Project project, String cwd, List<TrustLookup> lookups,
                                      Consumer<Project> untrustedNotice,
                                      Consumer<Project> outsideWorkingDirectoryNotice) {
        if (!isTrustedForClaude(project, lookups, untrustedNotice)) {
            return false;
        }
        if (PathUtils.isWorkingDirectoryInsideProject(cwd, project.getBasePath())) {
            return true;
        }
        if (outsideWorkingDirectoryNotice != null && project.getUserData(OUTSIDE_CWD_NOTICE_SHOWN) == null) {
            project.putUserData(OUTSIDE_CWD_NOTICE_SHOWN, Boolean.TRUE);
            outsideWorkingDirectoryNotice.accept(project);
        }
        return false;
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

    /** Whether this IDE offers the dialog that asks the user to trust the project. */
    public static boolean canRequestTrust() {
        return resolveConfirmation(CONFIRM_LOOKUPS) != null;
    }

    /**
     * Asks the user, with the IDE's own trust dialog, to trust the project. The dialog stores the
     * answer itself. Call on the EDT. Returns false when the user declined or the dialog is
     * unavailable.
     */
    public static boolean requestTrust(Project project, String title, String message, String trustButton, String distrustButton) {
        return requestTrust(project, CONFIRM_LOOKUPS, title, message, trustButton, distrustButton);
    }

    static boolean requestTrust(Project project, List<ConfirmLookup> lookups, String title, String message,
                                String trustButton, String distrustButton) {
        if (project == null) {
            return false;
        }
        Confirmation confirmation = resolveConfirmation(lookups);
        if (confirmation == null) {
            LOG.warn("[ProjectTrust] No trust dialog found; the project stays untrusted");
            return false;
        }
        try {
            return Boolean.TRUE.equals(confirmation.method().invoke(confirmation.receiver(), project, title, message, trustButton, distrustButton));
        } catch (ReflectiveOperationException | RuntimeException error) {
            LOG.warn("[ProjectTrust] Trust dialog failed; the project stays untrusted: " + error);
            return false;
        }
    }

    record Confirmation(Method method, Object receiver) {
    }

    static Confirmation resolveConfirmation(List<ConfirmLookup> lookups) {
        for (ConfirmLookup lookup : lookups) {
            try {
                Class<?> type = Class.forName(lookup.className());
                Method method = type.getMethod(lookup.methodName(), Project.class, String.class, String.class, String.class, String.class);
                if (method.getReturnType() != boolean.class && method.getReturnType() != Boolean.class) {
                    continue;
                }
                if (Modifier.isStatic(method.getModifiers())) {
                    return new Confirmation(method, null);
                }
                Object instance = type.getField("INSTANCE").get(null);
                if (instance != null) {
                    return new Confirmation(method, instance);
                }
            } catch (ReflectiveOperationException | LinkageError | RuntimeException ignored) {
            }
        }
        return null;
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
