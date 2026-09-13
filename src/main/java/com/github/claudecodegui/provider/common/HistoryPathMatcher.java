package com.github.claudecodegui.provider.common;

import java.util.Locale;

/**
 * Shared cwd matching for history readers (Claude CLI providers, Grok, OpenCode, …).
 *
 * <p>Rules (case-insensitive after normalize):
 * <ul>
 *   <li>Exact match after {@code \}→{@code /} and trailing-slash strip</li>
 *   <li>macOS {@code /tmp} ↔ {@code /private/tmp}</li>
 *   <li>Parent / child directory (either direction) so sessions under a subfolder
 *       still appear when browsing the project root, and vice versa</li>
 * </ul>
 */
public final class HistoryPathMatcher {

    private HistoryPathMatcher() {
    }

    public static String normalize(String path) {
        if (path == null) {
            return "";
        }
        String p = path.trim().replace('\\', '/');
        if (p.length() >= 2 && p.charAt(1) == ':') {
            p = Character.toLowerCase(p.charAt(0)) + p.substring(1);
        }
        while (p.endsWith("/") && p.length() > 1) {
            p = p.substring(0, p.length() - 1);
        }
        return p;
    }

    public static boolean matches(String sessionCwd, String projectPath) {
        if (sessionCwd == null || projectPath == null) {
            return false;
        }
        String a = normalize(sessionCwd).toLowerCase(Locale.ROOT);
        String b = normalize(projectPath).toLowerCase(Locale.ROOT);
        if (a.isEmpty() || b.isEmpty()) {
            return false;
        }
        if (a.equals(b)) {
            return true;
        }
        // macOS /tmp vs /private/tmp
        String a2 = stripPrivatePrefix(a);
        String b2 = stripPrivatePrefix(b);
        if (a2.equals(b2)) {
            return true;
        }
        return a.startsWith(b + "/") || b.startsWith(a + "/")
                || a2.startsWith(b2 + "/") || b2.startsWith(a2 + "/");
    }

    private static String stripPrivatePrefix(String path) {
        if (path.startsWith("/private/")) {
            return path.substring("/private".length());
        }
        return path;
    }
}
