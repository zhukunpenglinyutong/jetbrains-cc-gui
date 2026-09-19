package com.github.claudecodegui.completion;

/**
 * Pure, unit-testable helpers for DeepSeek FIM editor completion.
 * No IDE runtime types are referenced here so the logic can be tested in a
 * plain JUnit environment.
 */
public final class FimCompletionLogic {

    public static final int DEFAULT_MAX_PREFIX_CHARS = 4000;
    public static final int DEFAULT_MAX_SUFFIX_CHARS = 1000;

    private FimCompletionLogic() {
    }

    /** Prefix/suffix pair extracted around the caret offset. */
    public static final class Context {
        public final String prefix;
        public final String suffix;

        Context(String prefix, String suffix) {
            this.prefix = prefix;
            this.suffix = suffix;
        }
    }

    public static Context extractContext(String text, int caretOffset, int maxPrefix, int maxSuffix) {
        int offset = Math.max(0, Math.min(caretOffset, text.length()));
        int prefixStart = Math.max(0, offset - maxPrefix);
        int suffixEnd = Math.min(text.length(), offset + maxSuffix);
        return new Context(text.substring(prefixStart, offset), text.substring(offset, suffixEnd));
    }

    /**
     * The FIM middle fragment inserts exactly at the caret, between the typed
     * prefix and the untouched suffix — it never replaces the suffix.
     */
    public static int computeInsertOffset(int caretOffset) {
        return caretOffset;
    }

    /**
     * A suggestion only makes sense when there is real code before the caret
     * (never on an empty line at the very start of the document).
     */
    public static boolean shouldSuggest(String text, int caretOffset) {
        if (text == null) { return false; }
        int offset = Math.max(0, Math.min(caretOffset, text.length()));
        if (offset == 0) { return false; }
        return !text.substring(0, offset).isBlank();
    }

    /**
     * True when the char immediately before the caret is an identifier-ish
     * character. In that case a normal word-completion is in progress and FIM
     * (which continues an arbitrary prefix) would fight the typed word, so we
     * skip triggering there.
     */
    public static boolean isIdentifierCharBeforeCaret(String text, int caretOffset) {
        if (text == null || caretOffset <= 0) { return false; }
        int offset = Math.min(caretOffset, text.length());
        if (offset <= 0) { return false; }
        char c = text.charAt(offset - 1);
        return Character.isJavaIdentifierPart(c) || c == '.' || c == '$';
    }
}
