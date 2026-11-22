package com.github.claudecodegui.markdown;

import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

/**
 * Deep edge-case test suite for Mermaid diagram range parsing, shift calculation,
 * and rendered selection matching.
 */
public class RenderedSelectionMatcherDeepTest {

    @Test
    public void testFenceIndentationAndSyntaxVariants() {
        // Indentation 0 to 3 spaces is valid CommonMark fence
        String validFences = "```mermaid\ngraph TD\nA-->B\n```\n"
                           + " ~~~mermaid\ngraph LR\nC-->D\n~~~\n"
                           + "   ```mermaid\ngraph TB\nE-->F\n   ```\n";
        List<RenderedSelectionMatcher.DiagramRange> ranges = RenderedSelectionMatcher.mermaidRanges(validFences);
        assertEquals("0, 1, and 3-space indented fences must all be recognized", 3, ranges.size());

        // Indentation >= 4 spaces is an indented code block, NOT a fence
        String indentedBlock = "    ```mermaid\n    graph TD\n    A-->B\n    ```\n";
        List<RenderedSelectionMatcher.DiagramRange> noRanges = RenderedSelectionMatcher.mermaidRanges(indentedBlock);
        assertTrue("Indented code blocks (>= 4 spaces) must not be treated as diagrams", noRanges.isEmpty());
    }

    @Test
    public void testCaseInsensitivityAndExtraWhitespace() {
        String doc = "```  mermaid  \nflowchart TD\nX-->Y\n```\n";
        List<RenderedSelectionMatcher.DiagramRange> ranges = RenderedSelectionMatcher.mermaidRanges(doc);
        assertEquals(1, ranges.size());
        assertEquals("flowchart TD\nX-->Y", ranges.get(0).source());
    }

    @Test
    public void testThreeDiagramsInterleavedShifting() {
        var d1 = new RenderedSelectionMatcher.DiagramRange(10, 50, "diag1");
        var d2 = new RenderedSelectionMatcher.DiagramRange(100, 150, "diag2");
        var d3 = new RenderedSelectionMatcher.DiagramRange(200, 250, "diag3");
        List<RenderedSelectionMatcher.DiagramRange> initial = List.of(d1, d2, d3);

        // Edit between d1 and d2: insert 20 chars at offset 70
        var shifted = NativeMarkdownAnnotations.shiftDiagrams(initial, 70, 0, 20, "", "inserted-text-here!!");
        assertNotNull(shifted);
        assertEquals(3, shifted.size());

        // d1 is before edit: stays at 10..50
        assertEquals(10, shifted.get(0).start());
        assertEquals(50, shifted.get(0).end());

        // d2 is after edit: shifted by +20 -> 120..170
        assertEquals(120, shifted.get(1).start());
        assertEquals(170, shifted.get(1).end());

        // d3 is after edit: shifted by +20 -> 220..270
        assertEquals(220, shifted.get(2).start());
        assertEquals(270, shifted.get(2).end());

        // Next edit: delete 15 chars between d2 (120..170) and d3 (220..270) at offset 190
        var secondShift = NativeMarkdownAnnotations.shiftDiagrams(shifted, 190, 15, 0, "123456789012345", "");
        assertNotNull(secondShift);
        assertEquals(10, secondShift.get(0).start());
        assertEquals(120, secondShift.get(1).start());
        // d3 shifted by -15 -> 205..255
        assertEquals(205, secondShift.get(2).start());
        assertEquals(255, secondShift.get(2).end());
    }

    @Test
    public void testEditOverlappingOrTouchingFencesRequiresRescan() {
        var d1 = new RenderedSelectionMatcher.DiagramRange(50, 100, "content");
        List<RenderedSelectionMatcher.DiagramRange> list = List.of(d1);

        // Edit completely inside the diagram (e.g. at offset 70)
        assertNull("Edit inside diagram must require rescan",
                NativeMarkdownAnnotations.shiftDiagrams(list, 70, 2, 2, "aa", "bb"));

        // Edit overlapping the start boundary (e.g. 45..55)
        assertNull("Edit overlapping start must require rescan",
                NativeMarkdownAnnotations.shiftDiagrams(list, 45, 10, 5, "0123456789", "short"));

        // Edit overlapping the end boundary (e.g. 95..105)
        assertNull("Edit overlapping end must require rescan",
                NativeMarkdownAnnotations.shiftDiagrams(list, 95, 10, 5, "0123456789", "short"));

        // Inserting backtick or tilde anywhere in document
        assertNull(NativeMarkdownAnnotations.shiftDiagrams(list, 10, 0, 1, "", "`"));
        assertNull(NativeMarkdownAnnotations.shiftDiagrams(list, 10, 0, 1, "", "~"));
        assertNull(NativeMarkdownAnnotations.shiftDiagrams(list, 10, 0, 7, "", "mermaid"));
    }

    @Test
    public void testComplexHtmlEntitiesAndLineBreaksInLabels() {
        String source = "```mermaid\n"
                      + "graph LR\n"
                      + "A[\"用户 &amp; 密码<br/>验证模块\"] --> B[\"数据库 &lt;主从&gt;\"]\n"
                      + "```";

        assertTrue(RenderedSelectionMatcher.matchesMermaidSource(source, "用户 & 密码\n验证模块"));
        assertTrue(RenderedSelectionMatcher.matchesMermaidSource(source, "用户 & 密码 验证模块"));
        assertTrue(RenderedSelectionMatcher.matchesMermaidSource(source, "数据库 <主从>"));
        assertFalse(RenderedSelectionMatcher.matchesMermaidSource(source, "不存在的节点"));
    }
}
