package com.github.claudecodegui.util;

/**
 * Checks whether the JCEF classes required to construct the chat window can be loaded.
 * The probe names those classes and does not initialize them, so a missing Web Browser
 * (JCEF) plugin cannot run static initializers or throw before the tool window shows
 * installation guidance.
 */
public final class JcefClassAvailability {

    static final String JB_CEF_BROWSER = "com.intellij.ui.jcef.JBCefBrowser";
    static final String JB_CEF_OSR_HANDLER_FACTORY = "com.intellij.ui.jcef.JBCefOSRHandlerFactory";

    private JcefClassAvailability() {
    }

    /**
     * Returns whether both required JCEF classes can be loaded from {@code classLoader}.
     * A missing class or a linkage error is treated as unavailable. Passing the
     * tool-window factory's loader probes the plugin classpath rather than the
     * optional JCEF module marker.
     *
     * @param classLoader class loader that should see the JCEF classes, typically the plugin loader
     * @return true when both classes can be loaded without initialization
     */
    public static boolean isAvailable(ClassLoader classLoader) {
        if (classLoader == null) {
            return false;
        }
        return canLoad(classLoader, JB_CEF_BROWSER)
                && canLoad(classLoader, JB_CEF_OSR_HANDLER_FACTORY);
    }

    private static boolean canLoad(ClassLoader classLoader, String className) {
        try {
            // initialize=false loads the class and its supertypes without initializing it.
            // That is enough to notice a missing Web Browser (JCEF) module, and JCEF static
            // initializers must not run during the probe.
            Class.forName(className, false, classLoader);
            return true;
        } catch (ClassNotFoundException | LinkageError e) {
            return false;
        }
    }
}
