package com.github.claudecodegui.util;

/**
 * Makes an attacker-controlled string safe to interpolate into a log line.
 *
 * <p>Not every string a handler logs is under the plugin's control. A file name
 * comes from a directory listing, a project name comes from a directory the user
 * opened, and an error message may quote either back verbatim. Interpolated raw
 * into a log line, a newline closes that line early and a log viewer reads the
 * remainder as an independent record — enough to forge a plausible-looking
 * warning, or to bury a real one.
 *
 * <p>Every log statement that quotes such a value goes through
 * {@link #sanitize(String)} first. The escaping is deliberately visible rather
 * than silent: a stripped character would prevent the forgery <em>and</em> the
 * diagnosis, and the name has to stay recognisable to be useful in a bug report.
 */
public final class LogSanitizer {

    /**
     * U+2028 and U+2029. Legal in a Unix file name, invisible in most editors,
     * and rendered as a line break by several log viewers — which makes them a
     * log-forging vector even though {@code println} does not treat them as one.
     */
    private static final char LINE_SEPARATOR = '\u2028';
    private static final char PARAGRAPH_SEPARATOR = '\u2029';

    private LogSanitizer() {
    }

    /**
     * Replace the characters that would let a value forge a second log record.
     *
     * <p>Control characters, {@code DEL}, and the two Unicode line separators
     * become a {@code \\uXXXX} escape. Everything else, including non-ASCII text
     * and backslashes that are part of the value, is left alone.
     *
     * @param value the value as received; may be null
     * @return a value safe to concatenate into a single log line, never null
     */
    public static String sanitize(String value) {
        if (value == null || value.isEmpty()) {
            return "(none)";
        }
        int length = value.length();
        // Built only once a character actually needs replacing. Most values are
        // clean — a scan logs one file name per discovered agent — and returning
        // the original instance for those keeps the common path allocation-free.
        StringBuilder safe = null;
        for (int i = 0; i < length; i++) {
            char c = value.charAt(i);
            String replacement = replacementFor(c);
            if (replacement == null) {
                // Keep the character. Before the first replacement the prefix has
                // not been copied yet and is taken wholesale when the time comes;
                // afterwards it has to be appended one character at a time.
                if (safe != null) {
                    safe.append(c);
                }
                continue;
            }
            if (safe == null) {
                safe = new StringBuilder(length + 16).append(value, 0, i);
            }
            safe.append(replacement);
        }
        return safe == null ? value : safe.toString();
    }

    /**
     * @return the escape for a character that must not survive, or null when the
     *         character is safe as-is
     */
    private static String replacementFor(char c) {
        // C0 and DEL. A tab is in the C0 range and cannot end a log line, but it
        // is invisible enough to misalign a record, so it goes with the rest.
        if (c < 0x20 || c == 0x7F) {
            return escape(c);
        }
        // C1. U+0085 NEL is the one that matters: it is a legal byte in a Unix
        // file name and several log viewers and line-splitting helpers treat it
        // as a line break, which would reopen the forging path the C0 check
        // closes. The rest of the range is escaped for the same reason — none of
        // it has any business in a file name a user needs to read back.
        if (c >= 0x80 && c <= 0x9F) {
            return escape(c);
        }
        if (c == LINE_SEPARATOR) {
            return "\\u2028";
        }
        if (c == PARAGRAPH_SEPARATOR) {
            return "\\u2029";
        }
        // Bidi controls reorder what a log viewer displays without changing the
        // bytes, which is enough to make a forged record indistinguishable from
        // a real one. RLO/LRO reverse the run that follows them; the isolates
        // and marks scope such a run.
        if (c >= 0x202A && c <= 0x202E || c >= 0x2066 && c <= 0x2069) {
            return escape(c);
        }
        // The Arabic/Hebrew letter marks behave the same way.
        if (c >= 0x200B && c <= 0x200F || c == 0x061C) {
            return escape(c);
        }
        return null;
    }

    /**
     * @return the character as a {@code \\uXXXX} escape
     */
    private static String escape(char c) {
        return String.format("\\u%04x", (int) c);
    }
}
