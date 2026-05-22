package com.github.claudecodegui.ui.toolwindow;

import java.util.Collection;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Formats forked session titles while preserving the 50-character custom-title limit.
 */
public final class ForkTitleFormatter {
    private static final String FORK_LABEL = "fork";
    private static final int CUSTOM_TITLE_MAX_LENGTH = 50;
    private static final Pattern TRAILING_FORK_SUFFIX = Pattern.compile("(?:\\[fork(?:\\s+\\d+)?\\])+$");
    private static final Pattern LAST_FORK_SUFFIX = Pattern.compile("\\[fork(?:\\s+(\\d+))?\\]$");

    private ForkTitleFormatter() {
    }

    /**
     * Builds a fork title by stripping existing fork suffixes, selecting the next sibling index,
     * and truncating the root so the final title fits the persisted custom-title limit.
     *
     * @param sourceTitle the source session title or an existing fork title
     * @param existingTitles titles already used for the same source root
     * @return a title ending in [fork] or [fork n]
     */
    public static String buildForkTitle(String sourceTitle, Collection<String> existingTitles) {
        String rootTitle = normalizeRootTitle(sourceTitle);
        int nextIndex = findNextForkIndex(rootTitle, existingTitles);
        String suffix = nextIndex <= 1 ? "[" + FORK_LABEL + "]" : "[" + FORK_LABEL + " " + nextIndex + "]";
        return truncateRootForSuffix(rootTitle, suffix) + suffix;
    }

    private static String normalizeRootTitle(String title) {
        String value = title != null ? title.trim() : "";
        return TRAILING_FORK_SUFFIX.matcher(value).replaceAll("").trim();
    }

    private static int findNextForkIndex(String rootTitle, Collection<String> existingTitles) {
        int maxIndex = 0;
        if (existingTitles == null) {
            return 1;
        }

        for (String existingTitle : existingTitles) {
            String normalizedExistingTitle = existingTitle != null ? existingTitle.trim() : "";
            Matcher matcher = LAST_FORK_SUFFIX.matcher(normalizedExistingTitle);
            if (!matcher.find()) {
                continue;
            }

            String indexGroup = matcher.group(1);
            int index = indexGroup == null ? 1 : parseIndex(indexGroup);
            String suffix = index <= 1 ? "[" + FORK_LABEL + "]" : "[" + FORK_LABEL + " " + index + "]";
            if (!truncateRootForSuffix(rootTitle, suffix).equals(normalizeRootTitle(normalizedExistingTitle))) {
                continue;
            }

            maxIndex = Math.max(maxIndex, index);
        }
        return maxIndex + 1;
    }

    private static int parseIndex(String value) {
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException ignored) {
            return 1;
        }
    }

    private static String truncateRootForSuffix(String rootTitle, String suffix) {
        int maxRootLength = CUSTOM_TITLE_MAX_LENGTH - suffix.length();
        if (rootTitle.length() <= maxRootLength) {
            return rootTitle;
        }
        return rootTitle.substring(0, Math.max(0, maxRootLength));
    }
}
