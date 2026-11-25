package com.github.claudecodegui.markdown;

import org.jsoup.Jsoup;
import org.jsoup.nodes.Element;
import org.jsoup.nodes.TextNode;
import org.jsoup.select.NodeTraversor;

/** Validates quotations only against IDE-generated HTML inside the source range. */
final class RenderedSelectionMatcher {
    private RenderedSelectionMatcher() {}

    record DiagramRange(int start, int end, String source) {}

    static java.util.List<DiagramRange> mermaidRanges(String markdown) {
        java.util.List<DiagramRange> ranges = new java.util.ArrayList<>();
        // Skip entire non-Mermaid fences too, so nested example fences are not diagrams.
        var opening = java.util.regex.Pattern.compile("(?m)^ {0,3}(`{3,}|~{3,})([^\\r\\n]*)\\R").matcher(markdown);
        int offset = 0;
        while (opening.find(offset)) {
            String fence = opening.group(1);
            var closing = java.util.regex.Pattern.compile("(?m)^ {0,3}" + fence.charAt(0)
                    + "{" + fence.length() + ",}[ \\t]*(?:\\R|$)").matcher(markdown);
            if (!closing.find(opening.end())) {
                break;
            }
            if (opening.group(2).strip().equals("mermaid")) {
                ranges.add(new DiagramRange(opening.start(), closing.end(),
                        markdown.substring(opening.end(), closing.start()).replace("\r\n", "\n").strip()));
            }
            offset = closing.end();
        }
        return ranges;
    }

    /** Mermaid labels are generated after Markdown HTML, including HTML line breaks/entities. */
    static boolean matchesMermaidSource(String source, String selected) {
        if (selected.isBlank() || !source.stripLeading().matches(
                "(?s)(?:`{3,}|~{3,})mermaid\\b.*")) {
            return false;
        }
        String labels = Jsoup.parseBodyFragment(source.replaceAll("(?i)<br\\s*/?>", " ")).text();
        String joinedLabels = Jsoup.parseBodyFragment(source.replaceAll("(?i)<br\\s*/?>", "")).text();
        return normalize(labels).contains(normalize(selected)) || normalize(joinedLabels).contains(normalize(selected));
    }

    static boolean matches(String html, String attribute, int start, int end, String selected) {
        if (!attribute.matches("[a-zA-Z0-9_-]+") || selected.isBlank() || start < 0 || end <= start) {
            return false;
        }
        Element root = Jsoup.parseBodyFragment(html).body();
        StringBuilder joined = new StringBuilder();
        StringBuilder separated = new StringBuilder();
        for (Element element : root.getElementsByAttribute(attribute)) {
            if (!withinRange(element, attribute, start, end)) {
                continue;
            }
            if (element.parents().stream().anyMatch(parent -> withinRange(parent, attribute, start, end))) {
                continue;
            }
            StringBuilder text = new StringBuilder();
            // DOM Range.toString() concatenates text nodes: list numbers,
            // checkboxes and <br> do not insert characters into that string.
            NodeTraversor.traverse((node, depth) -> {
                if (node instanceof TextNode) {
                    text.append(((TextNode) node).getWholeText());
                }
            }, element);
            joined.append(text);
            separated.append(text).append(' ');
        }
        String quote = normalize(selected);
        return normalize(joined.toString()).contains(quote) || normalize(separated.toString()).contains(quote);
    }

    private static boolean withinRange(Element element, String attribute, int start, int end) {
        String value = element.attr(attribute);
        if (!value.matches("[0-9]+\\.\\.[0-9]+")) {
            return false;
        }
        String[] offsets = value.split("\\.\\.");
        long from = Long.parseLong(offsets[0]);
        long to = Long.parseLong(offsets[1]);
        return from >= start && to <= end && to > from;
    }

    private static String normalize(String text) {
        return text.replaceAll("(?U)\\s+", " ").trim();
    }
}
