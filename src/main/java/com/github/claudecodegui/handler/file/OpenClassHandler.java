package com.github.claudecodegui.handler.file;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * Handles Java fully-qualified class navigation requests.
 */
public class OpenClassHandler {

    private static final Logger LOG = Logger.getInstance(OpenClassHandler.class);
    // Accepts dotted Java identifiers; requires at least one '.', allows '$' for
    // inner classes, and rejects whitespace, '#', and '(' via the showError guards
    // in isValidClassName().
    private static final Pattern JAVA_FQCN_PATTERN = Pattern.compile(
        "^[a-zA-Z_$][\\w$]*(?:\\.[a-zA-Z_$][\\w$]*)+$"
    );
    private static final Method NAVIGATE_METHOD = loadNavigateMethod();

    @FunctionalInterface
    interface NavigationInvoker {
        boolean navigate(Project project, String fqcn, Consumer<String> onFailure) throws Exception;
    }

    private final HandlerContext context;
    private final NavigationInvoker navigationInvoker;
    private final boolean classNavigationEnabled;

    OpenClassHandler(HandlerContext context) {
        this(context, createNavigationInvoker(), isClassNavigationEnabled());
    }

    OpenClassHandler(HandlerContext context, NavigationInvoker navigationInvoker) {
        this(context, navigationInvoker, true);
    }

    OpenClassHandler(HandlerContext context, NavigationInvoker navigationInvoker, boolean classNavigationEnabled) {
        this.context = context;
        this.navigationInvoker = navigationInvoker;
        this.classNavigationEnabled = classNavigationEnabled;
    }

    public static boolean isClassNavigationEnabled() {
        return NAVIGATE_METHOD != null;
    }

    public static String buildCapabilitiesJson() {
        JsonObject payload = new JsonObject();
        payload.addProperty("classNavigationEnabled", isClassNavigationEnabled());
        return payload.toString();
    }

    static boolean isValidClassName(String fqcn) {
        if (fqcn == null) {
            return false;
        }

        String trimmed = fqcn.trim();
        if (trimmed.isEmpty()) {
            return false;
        }

        return JAVA_FQCN_PATTERN.matcher(trimmed).matches()
            && !trimmed.contains("#")
            && !trimmed.contains("(");
    }

    void handleOpenClass(String fqcn) {
        String trimmed = fqcn == null ? "" : fqcn.trim();
        LOG.debug("Open class request: " + trimmed);

        if (!isValidClassName(trimmed)) {
            showError("Cannot open class: invalid class name (" + trimmed + ")");
            return;
        }

        Project project = context.getProject();
        if (project == null || project.isDisposed()) {
            showError("Cannot open class: project is not available");
            return;
        }

        if (!classNavigationEnabled) {
            showError("Cannot open class: Java navigation is not available in this IDE");
            return;
        }

        CompletableFuture.runAsync(() -> executeNavigation(project, trimmed), AppExecutorUtil.getAppExecutorService());
    }

    void executeNavigation(Project project, String fqcn) {
        try {
            boolean accepted = navigationInvoker.navigate(project, fqcn, this::showError);
            if (!accepted) {
                LOG.warn("Class navigation request was not accepted: " + fqcn);
                showError("Cannot open class: " + fqcn);
            }
        } catch (IllegalAccessException e) {
            LOG.warn("Failed to open class (reflection access denied): " + fqcn + ", error=" + e.getMessage(), e);
            showError("Cannot open class: " + fqcn);
        } catch (InvocationTargetException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            LOG.warn("Failed to open class (PSI navigation error): " + fqcn + ", error=" + cause.getMessage(), cause);
            showError("Cannot open class: " + fqcn);
        } catch (Exception e) {
            LOG.warn("Failed to open class: " + fqcn + ", error=" + e.getMessage(), e);
            showError("Cannot open class: " + fqcn);
        }
    }

    private void showError(String message) {
        if (context.getBrowser() == null
            || ApplicationManager.getApplication() == null
            || ApplicationManager.getApplication().isUnitTestMode()) {
            context.callJavaScript("addErrorMessage", context.escapeJs(message));
            return;
        }

        ApplicationManager.getApplication().invokeLater(() -> {
            context.callJavaScript("addErrorMessage", context.escapeJs(message));
        }, ModalityState.nonModal());
    }

    private static NavigationInvoker createNavigationInvoker() {
        if (NAVIGATE_METHOD == null) {
            return (project, fqcn, onFailure) -> false;
        }

        return (project, fqcn, onFailure) -> Boolean.TRUE.equals(
            NAVIGATE_METHOD.invoke(null, project, fqcn, onFailure)
        );
    }

    private static Method loadNavigateMethod() {
        try {
            Class.forName("com.intellij.psi.PsiJavaFile");
            Class<?> navigationSupportClass = Class.forName(
                "com.github.claudecodegui.handler.file.JavaClassNavigationSupport"
            );
            return navigationSupportClass.getMethod("navigate", Project.class, String.class, Consumer.class);
        } catch (ClassNotFoundException e) {
            LOG.info("Java class navigation is unavailable in this IDE");
        } catch (Exception e) {
            LOG.warn("Failed to initialize Java class navigation support: " + e.getMessage(), e);
        }
        return null;
    }
}
