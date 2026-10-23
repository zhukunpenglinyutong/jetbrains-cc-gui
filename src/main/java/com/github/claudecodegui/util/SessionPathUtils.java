package com.github.claudecodegui.util;

import java.util.Locale;

/** Normalizes session cwd strings before filesystem access or project comparisons. */
public final class SessionPathUtils {
    private SessionPathUtils() { }

    /** Converts Windows extended drive/UNC prefixes to ordinary paths, retaining path case. */
    public static String normalize(String path) {
        String value = path == null ? "" : path.replace('\\', '/');
        if (value.regionMatches(true, 0, "//?/UNC/", 0, 8)) {
            return "//" + value.substring(8);
        }
        if (value.matches("(?i)^//\\?/[a-z]:/.*")) {
            return value.substring(4);
        }
        return value;
    }

    /** Compares Windows paths without case sensitivity while retaining POSIX path case. */
    public static String forComparison(String path) {
        String value = normalize(path).replaceAll("/+$", "");
        return value.matches("(?i)^[a-z]:/.*") || value.startsWith("//") ? value.toLowerCase(Locale.ROOT) : value;
    }
}
