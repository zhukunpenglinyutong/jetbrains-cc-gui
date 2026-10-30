package com.github.claudecodegui.markdown;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class AnnotationAnchorResolverTest {
    @Test
    public void relocatesAfterInsertionsIncludingUtf16AndCrLf() {
        assertEquals(7, AnnotationAnchorResolver.relocate("前言\r\n😀 原文\r\n尾部", "原文", 0, "😀 ", "\r\n尾部"));
    }

    @Test
    public void usesContextToDisambiguateDuplicateParagraphs() {
        assertEquals(11, AnnotationAnchorResolver.relocate("A same Z B same Y", "same", 2, "B ", " Y"));
    }

    @Test
    public void refusesDuplicateContextsEvenAtOriginalOffset() {
        assertEquals(-2, AnnotationAnchorResolver.relocate("A same Z A same Z", "same", 2, "A ", " Z"));
        assertEquals(-2, AnnotationAnchorResolver.relocate("same same", "same", 0, "", ""));
    }

    @Test
    public void fallsBackOnlyToUniqueSourceAndKeepsDeletedTextOrphaned() {
        assertEquals(4, AnnotationAnchorResolver.relocate("new same ending", "same", 0, "old ", " old"));
        assertEquals(-1, AnnotationAnchorResolver.relocate("changed", "same", 0, "", ""));
        assertEquals(-1, AnnotationAnchorResolver.relocate("changed", "", 0, "", ""));
    }

    @Test
    public void keepsTheCommentWhenAHeadOrTailFragmentSurvives() {
        String source = "the quick brown fox jumps over the lazy dog";
        int fragment = AnnotationAnchorResolver.FRAGMENT_CHARS;
        String head = source.substring(0, fragment);
        String tail = source.substring(source.length() - fragment);

        var headMatch = AnnotationAnchorResolver.locate(
                "the quick brown fox jumps over a lazy dog", source, 0, "", "");
        assertEquals(AnnotationAnchorResolver.AnchorStatus.FRAGMENT, headMatch.status());
        assertEquals(head, "the quick brown fox jumps over a lazy dog".substring(headMatch.start(), headMatch.end()));

        var tailMatch = AnnotationAnchorResolver.locate(
                "a quick brown fox jumps over the lazy dog", source, 0, "", "");
        assertEquals(AnnotationAnchorResolver.AnchorStatus.FRAGMENT, tailMatch.status());
        assertEquals(tail, "a quick brown fox jumps over the lazy dog".substring(tailMatch.start(), tailMatch.end()));
    }

    @Test
    public void reportsAmbiguousFragmentsAndMissingAnchors() {
        String source = "abcdefghijklmnopqrstuvwxyz0123456789";
        String head = source.substring(0, AnnotationAnchorResolver.FRAGMENT_CHARS);
        assertEquals(AnnotationAnchorResolver.AnchorStatus.AMBIGUOUS,
                AnnotationAnchorResolver.locate(head + head, source, 0, "", "").status());
        assertEquals(AnnotationAnchorResolver.AnchorStatus.MISSING,
                AnnotationAnchorResolver.locate("nothing here", source, 0, "", "").status());
    }

    @Test
    public void shortHeadAnchorSurvivesAnEditThatBreaksBothLongFragments() {
        // 25 chars: the 24-char head and tail both include the edited middle char.
        String source = "abcdefghijklmnopqrstuvwxy";
        assertEquals(AnnotationAnchorResolver.AnchorStatus.FRAGMENT,
                AnnotationAnchorResolver.locate("abcdefghijXlmnopqrstuvwxy", source, 0, "", "").status());
    }
}
