package com.github.claudecodegui.util;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * Tests for {@link LogSanitizer}.
 *
 * <p>The property under test is that one attacker-supplied value cannot become
 * two log records. Both halves matter and pull against each other: the escape has
 * to be effective (no raw newline survives) and visible (the name stays
 * diagnosable). A sanitizer that deleted the character would pass the first
 * check and silently lose the user's ability to report a bug.
 */
public class LogSanitizerTest {

    /** The headline case: a file or directory name carrying a newline. */
    @Test
    public void aNewlineBecomesAVisibleEscape() {
        String sanitized = LogSanitizer.sanitize("evil\n2026-01-01 INFO - forged");

        assertFalse("a raw newline would split the record", sanitized.contains("\n"));
        assertEquals("evil\\u000a2026-01-01 INFO - forged", sanitized);
    }

    /** Every control character is escaped, not just the newline. */
    @Test
    public void controlCharactersBecomeEscapes() {
        assertEquals("\\u0000", LogSanitizer.sanitize("\u0000"));
        assertEquals("\\u000d\\u000a", LogSanitizer.sanitize("\r\n"));
        assertEquals("\\u001b", LogSanitizer.sanitize("\u001b"));
        assertEquals("\\u007f", LogSanitizer.sanitize("\u007f"));
        assertEquals("\\u001b[31m", LogSanitizer.sanitize("\u001b[31m"));
    }

    /**
     * U+2028 and U+2029 render as a line break in several log viewers even
     * though {@code println} does not treat them as one, so escaping only
     * {@code \n} and {@code \r} would leave the same forging path open.
     */
    @Test
    public void unicodeLineSeparatorsBecomeEscapes() {
        assertEquals("a\\u2028b", LogSanitizer.sanitize("a\u2028b"));
        assertEquals("a\\u2029b", LogSanitizer.sanitize("a\u2029b"));
    }

    /**
     * U+0085 NEL is the C1 character that reopens the forging path: it is legal
     * in a Unix file name, and line-splitting helpers including Python's
     * {@code str.splitlines()} and several log viewers treat it as a line break
     * even though {@code println} does not.
     */
    @Test
    public void nextLineIsEscapedBecauseViewersSplitOnIt() {
        assertEquals("x\\u0085[AgentDiscovery] WARN forged",
                LogSanitizer.sanitize("x\u0085[AgentDiscovery] WARN forged"));
    }

    /** The rest of C1 is escaped alongside it, for the same reason. */
    @Test
    public void theRestOfTheC1RangeIsEscaped() {
        assertEquals("\\u0080", LogSanitizer.sanitize("\u0080"));
        assertEquals("\\u009b", LogSanitizer.sanitize("\u009b"));
        assertEquals("\\u009f", LogSanitizer.sanitize("\u009f"));
    }

    /**
     * Bidi controls reorder displayed text without changing the bytes, which is
     * enough to make a forged record render as something the plugin would
     * plausibly have written.
     */
    @Test
    public void bidiControlsAreEscapedSoTextCannotBeReordered() {
        // RLO reverses the run that follows it; LRI/PDI scope such a run;
        // RLM and ALM are the letter marks. Each renders without changing the
        // bytes, which is what makes a forged record hard to spot.
        assertEquals("\\u202eagent.md", LogSanitizer.sanitize("\u202eagent.md"));
        assertEquals("\\u2066x\\u2069", LogSanitizer.sanitize("\u2066x\u2069"));
        assertEquals("\\u200f", LogSanitizer.sanitize("\u200f"));
        assertEquals("\\u061c", LogSanitizer.sanitize("\u061c"));
    }

    /** Escaping must not mangle text that merely looks similar. */
    @Test
    public void nonBidiNonControlTextIsLeftAlone() {
        assertEquals("\u2192 \u21d2 \u27f5 \u00b7", LogSanitizer.sanitize("\u2192 \u21d2 \u27f5 \u00b7"));
        assertEquals("\u5317\u4eac", LogSanitizer.sanitize("\u5317\u4eac"));
        assertEquals("caf\u00e9", LogSanitizer.sanitize("caf\u00e9"));
    }

    /** An ordinary value is returned unchanged, including non-ASCII text. */
    @Test
    public void ordinaryValuesAreUntouched() {
        assertEquals("code-reviewer.md", LogSanitizer.sanitize("code-reviewer.md"));
        assertEquals("/home/u/.claude/agents", LogSanitizer.sanitize("/home/u/.claude/agents"));
        assertEquals("агент-пример.md", LogSanitizer.sanitize("агент-пример.md"));
        // A tab cannot start a new log line, but it is still an invisible
        // character that can be used to disguise what a record says, so it is
        // escaped like the rest of the C0 range.
        assertEquals("a\\u0009b", LogSanitizer.sanitize("a\tb"));
    }

    /**
     * A clean value is returned as the same instance, not a copy.
     *
     * <p>This runs on every discovered file on every scan; a scanner that
     * allocated a StringBuilder per clean file name would pay that on the hot
     * path for nothing.
     */
    @Test
    public void aCleanValueIsReturnedWithoutCopying() {
        String clean = "code-reviewer.md";

        assertSame(clean, LogSanitizer.sanitize(clean));
    }

    /** A null or empty value must not vanish and leave a gap in the log line. */
    @Test
    public void anAbsentValueStillProducesSomethingReadable() {
        assertEquals("(none)", LogSanitizer.sanitize(null));
        assertEquals("(none)", LogSanitizer.sanitize(""));
    }

    /**
     * Only the forging characters are escaped; the rest of an agent file name
     * stays readable so a user can still name it in a bug report.
     */
    @Test
    public void onlyTheForgingCharactersAreChanged() {
        String sanitized = LogSanitizer.sanitize("my agent (v2) — финальный\nверсия.md");

        assertEquals("my agent (v2) — финальный\\u000aверсия.md", sanitized);
    }
}