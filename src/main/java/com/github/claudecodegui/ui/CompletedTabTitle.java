package com.github.claudecodegui.ui;

import com.intellij.openapi.util.text.StringUtil;
import com.intellij.ui.content.Content;

/** Native labels carry their formatting to Remote Development clients without a separate icon slot. */
public final class CompletedTabTitle {
    private static final String PREFIX = "<html>";
    private static final String SUFFIX = "<sup><font color=\"#3FA05B\" size=\"1\">&#9679;</font></sup></html>";

    private CompletedTabTitle() { }

    public static String plain(Content content) {
        String title = content.getDisplayName();
        return decorated(title)
                ? StringUtil.unescapeXmlEntities(title.substring(PREFIX.length(), title.length() - SUFFIX.length()))
                : title;
    }

    public static String completed(String title) {
        return PREFIX + StringUtil.escapeXmlEntities(title == null ? "" : title) + SUFFIX;
    }

    /** Rename/status changes preserve the marker while persistence and dialogs keep the plain title. */
    public static void setPlain(Content content, String title) {
        content.setDisplayName(decorated(content.getDisplayName()) ? completed(title) : title);
    }

    public static void show(Content content) {
        String title = completed(plain(content));
        if (!title.equals(content.getDisplayName())) {
            content.setDisplayName(title);
        }
    }

    public static void hide(Content content) {
        if (decorated(content.getDisplayName())) {
            content.setDisplayName(plain(content));
        }
    }

    private static boolean decorated(String title) {
        return title != null && title.startsWith(PREFIX) && title.endsWith(SUFFIX);
    }
}
