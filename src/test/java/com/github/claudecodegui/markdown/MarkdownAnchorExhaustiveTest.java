package com.github.claudecodegui.markdown;

import org.junit.Test;
import static org.junit.Assert.*;

/**
 * Exhaustive test suite for annotation anchoring and fuzzy relocation:
 * - CRLF and LF mixed line endings
 * - Multibyte CJK characters and Emoji surrogate pairs
 * - Disambiguation across multiple identical paragraphs
 * - Head and tail fragment survival
 * - Empty string and boundary safety
 */
public class MarkdownAnchorExhaustiveTest {

    @Test
    public void testCrLfAndMixedLineEndings() {
        String docCrLf = "# 标题\r\n\r\n段落一内容。\r\n\r\n段落二重点内容。\r\n\r\n段落三。";
        // Target is "段落二重点内容"
        int targetOffset = docCrLf.indexOf("段落二重点内容");
        assertTrue(targetOffset > 0);

        int relocated = AnnotationAnchorResolver.relocate(
                docCrLf, "段落二重点内容", targetOffset, "段落一内容。\r\n\r\n", "。\r\n\r\n段落三"
        );
        assertEquals(targetOffset, relocated);

        // Prepend text with CRLF and relocate
        String prepended = "新增前言段落\r\n" + docCrLf;
        int expectedAfterPrepend = targetOffset + "新增前言段落\r\n".length();
        int relocatedAfterPrepend = AnnotationAnchorResolver.relocate(
                prepended, "段落二重点内容", targetOffset, "段落一内容。\r\n\r\n", "。\r\n\r\n段落三"
        );
        assertEquals(expectedAfterPrepend, relocatedAfterPrepend);
    }

    @Test
    public void testMultibyteEmojiSurrogatePairsAndCJK() {
        // Emoji like 🚀 (U+1F680) and 👨‍👩‍👧‍👦 take multiple UTF-16 code units
        String text = "前置文本 😀 关键审查文字 🎉 👨‍👩‍👧‍👦 后置文本";
        int target = text.indexOf("关键审查文字");
        String prefix = text.substring(0, target);
        String suffix = text.substring(target + "关键审查文字".length());

        int relocated = AnnotationAnchorResolver.relocate(text, "关键审查文字", target, prefix, suffix);
        assertEquals(target, relocated);

        // Insert additional emojis before target
        String modified = "💡 🌟 " + text;
        int newTarget = AnnotationAnchorResolver.relocate(modified, "关键审查文字", target, prefix, suffix);
        assertEquals(modified.indexOf("关键审查文字"), newTarget);
    }

    @Test
    public void testMultipleIdenticalParagraphsDisambiguation() {
        // Document with 4 repeated identical lines, but with different surrounding lines
        String doc = "SECTION 1\nRepeat item\nEND 1\n"
                   + "SECTION 2\nRepeat item\nEND 2\n"
                   + "SECTION 3\nRepeat item\nEND 3\n"
                   + "SECTION 4\nRepeat item\nEND 4\n";

        int target2 = doc.indexOf("SECTION 2\nRepeat item") + "SECTION 2\n".length();
        int relocated2 = AnnotationAnchorResolver.relocate(
                doc, "Repeat item", 0, "SECTION 2\n", "\nEND 2"
        );
        assertEquals(target2, relocated2);

        int target4 = doc.indexOf("SECTION 4\nRepeat item") + "SECTION 4\n".length();
        int relocated4 = AnnotationAnchorResolver.relocate(
                doc, "Repeat item", 0, "SECTION 4\n", "\nEND 4"
        );
        assertEquals(target4, relocated4);
    }

    @Test
    public void testDuplicateContextsReturnAmbiguous() {
        // When contexts are completely identical across two occurrences, it must refuse to guess
        String ambiguousDoc = "Item: target\nItem: target\n";
        int result = AnnotationAnchorResolver.relocate(ambiguousDoc, "target", 0, "Item: ", "\n");
        assertEquals("Identical duplicate contexts must yield AMBIGUOUS status (-2)", -2, result);
    }

    @Test
    public void testHeadAndTailFragmentTolerance() {
        String originalSource = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()";
        assertTrue(originalSource.length() > AnnotationAnchorResolver.FRAGMENT_CHARS);

        // Edit the beginning of the text: "MODIFIED" + tail
        String modifiedHead = "MODIFIED_START_OF_THE_STRING_0123456789!@#$%^&*()";
        var tailMatch = AnnotationAnchorResolver.locate(
                "prefix " + modifiedHead + " suffix", originalSource, 0, "prefix ", " suffix"
        );
        assertEquals(AnnotationAnchorResolver.AnchorStatus.FRAGMENT, tailMatch.status());

        // Edit the end of the text: head + "MODIFIED"
        String modifiedTail = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_MODIFIED_TAIL";
        var headMatch = AnnotationAnchorResolver.locate(
                "prefix " + modifiedTail + " suffix", originalSource, 0, "prefix ", " suffix"
        );
        assertEquals(AnnotationAnchorResolver.AnchorStatus.FRAGMENT, headMatch.status());
    }

    @Test
    public void testEmptyAndBoundaryInputs() {
        assertEquals(-1, AnnotationAnchorResolver.relocate("", "target", 0, "", ""));
        assertEquals(-1, AnnotationAnchorResolver.relocate("some doc", "", 0, "", ""));
        assertEquals(-1, AnnotationAnchorResolver.relocate("some doc", "target", -5, "", ""));
        assertEquals(-1, AnnotationAnchorResolver.relocate("some doc", "target", 1000, "", ""));

        var locateEmpty = AnnotationAnchorResolver.locate("", "", 0, "", "");
        assertEquals(AnnotationAnchorResolver.AnchorStatus.MISSING, locateEmpty.status());
    }
}
