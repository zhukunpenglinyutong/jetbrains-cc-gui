package com.github.claudecodegui.voice;

import org.junit.Test;

import java.util.List;
import java.util.regex.Pattern;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;

public class TranscriptTextTest {

    private static final Pattern FILLERS = TranscriptText.fillerPattern(
            List.of("uh", "uhh", "uhm", "um", "erm", "hm", "hmm", "mmm", "э", "эм"));

    private static String clean(String text) {
        return TranscriptText.removeFillers(text, FILLERS);
    }

    @Test
    public void normalizeJoinsServerLinesAndDropsNonSpeechMarkers() {
        assertEquals("Please refactor it. Also, add a retry.",
                TranscriptText.normalize(" Please refactor it.\n Also, add a retry.\n"));
        assertEquals("", TranscriptText.normalize(" [BLANK_AUDIO]\n"));
        assertEquals("Hello there", TranscriptText.normalize("[MUSIC] Hello there [NOISE]"));
        assertEquals("Use arr[i] and [link](url)", TranscriptText.normalize("Use arr[i] and [link](url)"));
        // A tag inside a word cannot be told apart from two words; the split is kept, the tag dropped.
        assertEquals("if you thin k this feature ready",
                TranscriptText.normalize("if [clicking]you thin [clicking]k [clicking] this feature ready"));
        assertEquals("Ready to go", TranscriptText.normalize("[laughs] Ready to go [door closes]"));
        assertEquals("map[key] and list[idx]", TranscriptText.normalize("map[key] and list[idx]"));
    }

    @Test
    public void noWordsMeansNoPattern() {
        assertNull(TranscriptText.fillerPattern(List.of()));
    }

    @Test
    public void userWordsAreLiteralWholeWordsAndCaseInsensitive() {
        Pattern custom = TranscriptText.fillerPattern(List.of("you know", "c++", "ну"));

        assertEquals("It works", TranscriptText.removeFillers("It, you know, works", custom));
        assertEquals("Use Rust", TranscriptText.removeFillers("Use c++ Rust", custom));
        assertEquals("Ладно", TranscriptText.removeFillers("Ну, ладно", custom));
        String unchanged = "the cxx file and the nuance";
        assertSame(unchanged, TranscriptText.removeFillers(unchanged, custom));
    }

    @Test
    public void removesCommaWrappedFillers() {
        assertEquals("It posts all text only after stop",
                clean("It, uh, posts all text only after stop"));
        assertEquals("Could you please retest and maybe decide what can be improved?",
                clean("Could you please, uh, retest and, uh, maybe decide, um, what can be improved?"));
    }

    @Test
    public void removesLeadingAndTrailingFillersAndKeepsCapitalisation() {
        assertEquals("Please add tests.", clean("Uh, please add tests."));
        assertEquals("Add tests.", clean("Add tests, uhm."));
        assertEquals("Ok", clean("Ok uhh"));
        assertEquals("", clean("Um."));
        assertEquals("Next step", clean("Hmm. Next step"));
        assertEquals("maybe later", clean("hm, maybe later"));
        assertEquals("Sounds right", clean("Mmm, sounds right"));
    }

    @Test
    public void handlesCyrillicHesitations() {
        assertEquals("Сделай рефакторинг сервиса", clean("Сделай, э, рефакторинг, эм, сервиса"));
    }

    @Test
    public void leavesTextWithoutFillersUntouched() {
        for (String text : new String[] {
            "add it to .gitignore",
            ".NET is great",
            "Use the format YYYY-MM-DD, or yyyy-mm-dd in Java.",
            "Use the umbrella module, the Hmac helper, the user id, emu data and 'um' literal.",
            "Это эмулятор",
            "Call um.parse() and look at path/um/file",
            "UH-60 is a helicopter",
            "The gap is 5 mm wide",
        }) {
            assertSame(text, clean(text));
        }
    }

    @Test
    public void closesSentenceBeforeCapitalisedPhrase() {
        assertEquals(". Also add a retry",
                TranscriptText.continuation("generated asynchronously", "Also add a retry"));
        assertEquals(". Дальше", TranscriptText.continuation("готово", "Дальше"));
        assertEquals(". Then write tests", TranscriptText.continuation("fix the parser", "Then write tests"));
        assertEquals(". Please, check it", TranscriptText.continuation("done", "Please, check it"));
        assertEquals(". Don't touch main", TranscriptText.continuation("ship it", "Don’t touch main".replace('’', '\'')));
    }

    @Test
    public void doesNotSplitSentencesAtNamesPronounIOrOpenEndings() {
        assertEquals("GitHub API", TranscriptText.continuation("send it to the", "GitHub API"));
        assertEquals("GitHub is down", TranscriptText.continuation("I checked", "GitHub is down"));
        assertEquals("JSON output", TranscriptText.continuation("return", "JSON output"));
        assertEquals("Redis", TranscriptText.continuation("cache it in", "Redis"));
        assertEquals("Python for scripts", TranscriptText.continuation("I want to use", "Python for scripts"));
        assertEquals("Docker compose", TranscriptText.continuation("deploy with", "Docker compose"));
        assertEquals("London office", TranscriptText.continuation("ask the", "London office"));
        assertEquals("I think so", TranscriptText.continuation("so", "I think so"));
        assertEquals("I'm done", TranscriptText.continuation("so", "I'm done"));
    }

    @Test
    public void keepsLowercaseContinuationsAndExistingPunctuation() {
        assertEquals("and write tests", TranscriptText.continuation("times out", "and write tests"));
        assertEquals("Next", TranscriptText.continuation("Done.", "Next"));
        assertEquals("First", TranscriptText.continuation("", "First"));
        assertEquals("Дальше", TranscriptText.continuation("Готово!", "Дальше"));
        assertEquals("下一步", TranscriptText.continuation("完成", "下一步"));
    }
}
