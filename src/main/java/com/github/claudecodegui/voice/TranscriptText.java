package com.github.claudecodegui.voice;

import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Text clean-up applied to every transcript before it reaches the input box.
 */
public final class TranscriptText {

    /** A filler only counts as a whole word, never glued to identifiers, paths or dates ("yyyy-mm-dd", "'um'"). */
    private static final String WORD_BEFORE = "(?<![\\p{L}\\p{N}'’_\\-./@])";
    private static final String WORD_AFTER = "(?![\\p{L}\\p{N}'’_\\-/@])(?!\\.[\\p{L}\\p{N}])";
    private static final String SENTENCE_PUNCTUATION = ".!?;:";
    /**
     * Sound tags transcribers insert instead of speech: "[BLANK_AUDIO]" (whisper.cpp), "[clicking]",
     * "[MUSIC]". A tag is a bracketed run of letters standing on its own, so code ("arr[i]") and
     * Markdown links ("[text](url)") are left alone.
     */
    private static final Pattern NON_SPEECH_MARKER = Pattern.compile(
            "(?<![\\p{L}\\p{N}_\\])])\\[\\p{L}[\\p{L}_ ]{2,}\\](?!\\()");
    private static final Pattern WHITESPACE_RUN = Pattern.compile("\\s+");
    /** Words that cannot end an English sentence: a phrase ending in one continues in the next. */
    private static final Set<String> OPEN_ENDINGS = Set.of(
            "a", "an", "the", "to", "of", "in", "on", "at", "by", "for", "from", "with", "into", "about",
            "and", "or", "but", "as", "than", "my", "your", "our", "their", "this", "that", "these", "those",
            "is", "are", "was", "were", "be", "if");

    /**
     * English words that typically open a new sentence in a spoken prompt. A capitalised phrase
     * starting with anything else ("Python", "Docker") is more likely a name inside the sentence.
     */
    private static final Set<String> SENTENCE_STARTERS = Set.of(
            "also", "and", "but", "so", "then", "now", "next", "after", "afterwards", "finally", "first",
            "second", "third", "lastly", "please", "it", "this", "that", "these", "those", "there", "here",
            "we", "you", "they", "he", "she", "let's", "lets", "my", "our", "your", "if", "when", "where",
            "what", "why", "how", "which", "who", "can", "could", "would", "should", "will", "do", "does",
            "don't", "is", "are", "add", "make", "fix", "write", "create", "update", "remove", "delete",
            "change", "check", "run", "show", "explain", "refactor", "implement", "rename", "move", "try",
            "look", "find", "replace", "test", "keep", "use", "ok", "okay", "yes", "no", "thanks");

    private TranscriptText() {
    }

    /**
     * Turns a provider's transcript into one line of prompt text: drops non-speech markers
     * ("[BLANK_AUDIO]", "[MUSIC]") and joins the per-segment lines some servers return.
     */
    public static String normalize(String text) {
        String withoutMarkers = NON_SPEECH_MARKER.matcher(text).replaceAll(" ");
        return WHITESPACE_RUN.matcher(withoutMarkers).replaceAll(" ").strip();
    }

