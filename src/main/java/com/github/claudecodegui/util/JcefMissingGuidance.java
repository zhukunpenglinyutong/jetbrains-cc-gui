package com.github.claudecodegui.util;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.application.ApplicationInfo;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.BuildNumber;
import com.intellij.openapi.util.SystemInfo;
import com.intellij.openapi.util.text.StringUtil;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * Guidance shown when the JCEF classes needed by the chat window cannot be loaded.
 * This class must not reference JCEF types: it has to link in exactly the IDEs where
 * those classes are missing.
 */
public final class JcefMissingGuidance {

    static final String PLUGIN_MISSING_TITLE_KEY = "toolwindow.jcefPluginMissing";
    static final String PLUGIN_MISSING_SOLUTION_KEY = "toolwindow.jcefPluginMissingSolution";
    static final String MODULE_MISSING_TITLE_KEY = "toolwindow.jcefModuleMissing";
    static final String MODULE_MISSING_SOLUTION_KEY = "toolwindow.jcefModuleMissingSolution";

    private static final String NOTIFICATION_GROUP_ID = "CC GUI Notifications";
    private static final String ANDROID_STUDIO_PRODUCT_CODE = "AI";
    /** First Android Studio baseline (2026.2) that ships JCEF as the separate Web Browser (JCEF) plugin. */
    private static final int SEPARATE_JCEF_MODULE_BASELINE = 262;

    private JcefMissingGuidance() {
    }

    /**
     * Returns whether the running IDE is an Android Studio build whose JCEF support comes
     * from the separately installed Web Browser (JCEF) plugin.
     *
     * @return true for Android Studio 2026.2+ on Windows or macOS
     */
    public static boolean isAndroidStudioWithSeparateJcefModule() {
        BuildNumber build = ApplicationInfo.getInstance().getBuild();
        return isAndroidStudioWithSeparateJcefModule(
                build.getProductCode(),
                build.getBaselineVersion(),
                SystemInfo.isWindows || SystemInfo.isMac);
    }

    static boolean isAndroidStudioWithSeparateJcefModule(
            @Nullable String productCode,
            int baselineVersion,
            boolean windowsOrMac
    ) {
        return ANDROID_STUDIO_PRODUCT_CODE.equals(productCode)
                && windowsOrMac
                && baselineVersion >= SEPARATE_JCEF_MODULE_BASELINE;
    }

    /**
     * @return localized headline for the current IDE
     */
    public static @NotNull String title() {
        return ClaudeCodeGuiBundle.message(titleKey(isAndroidStudioWithSeparateJcefModule()));
    }

    /**
     * @return localized, newline-separated steps for the current IDE
     */
    public static @NotNull String solution() {
        return ClaudeCodeGuiBundle.message(solutionKey(isAndroidStudioWithSeparateJcefModule()));
    }

    /**
     * Shows the headline and the steps in a balloon, for entry points that have no
     * tool-window panel to render the guidance in. The balloon stays until dismissed
     * so the steps can be followed.
     *
     * @param project project whose frame shows the balloon
     */
    public static void showNotification(@NotNull Project project) {
        NotificationGroupManager.getInstance()
                .getNotificationGroup(NOTIFICATION_GROUP_ID)
                .createNotification(title(), toNotificationHtml(solution()), NotificationType.ERROR)
                .setImportant(true)
                .notify(project);
    }

    // Missing classes mean the IDE module is absent, so the other IDEs get module text rather
    // than the Boot Runtime advice used when only the native CEF runtime is missing.
    static String titleKey(boolean androidStudioPlugin) {
        return androidStudioPlugin ? PLUGIN_MISSING_TITLE_KEY : MODULE_MISSING_TITLE_KEY;
    }

    static String solutionKey(boolean androidStudioPlugin) {
        return androidStudioPlugin ? PLUGIN_MISSING_SOLUTION_KEY : MODULE_MISSING_SOLUTION_KEY;
    }

    static String toNotificationHtml(@NotNull String text) {
        return StringUtil.escapeXmlEntities(text).replace("\n", "<br>");
    }
}
