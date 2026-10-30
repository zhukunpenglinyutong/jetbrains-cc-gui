package com.github.claudecodegui.markdown;

/** Refuses ambiguous relocation instead of choosing the first matching sentence. */
public final class AnnotationAnchorResolver {
    /** How the stored quote still relates to the current document. */
    public enum AnchorStatus { FULL, FRAGMENT, AMBIGUOUS, MISSING }

    /** Matched range for a full or fragment match; -1/-1 when nothing can be located. */
    public record Match(AnchorStatus status, int start, int end) {
        static final Match AMBIGUOUS_MATCH = new Match(AnchorStatus.AMBIGUOUS, -1, -1);
        static final Match MISSING_MATCH = new Match(AnchorStatus.MISSING, -1, -1);
    }

    /** Fragment length used for head/tail anchors; shorter quotes keep the full-text rule. */
    static final int FRAGMENT_CHARS = 24;
    /** Short fallback so a middle edit does not destroy both 24-char fragments. */
    static final int SHORT_FRAGMENT_CHARS = 8;

    private AnnotationAnchorResolver() {}

    /**
     * Multi-anchor lookup (R5): the whole quote first, then a unique head or tail fragment.
     * Context disambiguates duplicates but never counts as an anchor on its own.
     */
    public static Match locate(String document, String source, int originalStart, String prefix, String suffix) {
        if (source == null || source.isEmpty()) {
            return Match.MISSING_MATCH;
        }
        int full = relocate(document, source, originalStart, prefix, suffix);
        if (full >= 0) {
            return new Match(AnchorStatus.FULL, full, full + source.length());
        }
        if (full == -2) {
            return Match.AMBIGUOUS_MATCH;
        }
        if (source.length() <= FRAGMENT_CHARS) {
            return Match.MISSING_MATCH;
        }
        Match head = locateFragment(document, source.substring(0, FRAGMENT_CHARS), prefix, null);
        Match tail = locateFragment(document, source.substring(source.length() - FRAGMENT_CHARS), null, suffix);
        if (head.status() == AnchorStatus.FRAGMENT) {
            return head;
        }
        if (tail.status() == AnchorStatus.FRAGMENT) {
            return tail;
        }
        if (source.length() > SHORT_FRAGMENT_CHARS) {
            Match shortHead = locateFragment(document, source.substring(0, SHORT_FRAGMENT_CHARS), prefix, null);
            Match shortTail = locateFragment(document, source.substring(source.length() - SHORT_FRAGMENT_CHARS), null, suffix);
            if (shortHead.status() == AnchorStatus.FRAGMENT) {
                return shortHead;
            }
            if (shortTail.status() == AnchorStatus.FRAGMENT) {
                return shortTail;
            }
            if (shortHead.status() == AnchorStatus.AMBIGUOUS || shortTail.status() == AnchorStatus.AMBIGUOUS) {
                return Match.AMBIGUOUS_MATCH;
            }
        }
        if (head.status() == AnchorStatus.AMBIGUOUS || tail.status() == AnchorStatus.AMBIGUOUS) {
            return Match.AMBIGUOUS_MATCH;
        }
        return Match.MISSING_MATCH;
    }

    private static Match locateFragment(String document, String fragment, String prefix, String suffix) {
        int first = document.indexOf(fragment);
        if (first < 0) {
            return Match.MISSING_MATCH;
        }
        if (document.indexOf(fragment, first + 1) < 0) {
            return new Match(AnchorStatus.FRAGMENT, first, first + fragment.length());
        }
        int contextual = -1;
        for (int offset = first; offset >= 0; offset = document.indexOf(fragment, offset + 1)) {
            boolean matches = prefix != null
                    ? offset >= prefix.length()
                        && document.regionMatches(offset - prefix.length(), prefix, 0, prefix.length())
                    : suffix != null
                        && offset + fragment.length() + suffix.length() <= document.length()
                        && document.regionMatches(offset + fragment.length(), suffix, 0, suffix.length());
            if (!matches) {
                continue;
            }
            if (contextual >= 0) {
                return Match.AMBIGUOUS_MATCH;
            }
            contextual = offset;
        }
        return contextual < 0
                ? Match.AMBIGUOUS_MATCH
                : new Match(AnchorStatus.FRAGMENT, contextual, contextual + fragment.length());
    }

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