    /**
     * Compiles the user's filler words into one whole-word, case-insensitive pattern.
     *
     * @return null when there is nothing to remove
     */
    public static Pattern fillerPattern(List<String> words) {
        if (words.isEmpty()) {
            return null;
        }
        // Longest first, so "uhm" wins over "uh".
        String alternatives = words.stream()
                .sorted(Comparator.comparingInt(String::length).reversed())
                .map(Pattern::quote)
                .collect(Collectors.joining("|"));
        return Pattern.compile(WORD_BEFORE + "(?:" + alternatives + ")" + WORD_AFTER,
                Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    }

    /**
     * Removes filler words together with the commas and spaces around them. Text without a
     * filler is returned unchanged.
     */
    public static String removeFillers(String text, Pattern fillers) {
        Matcher matcher = fillers.matcher(text);
        if (!matcher.find()) {
            return text;
        }
        boolean startedWithFiller = text.substring(0, matcher.start()).isBlank();
        boolean capitalised = Character.isUpperCase(text.charAt(matcher.start()));
        StringBuilder out = new StringBuilder(text.length());
        int last = 0;
        do {
            out.append(text, last, matcher.start());
            trimTrailingCommaAndSpace(out);
            int next = skipCommaAndSpace(text, matcher.end());
            if (out.isEmpty()) {
                next = skipPunctuationAndSpace(text, next);
            } else if (next < text.length() && SENTENCE_PUNCTUATION.indexOf(text.charAt(next)) < 0) {
                out.append(' ');
            }
            last = next;
        } while (matcher.find(last));
        out.append(text, last, text.length());

        String cleaned = out.toString().strip();
        if (startedWithFiller && capitalised && !cleaned.isEmpty() && Character.isLowerCase(cleaned.codePointAt(0))) {
            cleaned = cleaned.substring(0, 1).toUpperCase(Locale.ROOT) + cleaned.substring(1);
        }
        return cleaned;
    }

    /**
     * Returns {@code next} as it should be appended after {@code previous} in live mode.
     *
     * <p>Per-phrase transcription drops the final period of each phrase, so a capitalised next
     * phrase may mean the previous sentence ended: close it with ". ". In Latin script that needs
     * a typical sentence opener ({@link #SENTENCE_STARTERS}), since a capitalised word mid-sentence
     * is usually a name; a missing period is cheaper than a wrong one. Phrases that clearly
     * continue ("send it to the") never get one.
     */
    public static String continuation(String previous, String next) {
        if (previous.isEmpty() || next.isEmpty()) {
            return next;
        }
        int last = previous.codePointBefore(previous.length());
        if (!Character.isLetterOrDigit(last) || !Character.isUpperCase(next.codePointAt(0))) {
            return next;
        }
        String firstWord = firstWord(next);
        String lastWord = lastWord(previous).toLowerCase(Locale.ROOT);
        if (OPEN_ENDINGS.contains(lastWord) || hasInnerCapital(firstWord)) {
            return next;
        }
        if (isLatin(firstWord.codePointAt(0))
                && !SENTENCE_STARTERS.contains(stripTrailingPunctuation(firstWord).toLowerCase(Locale.ROOT).replace('’', '\''))) {
            return next;
        }
        return ". " + next;
    }

    private static void trimTrailingCommaAndSpace(StringBuilder out) {
        int end = out.length();
        while (end > 0 && Character.isWhitespace(out.charAt(end - 1))) {
            end--;
        }
        if (end > 0 && out.charAt(end - 1) == ',') {
            end--;
        }
        while (end > 0 && Character.isWhitespace(out.charAt(end - 1))) {
            end--;
        }
        out.setLength(end);
    }

    private static int skipCommaAndSpace(String text, int from) {
        int i = skipSpace(text, from);
        if (i < text.length() && text.charAt(i) == ',') {
            i = skipSpace(text, i + 1);
        }
        return i;
    }

    private static int skipPunctuationAndSpace(String text, int from) {
        int i = from;
        while (i < text.length() && (SENTENCE_PUNCTUATION.indexOf(text.charAt(i)) >= 0
                || text.charAt(i) == ',' || Character.isWhitespace(text.charAt(i)))) {
            i++;
        }
        return i;
    }

    private static int skipSpace(String text, int from) {
        int i = from;
        while (i < text.length() && Character.isWhitespace(text.charAt(i))) {
            i++;
        }
        return i;
    }

    private static String firstWord(String text) {
        int end = 0;
        while (end < text.length() && !Character.isWhitespace(text.charAt(end))) {
            end++;
        }
        return text.substring(0, end);
    }

    private static String lastWord(String text) {
        int start = text.length();
        while (start > 0 && Character.isLetterOrDigit(text.charAt(start - 1))) {
            start--;
        }
        return text.substring(start);
    }

    private static boolean isLatin(int codePoint) {
        return Character.UnicodeScript.of(codePoint) == Character.UnicodeScript.LATIN;
    }

    private static String stripTrailingPunctuation(String word) {
        int end = word.length();
        while (end > 0 && !Character.isLetterOrDigit(word.charAt(end - 1)) && word.charAt(end - 1) != '\'') {
            end--;
        }
        return word.substring(0, end);
    }

    private static boolean hasInnerCapital(String word) {
        for (int i = 1; i < word.length(); i++) {
            if (Character.isUpperCase(word.charAt(i))) {
                return true;
            }
        }
        return false;
    }
}
