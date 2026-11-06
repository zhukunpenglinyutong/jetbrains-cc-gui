package com.github.claudecodegui.markdown;

import org.junit.Test;
import static org.junit.Assert.*;

public class RenderedSelectionMatcherTest {
    @Test
    public void mapsRepeatedMermaidFencesSeparatelyAndSkipsCodeExamples() {
        String example = "````md\n```mermaid\ngraph TD\nA-->B\n```\n````\n";
        String fence = "```mermaid\r\ngraph TD\r\nA-->B\r\n```\r\n";
        var ranges = RenderedSelectionMatcher.mermaidRanges(example + fence + fence);
        assertEquals(2, ranges.size());
        assertEquals(example.length(), ranges.get(0).start());
        assertEquals(example.length() + fence.length(), ranges.get(1).start());
        assertEquals("graph TD\nA-->B", ranges.get(0).source());
    }
    @Test
    public void validatesMermaidLabelsWithRenderedBreaksAndEntitiesOnlyInTheirFence() {
        String source = "```mermaid\nflowchart TD\nA[\"任务<br/>调度 &amp; 执行\"] --> B[完成]\n```";
        assertTrue(RenderedSelectionMatcher.matchesMermaidSource(source, "任务\n调度 & 执行"));
        assertTrue(RenderedSelectionMatcher.matchesMermaidSource(source, "任务调度 & 执行"));
        assertFalse(RenderedSelectionMatcher.matchesMermaidSource(source, "其他节点"));
        assertFalse(RenderedSelectionMatcher.matchesMermaidSource("普通段落 <br> 内容", "普通段落 内容"));
    }
    private static final String HTML = "<ol md-src-pos='0..200'>"
            + "<li md-src-pos='10..50'>缓存的idex/url等信息，应保存到数据库中，包括gpx</li>"
            + "<li md-src-pos='50..90'>增加允许导入导出数据库的功能</li>"
            + "<li md-src-pos='90..150'>数据库引入<strong>应用版本管理</strong>，支持根据新的数据架构自动升级</li>"
            + "</ol><p md-src-pos='200..230'>另一段无关内容</p>";

    @Test
    public void acceptsContiguousListTextWithoutInventingSpacesBetweenItems() {
        String quotation = "缓存的idex/url等信息，应保存到数据库中，包括gpx"
                + "增加允许导入导出数据库的功能数据库引入应用版本管理，支持根据新的数据架构自动升级";
        assertTrue(RenderedSelectionMatcher.matches(HTML, "md-src-pos", 10, 150, quotation));
        assertTrue(RenderedSelectionMatcher.matches(HTML, "md-src-pos", 10, 150,
                "包括gpx增加允许导入导出数据库的功能数据库引入应用版本管理"));
        assertTrue(RenderedSelectionMatcher.matches(HTML, "md-src-pos", 10, 150,
                "包括gpx\n增加允许导入导出数据库的功能\n数据库引入应用版本管理"));
    }

    @Test
    public void followsInlineDomTextOrderAndIgnoresGeneratedCheckboxesAndBreaks() {
        String html = "<li md-src-pos='0..40'><input type='checkbox'>先<strong>修改</strong>再<br>验证</li>";
        assertTrue(RenderedSelectionMatcher.matches(html, "md-src-pos", 0, 40, "先修改再验证"));
        assertFalse(RenderedSelectionMatcher.matches(html, "md-src-pos", 0, 40, "先再修改验证"));
    }

    @Test
    public void rejectsOutOfRangeTextAndDoesNotDuplicateNestedSourceNodes() {
        assertFalse(RenderedSelectionMatcher.matches(HTML, "md-src-pos", 10, 50, "增加允许导入"));
        assertFalse(RenderedSelectionMatcher.matches(HTML, "md-src-pos", 10, 150, "另一段无关内容"));
        assertFalse(RenderedSelectionMatcher.matches(HTML, "md-src-pos", 10, 150, "删除所有数据"));
        String html = "<p md-src-pos='0..40'>先<strong md-src-pos='1..9'>修改</strong>再验证</p>";
        assertTrue(RenderedSelectionMatcher.matches(html, "md-src-pos", 0, 40, "先修改再验证"));
        assertFalse(RenderedSelectionMatcher.matches(html, "md-src-pos", 0, 40, "修改再验证修改"));
    }

    private static final java.util.List<RenderedSelectionMatcher.DiagramRange> RANGES = java.util.List.of(
            new RenderedSelectionMatcher.DiagramRange(10, 40, "first"),
            new RenderedSelectionMatcher.DiagramRange(100, 140, "second"));

    @Test
    public void shiftsCachedDiagramRangesAfterPlainTextEdits() {
        var inserted = NativeMarkdownAnnotations.shiftDiagrams(RANGES, 0, 0, 5, "", "hello");
        assertEquals(15, inserted.get(0).start());
        assertEquals(45, inserted.get(0).end());
        assertEquals(105, inserted.get(1).start());
        assertEquals(145, inserted.get(1).end());

        var between = NativeMarkdownAnnotations.shiftDiagrams(RANGES, 50, 0, 5, "", "hello");
        assertEquals(10, between.get(0).start());
        assertEquals(105, between.get(1).start());

        var deleted = NativeMarkdownAnnotations.shiftDiagrams(RANGES, 0, 2, 0, "ab", "");
        assertEquals(8, deleted.get(0).start());
        assertEquals(98, deleted.get(1).start());
    }

    @Test
    public void keepsBoundaryInsertionsOutsideOrShiftingTheFence() {
        var atStart = NativeMarkdownAnnotations.shiftDiagrams(RANGES, 10, 0, 1, "", "x");
        assertEquals(11, atStart.get(0).start());
        assertEquals(41, atStart.get(0).end());

        var atEnd = NativeMarkdownAnnotations.shiftDiagrams(RANGES, 40, 0, 1, "", "x");
        assertEquals(10, atEnd.get(0).start());
        assertEquals(40, atEnd.get(0).end());
    }

    @Test
    public void overlappingOrFenceTouchingEditsRequireARescan() {
        assertNull(NativeMarkdownAnnotations.shiftDiagrams(RANGES, 20, 2, 2, "aa", "bb"));
        assertNull(NativeMarkdownAnnotations.shiftDiagrams(RANGES, 0, 0, 3, "", "```"));
        assertNull(NativeMarkdownAnnotations.shiftDiagrams(RANGES, 0, 0, 1, "", "~"));
        assertNull(NativeMarkdownAnnotations.shiftDiagrams(RANGES, 0, 0, 7, "", "Mermaid"));
        assertNull(NativeMarkdownAnnotations.shiftDiagrams(RANGES, 0, 3, 0, "```", ""));
    }

    @Test
    public void neverTreatsAnEmptyCacheAsUnchangedWhileAFenceMayBeTyped() {
        // Typing "mermaid" one character at a time never produces a fragment that
        // contains the full word, so an empty cache must always allow a rescan.
        assertNull(NativeMarkdownAnnotations.shiftDiagrams(java.util.List.of(), 0, 0, 1, "", "m"));
        assertNull(NativeMarkdownAnnotations.shiftDiagrams(java.util.List.of(), 0, 0, 1, "", "e"));
    }
}
