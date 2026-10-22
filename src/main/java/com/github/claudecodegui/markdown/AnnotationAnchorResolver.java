package com.github.claudecodegui.markdown;

/** Refuses ambiguous relocation instead of choosing the first matching sentence. */
public final class AnnotationAnchorResolver {
    private AnnotationAnchorResolver() {}

    public static int relocate(String document, String source, int originalStart, String prefix, String suffix) {
        if (source == null || source.isEmpty()) {
            return -1;
        }
        // Saved offsets alone are not proof of identity after a restart.
        // Live edits use RangeMarker; recovery must find a unique text/context pair.
        int found = -1;
        for (int offset = document.indexOf(source); offset >= 0; offset = document.indexOf(source, offset + 1)) {
            if (!matchesContext(document, offset, source.length(), prefix, suffix)) {
                continue;
            }
            if (found >= 0) {
                return -2;
            }
            found = offset;
        }
        if (found >= 0) {
            return found;
        }
        // Context can change during nearby edits. A unique source is still safe.
        int first = document.indexOf(source);
        if (first >= 0 && document.indexOf(source, first + 1) < 0) {
            return first;
        }
        return first >= 0 ? -2 : -1;
    }

    private static boolean matchesContext(String text, int start, int length, String prefix, String suffix) {
        String before = prefix == null ? "" : prefix;
        String after = suffix == null ? "" : suffix;
        return start >= before.length()
                && text.regionMatches(start - before.length(), before, 0, before.length())
                && start + length + after.length() <= text.length()
                && text.regionMatches(start + length, after, 0, after.length());
    }
}
