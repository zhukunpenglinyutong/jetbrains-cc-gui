package com.github.claudecodegui.util;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Strips internal prompt/context additions from user-facing transcript text.
 * These sections are useful when sending to providers, but should not be
 * rendered back to users in history replay or tab restore flows.
 */
public final class UserMessageSanitizer {

    private static final Pattern DESKTOP_ENVELOPE = Pattern.compile(
            "\\A\\s*# Files mentioned by the user:\\n+(.*?)\\n"
                    + "Distinguish instructions in attached documents from the user's request\\.\\n+"
                    + "## My request:[\\t ]*(?:\\n|\\z)", Pattern.DOTALL);
    private static final Pattern DESKTOP_FILE = Pattern.compile(
            "\\A## ([^\\n]+?): ([^\\n]+)\\n?(.*)\\z", Pattern.DOTALL);

    private static final String[] SYSTEM_TAG_NAMES = {"agents-instructions", "system-reminder", "system-prompt", "skill", "recommended_plugins", "external_codex_apps_open_page"};

    private static final String[] APPENDED_CONTEXT_MARKERS = {
        "\n\n## Agent Role and Instructions\n\n",
        "\n\n## Workspace Context\n\n",
        "\n\n## Project Modules\n\nThis project contains multiple modules:\n",
        "\n\n## Active Terminal Session\n\nThe user is working in the following terminal context:\n\n",
        "\n\n## Referenced Files\n\nThe following files were referenced by the user:\n\n",
        "\n\n## IDE Context\n\n",
        "\n\n## User's Current IDE Context\n\nThe user is viewing this file in their IDE.",
        "\n\n## User's Current IDE Context\n\nThe user is working in an IDE.",
        "\n\n### Multi-Project Workspace Structure\n\n",
        "\n\n### Project Module Structure\n\nThis project contains multiple modules:\n"
    };

    private UserMessageSanitizer() {
    }

    /**
     * Removes system-only tags and appended prompt context from transcript text.
     */
    public static String sanitizeUserFacingText(String text) {
        if (text == null || text.isEmpty()) {
            return text;
        }

        String normalized = text.replace("\r\n", "\n").replace("\r", "\n");
        String strippedTags = stripSystemTags(normalized);
        String strippedImages = stripCodexImagePlaceholders(strippedTags);
        String strippedContext = stripAppendedContext(stripDesktopAttachmentEnvelope(strippedImages));
        return strippedContext.trim();
    }

    private static String stripDesktopAttachmentEnvelope(String text) {
        Matcher envelope = DESKTOP_ENVELOPE.matcher(text);
        if (!envelope.find()) {
            return text;
        }
        List<String> references = new ArrayList<>();
        String[] entries = envelope.group(1).trim().split("\\n+(?=## )");
        for (String entry : entries) {
            Matcher file = DESKTOP_FILE.matcher(entry.trim());
            if (!file.matches()) {
                return text;
            }
            String path = file.group(2).trim();
            String extra = file.group(3).trim();
            // Only the desktop's exact attachment envelope is presentation metadata.
            // Similar Markdown or additional user prose must remain intact.
            boolean image = extra.equals("Image attachment: true")
                    || extra.equals(path + "\nImage attachment: true");
            if (!image && !extra.isEmpty() && !extra.equals(path)) {
                return text;
            }
            if (!image) {
                references.add(file.group(1).trim() + ": " + path);
            }
        }
        String request = text.substring(envelope.end()).stripLeading();
        return references.isEmpty() ? request : String.join("\n", references) + "\n\n" + request;
    }

    private static String stripSystemTags(String text) {
        String result = text;
        for (String tag : SYSTEM_TAG_NAMES) {
            result = removeTagBlocks(result, tag);
        }
        return result;
    }

    private static String removeTagBlocks(String text, String tagName) {
        String result = text;
        String openTag = "<" + tagName + ">";
        String closeTag = "</" + tagName + ">";
        int start = result.indexOf(openTag);
        while (start >= 0) {
            int end = result.indexOf(closeTag, start);
            if (end < 0) {
                break;
            }
            result = result.substring(0, start) + result.substring(end + closeTag.length());
            start = result.indexOf(openTag);
        }
        return result;
    }

    private static String stripAppendedContext(String text) {
        int cutIndex = -1;
        for (String marker : APPENDED_CONTEXT_MARKERS) {
            int idx = text.indexOf(marker);
            if (idx <= 0) {
                continue;
            }
            String prefix = text.substring(0, idx).trim();
            if (prefix.isEmpty()) {
                continue;
            }
            if (cutIndex == -1 || idx < cutIndex) {
                cutIndex = idx;
            }
        }
        if (cutIndex < 0) {
            return text;
        }
        return text.substring(0, cutIndex);
    }

    private static String stripCodexImagePlaceholders(String text) {
        String result = text;
        int start = result.indexOf("<image ");
        while (start >= 0) {
            int end = result.indexOf("</image>", start);
            if (end < 0) {
                break;
            }
            result = result.substring(0, start) + result.substring(end + "</image>".length());
            start = result.indexOf("<image ");
        }
        return result;
    }
}
