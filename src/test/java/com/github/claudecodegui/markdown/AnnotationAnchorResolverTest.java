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
}
