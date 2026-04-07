package com.github.claudecodegui.approval;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.intellij.icons.AllIcons;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.actionSystem.ActionGroup;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.DefaultActionGroup;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.EditorCustomElementRenderer;
import com.intellij.openapi.editor.Inlay;
import com.intellij.openapi.editor.colors.EditorFontType;
import com.intellij.openapi.editor.colors.EditorColorsScheme;
import com.intellij.openapi.editor.event.EditorMouseEvent;
import com.intellij.openapi.editor.event.EditorMouseEventArea;
import com.intellij.openapi.editor.event.EditorMouseListener;
import com.intellij.openapi.editor.markup.GutterIconRenderer;
import com.intellij.openapi.editor.markup.HighlighterLayer;
import com.intellij.openapi.editor.markup.HighlighterTargetArea;
import com.intellij.openapi.editor.markup.RangeHighlighter;
import com.intellij.openapi.editor.markup.TextAttributes;
import com.intellij.openapi.project.DumbAwareAction;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.popup.JBPopupFactory;
import com.intellij.ui.JBColor;
import com.intellij.util.ui.JBUI;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.Icon;
import java.awt.Color;
import java.awt.Component;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.Point;
import java.awt.Rectangle;
import java.awt.RenderingHints;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Applies inline hunk decorations and actions inside source editors.
 */
public final class InlineFileChangeDecorator implements Disposable {

    private static final Logger LOG = Logger.getInstance(InlineFileChangeDecorator.class);

    private static final TextAttributes ADDED_ATTRIBUTES = new TextAttributes(
            null,
            new JBColor(new Color(187, 247, 208), new Color(17, 94, 60)),
            null,
            null,
            Font.PLAIN
    );
    private static final TextAttributes MODIFIED_ATTRIBUTES = new TextAttributes(
            null,
            new JBColor(new Color(209, 250, 229), new Color(6, 78, 59)),
            null,
            null,
            Font.PLAIN
    );

    private final Project project;
    private final PendingFileChangeApprovalService approvalService;
    private final Map<Editor, DecorationState> decorationStates = new IdentityHashMap<>();
    private volatile boolean refreshAllPending;

    public InlineFileChangeDecorator(
            @NotNull Project project,
            @NotNull PendingFileChangeApprovalService approvalService
    ) {
        this.project = project;
        this.approvalService = approvalService;
    }

    public void refreshAll() {
        refreshAllWithCallback(null);
    }

    public void refreshAllWithCallback(@Nullable Runnable afterRefresh) {
        if (refreshAllPending) {
            // A refresh is already pending.  If a callback was given, schedule
            // it to run after the pending refresh completes.
            if (afterRefresh != null) {
                ApplicationManager.getApplication().invokeLater(afterRefresh);
            }
            return;
        }
        refreshAllPending = true;
        ApplicationManager.getApplication().invokeLater(() -> {
            refreshAllPending = false;
            if (project.isDisposed()) {
                if (afterRefresh != null) afterRefresh.run();
                return;
            }

            Map<String, PendingFileChangeApprovalService.PendingFileChange> snapshot =
                    approvalService.getPendingChangesSnapshot();

            // Clear stale editors
            List<Editor> staleEditors = new ArrayList<>();
            for (Map.Entry<Editor, DecorationState> entry : decorationStates.entrySet()) {
                Editor editor = entry.getKey();
                DecorationState state = entry.getValue();
                if (editor.isDisposed() || !snapshot.containsKey(state.filePath)) {
                    staleEditors.add(editor);
                }
            }
            for (Editor editor : staleEditors) {
                clearEditor(editor);
            }

            // Refresh each file inline — per-file X of N
            for (Map.Entry<String, PendingFileChangeApprovalService.PendingFileChange> entry : snapshot.entrySet()) {
                String filePath = entry.getKey();
                PendingFileChangeApprovalService.PendingFileChange fileChange = entry.getValue();
                clearEditorsForFile(filePath);
                if (fileChange.isConflicted() || fileChange.getPendingHunks().isEmpty()) {
                    continue;
                }
                int fileHunkTotal = fileChange.getPendingHunkCount();
                for (Editor editor : approvalService.findEditorsForFile(filePath)) {
                    applyDecorations(editor, fileChange, fileHunkTotal);
                }
            }

            // Run callback after all decorations are cleaned up and re-applied
            if (afterRefresh != null) {
                afterRefresh.run();
            }
        });
    }

    public void refreshFile(@NotNull String filePath) {
        if (refreshAllPending) {
            return; // refreshAll will handle it
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (project.isDisposed()) {
                return;
            }

            PendingFileChangeApprovalService.PendingFileChange fileChange =
                    approvalService.getPendingForFile(filePath);
            clearEditorsForFile(filePath);
            if (fileChange == null || fileChange.isConflicted() || fileChange.getPendingHunks().isEmpty()) {
                return;
            }

            int fileHunkTotal = fileChange.getPendingHunkCount();
            for (Editor editor : approvalService.findEditorsForFile(filePath)) {
                applyDecorations(editor, fileChange, fileHunkTotal);
            }
        });
    }

    private void applyDecorations(
            @NotNull Editor editor,
            @NotNull PendingFileChangeApprovalService.PendingFileChange fileChange,
            int fileHunkTotal
    ) {
        DecorationState state = new DecorationState(fileChange.getFilePath());
        Document document = editor.getDocument();
        List<InlineDiffHunk> hunks = fileChange.getPendingHunks();
        for (int hunkIdx = 0; hunkIdx < hunks.size(); hunkIdx++) {
            InlineDiffHunk hunk = hunks.get(hunkIdx);
            int anchorOffset = computeAnchorOffset(document, hunk);

            // 1. Create deleted line inlays (one per deleted line, no cap)
            // Priority determines rendering order for showAbove=true block inlays:
            // higher priority = closer to text line (bottommost).
            // We want line 0 at top (lowest priority) progressing to last line
            // nearest the real text (highest priority).
            if (hunk.hasBeforeLines()) {
                // Use inner diff to filter out context lines that exist in both
                // before and after text (introduced by hunk merging).  Only truly
                // deleted lines are shown as red inlays.
                List<String> deletedLines = computeTrulyDeletedLines(hunk);
                for (int i = 0; i < deletedLines.size(); i++) {
                    DeletedLineRenderer renderer = new DeletedLineRenderer(deletedLines.get(i));
                    int priority = 50 + i;
                    Inlay<?> inlay = editor.getInlayModel().addBlockElement(
                            anchorOffset, false, true, priority, renderer
                    );
                    if (inlay != null) {
                        state.allInlays.add(inlay);
                    }
                }
            }

            // 2. Create action bar inlay (per-file X of N)
            HunkActionBarRenderer actionRenderer = new HunkActionBarRenderer(
                    approvalService, fileChange, hunk,
                    hunkIdx, fileHunkTotal
            );
            Inlay<?> actionInlay = editor.getInlayModel().addBlockElement(
                    anchorOffset, false, true, 10, actionRenderer
            );
            if (actionInlay != null) {
                state.allInlays.add(actionInlay);
                state.actionInlays.put(actionInlay, actionRenderer);
            }

            // 3. Create range highlighter for added/modified lines
            RangeHighlighter highlighter = createHighlighter(editor, document, hunk);
            if (highlighter != null) {
                state.highlighters.add(highlighter);
            }
        }

        EditorMouseListener listener = new EditorMouseListener() {
            @Override
            public void mousePressed(@NotNull EditorMouseEvent event) {
                if (event.getArea() != EditorMouseEventArea.EDITING_AREA) {
                    LOG.info("[mousePressed] Ignored: area=" + event.getArea());
                    return;
                }
                DecorationState currentState = decorationStates.get(editor);
                if (currentState == null) {
                    LOG.info("[mousePressed] Ignored: no decoration state for editor");
                    return;
                }

                Point point = event.getMouseEvent().getPoint();
                for (Map.Entry<Inlay<?>, HunkActionBarRenderer> entry : currentState.actionInlays.entrySet()) {
                    Inlay<?> inlay = entry.getKey();
                    Rectangle bounds = inlay.getBounds();
                    if (bounds == null || !bounds.contains(point)) {
                        LOG.info("[mousePressed] Inlay miss: point=" + point + " bounds=" + bounds);
                        continue;
                    }
                    InlineAction action = entry.getValue().findAction(editor, bounds, point);
                    if (action != null) {
                        LOG.info("[mousePressed] HIT action=" + action);
                        event.getMouseEvent().consume();
                        entry.getValue().perform(action);
                    } else {
                        LOG.info("[mousePressed] Inside inlay bounds but no action box hit, point=" + point);
                    }
                    return;
                }
            }
        };
        editor.addEditorMouseListener(listener);
        state.mouseListener = listener;
        decorationStates.put(editor, state);
    }

    @Nullable
    private RangeHighlighter createHighlighter(
            @NotNull Editor editor,
            @NotNull Document document,
            @NotNull InlineDiffHunk hunk
    ) {
        if (!hunk.hasAfterLines() || document.getLineCount() == 0) {
            return null;
        }

        int maxLine = Math.max(0, document.getLineCount() - 1);
        // For MODIFIED hunks produced by merging (which include context lines in both
        // beforeText and afterText), find the actual changed line range inside the hunk
        // via an inner diff so we don't highlight unchanged context lines in green.
        int rawStart = hunk.getAfterStartLine();
        int rawEnd = hunk.getAfterEndLineExclusive(); // exclusive
        if (hunk.getType() == InlineDiffHunk.Type.MODIFIED
                && !hunk.getBeforeText().isEmpty() && !hunk.getAfterText().isEmpty()) {
            int[] changedRange = computeChangedAfterRange(hunk);
            if (changedRange != null) {
                rawStart = hunk.getAfterStartLine() + changedRange[0];
                rawEnd   = hunk.getAfterStartLine() + changedRange[1]; // exclusive
            }
        }
        int startLine = Math.max(0, Math.min(rawStart, maxLine));
        int endLine = Math.max(startLine, Math.min(rawEnd - 1, maxLine));
        int startOffset = document.getLineStartOffset(startLine);
        int endOffset = document.getLineEndOffset(endLine);
        if (endOffset < startOffset) {
            endOffset = startOffset;
        }

        TextAttributes attributes = hunk.getType() == InlineDiffHunk.Type.ADDED
                ? ADDED_ATTRIBUTES
                : MODIFIED_ATTRIBUTES;
        RangeHighlighter highlighter = editor.getMarkupModel().addRangeHighlighter(
                startOffset,
                endOffset,
                HighlighterLayer.SELECTION - 10,
                attributes,
                HighlighterTargetArea.LINES_IN_RANGE
        );
        highlighter.setErrorStripeMarkColor(hunk.getType() == InlineDiffHunk.Type.ADDED
                ? new JBColor(new Color(22, 163, 74), new Color(74, 222, 128))
                : new JBColor(new Color(5, 150, 105), new Color(52, 211, 153)));
        highlighter.setThinErrorStripeMark(true);
        return highlighter;
    }

    private int computeAnchorOffset(@NotNull Document document, @NotNull InlineDiffHunk hunk) {
        if (document.getTextLength() == 0 || document.getLineCount() == 0) {
            return 0;
        }

        if (hunk.hasAfterLines()) {
            int line = Math.max(0, Math.min(hunk.getAfterStartLine(), document.getLineCount() - 1));
            return document.getLineStartOffset(line);
        }

        int line = Math.max(0, Math.min(hunk.getAfterStartLine(), document.getLineCount() - 1));
        return document.getLineStartOffset(line);
    }

    /**
     * For a MODIFIED hunk that contains context lines (produced by hunk merging),
     * compute the [start, end) line range (relative to hunk.afterStartLine) that
     * is actually changed (ADDED or MODIFIED in the inner diff).
     * Returns null if the entire after range is changed (no narrowing needed).
     */
    @Nullable
    private static int[] computeChangedAfterRange(@NotNull InlineDiffHunk hunk) {
        List<InlineDiffHunk> innerDiff = InlineDiffUtil.computeHunks(
                hunk.getBeforeText(), hunk.getAfterText());
        if (innerDiff.isEmpty()) {
            return null;
        }
        int minStart = Integer.MAX_VALUE;
        int maxEnd = Integer.MIN_VALUE;
        for (InlineDiffHunk inner : innerDiff) {
            if (inner.getType() == InlineDiffHunk.Type.ADDED
                    || inner.getType() == InlineDiffHunk.Type.MODIFIED) {
                minStart = Math.min(minStart, inner.getAfterStartLine());
                maxEnd   = Math.max(maxEnd,   inner.getAfterEndLineExclusive());
            }
        }
        if (minStart == Integer.MAX_VALUE) {
            return null;
        }
        return new int[]{minStart, maxEnd};
    }

    /**
     * Compute truly deleted lines by running an inner diff between hunk's before
     * and after text.  This filters out context lines that were included in both
     * sides during hunk merging (e.g. a closing brace that the LCS matched in the
     * middle of a continuous edit block).
     */
    @NotNull
    private static List<String> computeTrulyDeletedLines(@NotNull InlineDiffHunk hunk) {
        List<InlineDiffHunk> innerDiff = InlineDiffUtil.computeHunks(
                hunk.getBeforeText(), hunk.getAfterText());
        List<String> result = new ArrayList<>();
        for (InlineDiffHunk inner : innerDiff) {
            if (inner.getType() == InlineDiffHunk.Type.DELETED) {
                // Pure deletion: all before lines are truly gone.
                result.addAll(InlineDiffUtil.splitLines(inner.getBeforeText()));
            } else if (inner.getType() == InlineDiffHunk.Type.MODIFIED) {
                // The LCS found no line-level match inside this section.
                // Use multiset subtraction: a before-line is truly deleted only if it
                // has no corresponding line in the after text (handles duplicates correctly).
                // This filters out context lines that the hunk merge may have included on
                // the before side but that still exist somewhere in the after text.
                List<String> beforeLines = InlineDiffUtil.splitLines(inner.getBeforeText());
                List<String> afterPool = new ArrayList<>(InlineDiffUtil.splitLines(inner.getAfterText()));
                for (String line : beforeLines) {
                    if (!afterPool.remove(line)) {
                        result.add(line);
                    }
                }
            }
        }
        return result;
    }

    private void clearEditorsForFile(@NotNull String filePath) {
        List<Editor> editors = new ArrayList<>();
        for (Map.Entry<Editor, DecorationState> entry : decorationStates.entrySet()) {
            if (entry.getValue().filePath.equals(filePath)) {
                editors.add(entry.getKey());
            }
        }
        for (Editor editor : editors) {
            clearEditor(editor);
        }
    }

    private void clearEditor(@NotNull Editor editor) {
        DecorationState state = decorationStates.remove(editor);
        if (state == null) {
            return;
        }
        if (state.mouseListener != null && !editor.isDisposed()) {
            editor.removeEditorMouseListener(state.mouseListener);
        }
        for (RangeHighlighter highlighter : state.highlighters) {
            if (highlighter.isValid()) {
                editor.getMarkupModel().removeHighlighter(highlighter);
            }
        }
        for (Inlay<?> inlay : state.allInlays) {
            if (inlay.isValid()) {
                inlay.dispose();
            }
        }
    }

    @Override
    public void dispose() {
        List<Editor> editors = new ArrayList<>(decorationStates.keySet());
        for (Editor editor : editors) {
            clearEditor(editor);
        }
        decorationStates.clear();
    }

    // ── Data structures ──────────────────────────────────────────────────

    private static final class DecorationState {
        private final String filePath;
        private final List<RangeHighlighter> highlighters = new ArrayList<>();
        private final List<Inlay<?>> allInlays = new ArrayList<>();
        private final Map<Inlay<?>, HunkActionBarRenderer> actionInlays = new LinkedHashMap<>();
        private EditorMouseListener mouseListener;

        private DecorationState(@NotNull String filePath) {
            this.filePath = filePath;
        }
    }

    private enum InlineAction {
        ACCEPT,
        REJECT,
        PREV_HUNK,
        NEXT_HUNK,
        OPEN_DIFF,
        /** Non-interactive display label — rendered as plain text, not a button. */
        POSITION_TEXT
    }

    private static final class ActionBox {
        private final InlineAction action;
        private final String label;
        private final Rectangle bounds;

        private ActionBox(@NotNull InlineAction action, @NotNull String label, @NotNull Rectangle bounds) {
            this.action = action;
            this.label = label;
            this.bounds = bounds;
        }
    }

    // ── Renderers ────────────────────────────────────────────────────────

    /**
     * Renders a single deleted line as a red-background editor-like line.
     * One instance per deleted line — no card chrome, no borders, no labels.
     */
    private static final class DeletedLineRenderer implements EditorCustomElementRenderer {

        private static final Color DELETED_BG = new JBColor(new Color(254, 226, 226), new Color(80, 20, 20));
        private static final Color DELETED_FG = new JBColor(new Color(153, 27, 27), new Color(254, 202, 202));

        private final String lineText;

        private DeletedLineRenderer(@NotNull String lineText) {
            this.lineText = lineText;
        }

        @Override
        public int calcWidthInPixels(@NotNull Inlay inlay) {
            Editor editor = inlay.getEditor();
            int visibleWidth = editor.getScrollingModel().getVisibleArea().width;
            int contentWidth = editor.getContentComponent().getWidth();
            int w = Math.max(visibleWidth, contentWidth);
            return Math.max(JBUI.scale(220), w > 0 ? w : JBUI.scale(360));
        }

        @Override
        public int calcHeightInPixels(@NotNull Inlay inlay) {
            return inlay.getEditor().getLineHeight();
        }

        @Override
        public void paint(
                @NotNull Inlay inlay,
                @NotNull Graphics graphics,
                @NotNull Rectangle targetRegion,
                @NotNull TextAttributes textAttributes
        ) {
            Editor editor = inlay.getEditor();
            Graphics2D g = (Graphics2D) graphics.create();
            try {
                g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);

                // Red background full-width
                g.setColor(DELETED_BG);
                g.fillRect(targetRegion.x, targetRegion.y, targetRegion.width, targetRegion.height);

                // Draw line text using editor font, aligned with editor content.
                // Expand tabs to spaces so indentation matches the real editor lines
                // (g.drawString renders tabs as zero-width, causing misalignment).
                EditorColorsScheme colorScheme = editor.getColorsScheme();
                Font font = colorScheme.getFont(EditorFontType.PLAIN);
                g.setFont(font);
                g.setColor(DELETED_FG);
                FontMetrics metrics = g.getFontMetrics();
                int textY = targetRegion.y
                        + ((targetRegion.height - metrics.getHeight()) / 2)
                        + metrics.getAscent();
                int tabSize = editor.getSettings().getTabSize(null);
                String rendered = expandTabs(lineText, tabSize > 0 ? tabSize : 4);
                g.drawString(rendered, targetRegion.x, textY);
            } finally {
                g.dispose();
            }
        }

        /**
         * Expand tab characters to spaces matching the editor's tab stop positions.
         */
        @NotNull
        private static String expandTabs(@NotNull String text, int tabSize) {
            if (text.indexOf('\t') < 0) {
                return text;
            }
            StringBuilder sb = new StringBuilder(text.length() + 16);
            int column = 0;
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                if (c == '\t') {
                    int spaces = tabSize - (column % tabSize);
                    for (int j = 0; j < spaces; j++) {
                        sb.append(' ');
                    }
                    column += spaces;
                } else {
                    sb.append(c);
                    column++;
                }
            }
            return sb.toString();
        }
    }

    /**
     * Cursor-style single-line action bar for one hunk.
     * Layout: [∧] [X of Y] [∨]    [Undo]  [Keep]
     */
    private static final class HunkActionBarRenderer implements EditorCustomElementRenderer {

        private static final int PADDING_X = JBUI.scale(6);
        private static final int BUTTON_HEIGHT = JBUI.scale(18);
        private static final int BUTTON_PADDING = JBUI.scale(7);
        private static final int ACTION_GAP = JBUI.scale(6);
        private static final Color SEPARATOR_COLOR = new JBColor(
                new Color(226, 232, 240), new Color(51, 65, 85)
        );

        private final PendingFileChangeApprovalService approvalService;
        private final String filePath;
        private final String fileName;
        private final InlineDiffHunk hunk;
        private final int hunkIndex; // 0-based, per-file
        private final int hunkTotal; // total hunks in this file

        private HunkActionBarRenderer(
                @NotNull PendingFileChangeApprovalService approvalService,
                @NotNull PendingFileChangeApprovalService.PendingFileChange fileChange,
                @NotNull InlineDiffHunk hunk,
                int hunkIndex,
                int hunkTotal
        ) {
            this.approvalService = approvalService;
            this.filePath = fileChange.getFilePath();
            this.fileName = fileChange.getFileName();
            this.hunk = hunk;
            this.hunkIndex = hunkIndex;
            this.hunkTotal = hunkTotal;
        }

        @Override
        public int calcWidthInPixels(@NotNull Inlay inlay) {
            Editor editor = inlay.getEditor();
            int visibleWidth = editor.getScrollingModel().getVisibleArea().width;
            int contentWidth = editor.getContentComponent().getWidth();
            int w = Math.max(visibleWidth, contentWidth);
            return Math.max(JBUI.scale(220), w > 0 ? w : JBUI.scale(360));
        }

        @Override
        public int calcHeightInPixels(@NotNull Inlay inlay) {
            return inlay.getEditor().getLineHeight();
        }

        @Override
        public void paint(
                @NotNull Inlay inlay,
                @NotNull Graphics graphics,
                @NotNull Rectangle targetRegion,
                @NotNull TextAttributes textAttributes
        ) {
            Editor editor = inlay.getEditor();
            Graphics2D g = (Graphics2D) graphics.create();
            try {
                g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                EditorColorsScheme colorScheme = editor.getColorsScheme();
                Font font = colorScheme.getFont(EditorFontType.PLAIN);
                g.setFont(font);

                // Editor background
                g.setColor(colorScheme.getDefaultBackground());
                g.fillRect(targetRegion.x, targetRegion.y, targetRegion.width, targetRegion.height);

                // 1px separator line at top
                g.setColor(SEPARATOR_COLOR);
                g.fillRect(targetRegion.x, targetRegion.y, targetRegion.width, 1);

                // Cursor-style action buttons: [∧] [X of Y] [∨]    [Undo]  [Keep]
                for (ActionBox actionBox : computeActionBoxes(editor, targetRegion)) {
                    paintActionButton(g, actionBox);
                }
            } finally {
                g.dispose();
            }
        }

        @Nullable
        InlineAction findAction(@NotNull Editor editor, @NotNull Rectangle bounds, @NotNull Point point) {
            for (ActionBox actionBox : computeActionBoxes(editor, bounds)) {
                if (actionBox.bounds.contains(point)) {
                    return actionBox.action;
                }
            }
            return null;
        }

        void perform(@NotNull InlineAction action) {
            ApplicationManager.getApplication().invokeLater(() -> {
                switch (action) {
                    case ACCEPT -> approvalService.approveHunk(filePath, hunk.getHunkId());
                    case REJECT -> approvalService.rejectHunk(filePath, hunk.getHunkId());
                    case PREV_HUNK -> approvalService.activatePrevHunk(filePath, hunk.getHunkId());
                    case NEXT_HUNK -> approvalService.activateNextHunk(filePath, hunk.getHunkId());
                    case OPEN_DIFF -> approvalService.openFullDiff(filePath);
                    case POSITION_TEXT -> approvalService.scrollToHunk(filePath, hunk.getHunkId());
                }
            });
        }

        @Override
        public @Nullable GutterIconRenderer calcGutterIconRenderer(@NotNull Inlay inlay) {
            return new InlineHunkGutterRenderer(approvalService, filePath, fileName, hunk);
        }

        @NotNull
        private List<ActionBox> computeActionBoxes(@NotNull Editor editor, @NotNull Rectangle bounds) {
            Font font = editor.getColorsScheme().getFont(EditorFontType.PLAIN);
            FontMetrics metrics = editor.getContentComponent().getFontMetrics(font);
            int buttonY = bounds.y + ((bounds.height - BUTTON_HEIGHT) / 2);

            // Cursor-style layout:
            //   single hunk in file:  [1 of 1]    [Undo]  [Keep]
            //   multi hunk in file:   [▲] [X of N] [▼]    [Undo]  [Keep]
            // Position text shows per-file hunk index; arrows only shown when file has >1 hunk.
            int x = bounds.x + PADDING_X;

            List<ActionBox> boxes = new ArrayList<>();
            if (hunkTotal > 1) {
                x = addAction(boxes, InlineAction.PREV_HUNK, ClaudeCodeGuiBundle.message("diff.inline.prevHunk"), x, buttonY, metrics);
            }
            x = addAction(boxes, InlineAction.POSITION_TEXT,
                    ClaudeCodeGuiBundle.message("diff.inline.hunkPosition", hunkIndex + 1, hunkTotal),
                    x, buttonY, metrics);
            if (hunkTotal > 1) {
                x = addAction(boxes, InlineAction.NEXT_HUNK, ClaudeCodeGuiBundle.message("diff.inline.nextHunk"), x, buttonY, metrics);
            }
            x += ACTION_GAP * 2; // extra gap before action buttons
            x = addAction(boxes, InlineAction.REJECT, ClaudeCodeGuiBundle.message("diff.inline.reject"), x, buttonY, metrics);
            x = addAction(boxes, InlineAction.ACCEPT, ClaudeCodeGuiBundle.message("diff.inline.accept"), x, buttonY, metrics);
            return boxes;
        }

        private int addAction(
                @NotNull List<ActionBox> boxes,
                @NotNull InlineAction action,
                @NotNull String label,
                int leftEdge,
                int y,
                @NotNull FontMetrics metrics
        ) {
            int width = metrics.stringWidth(label) + (BUTTON_PADDING * 2);
            Rectangle rect = new Rectangle(leftEdge, y, width, BUTTON_HEIGHT);
            boxes.add(new ActionBox(action, label, rect));
            return leftEdge + width + ACTION_GAP;
        }

        private void paintActionButton(@NotNull Graphics2D g, @NotNull ActionBox actionBox) {
            if (actionBox.action == InlineAction.POSITION_TEXT) {
                // Clickable position label — subtle underline hint
                g.setColor(new JBColor(new Color(71, 85, 105), new Color(148, 163, 184)));
                FontMetrics fm = g.getFontMetrics();
                int textX = actionBox.bounds.x + BUTTON_PADDING;
                int textY = actionBox.bounds.y
                        + ((actionBox.bounds.height - fm.getHeight()) / 2)
                        + fm.getAscent();
                g.drawString(actionBox.label, textX, textY);
                // Dotted underline to hint interactivity
                int underlineY = textY + 2;
                int textWidth = fm.stringWidth(actionBox.label);
                g.setColor(new JBColor(new Color(148, 163, 184, 160), new Color(100, 116, 139, 160)));
                for (int dx = 0; dx < textWidth; dx += 3) {
                    g.fillRect(textX + dx, underlineY, 1, 1);
                }
                return;
            }

            Color background = switch (actionBox.action) {
                case ACCEPT -> new JBColor(new Color(22, 163, 74, 220), new Color(34, 197, 94, 205));
                case REJECT -> new JBColor(new Color(239, 68, 68, 220), new Color(248, 113, 113, 205));
                default -> new JBColor(new Color(226, 232, 240, 210), new Color(71, 85, 105, 205));
            };
            Color foreground = switch (actionBox.action) {
                case ACCEPT -> new JBColor(new Color(255, 255, 255), new Color(20, 83, 45));
                case REJECT -> new JBColor(new Color(255, 255, 255), new Color(127, 29, 29));
                default -> new JBColor(new Color(51, 65, 85), new Color(226, 232, 240));
            };

            g.setColor(background);
            g.fillRoundRect(
                    actionBox.bounds.x, actionBox.bounds.y,
                    actionBox.bounds.width, actionBox.bounds.height,
                    JBUI.scale(8), JBUI.scale(8)
            );
            g.setColor(foreground);
            int textY = actionBox.bounds.y
                    + ((actionBox.bounds.height - g.getFontMetrics().getHeight()) / 2)
                    + g.getFontMetrics().getAscent();
            g.drawString(actionBox.label, actionBox.bounds.x + BUTTON_PADDING, textY);
        }
    }

    // ── Gutter icon ──────────────────────────────────────────────────────

    private static final class InlineHunkGutterRenderer extends GutterIconRenderer {
        private static final Icon MENU_ICON = new DotIcon();

        private final PendingFileChangeApprovalService approvalService;
        private final String filePath;
        private final String fileName;
        private final String hunkId;

        private InlineHunkGutterRenderer(
                @NotNull PendingFileChangeApprovalService approvalService,
                @NotNull PendingFileChangeApprovalService.PendingFileChange fileChange,
                @NotNull InlineDiffHunk hunk
        ) {
            this(approvalService, fileChange.getFilePath(), fileChange.getFileName(), hunk);
        }

        private InlineHunkGutterRenderer(
                @NotNull PendingFileChangeApprovalService approvalService,
                @NotNull String filePath,
                @NotNull String fileName,
                @NotNull InlineDiffHunk hunk
        ) {
            this.approvalService = approvalService;
            this.filePath = filePath;
            this.fileName = fileName;
            this.hunkId = hunk.getHunkId();
        }

        @Override
        public @NotNull Icon getIcon() {
            return MENU_ICON;
        }

        @Override
        public @Nullable String getTooltipText() {
            return ClaudeCodeGuiBundle.message("diff.inline.gutterTooltip", fileName);
        }

        @Override
        public @Nullable AnAction getClickAction() {
            return new DumbAwareAction() {
                @Override
                public void actionPerformed(@NotNull AnActionEvent e) {
                    ActionGroup group = buildActionGroup();
                    JBPopupFactory.getInstance()
                            .createActionGroupPopup(
                                    null,
                                    group,
                                    e.getDataContext(),
                                    JBPopupFactory.ActionSelectionAid.SPEEDSEARCH,
                                    true
                            )
                            .showInBestPositionFor(e.getDataContext());
                }
            };
        }

        @Override
        public @Nullable ActionGroup getPopupMenuActions() {
            return buildActionGroup();
        }

        @Override
        public boolean equals(Object obj) {
            if (this == obj) return true;
            if (!(obj instanceof InlineHunkGutterRenderer that)) return false;
            return Objects.equals(filePath, that.filePath)
                    && Objects.equals(fileName, that.fileName)
                    && Objects.equals(hunkId, that.hunkId);
        }

        @Override
        public int hashCode() {
            return Objects.hash(filePath, fileName, hunkId);
        }

        @NotNull
        private ActionGroup buildActionGroup() {
            DefaultActionGroup group = new DefaultActionGroup();
            group.add(new DumbAwareAction(
                    ClaudeCodeGuiBundle.message("diff.inline.accept"),
                    null,
                    AllIcons.Actions.Checked
            ) {
                @Override
                public void actionPerformed(@NotNull AnActionEvent e) {
                    approvalService.approveHunk(filePath, hunkId);
                }
            });
            group.add(new DumbAwareAction(
                    ClaudeCodeGuiBundle.message("diff.inline.reject"),
                    null,
                    AllIcons.Actions.Cancel
            ) {
                @Override
                public void actionPerformed(@NotNull AnActionEvent e) {
                    approvalService.rejectHunk(filePath, hunkId);
                }
            });
            group.addSeparator();
            group.add(new DumbAwareAction(
                    ClaudeCodeGuiBundle.message("diff.inline.prevHunk"),
                    null,
                    AllIcons.Actions.PreviousOccurence
            ) {
                @Override
                public void actionPerformed(@NotNull AnActionEvent e) {
                    approvalService.activatePrevHunk(filePath, hunkId);
                }
            });
            group.add(new DumbAwareAction(
                    ClaudeCodeGuiBundle.message("diff.inline.nextHunk"),
                    null,
                    AllIcons.Actions.NextOccurence
            ) {
                @Override
                public void actionPerformed(@NotNull AnActionEvent e) {
                    approvalService.activateNextHunk(filePath, hunkId);
                }
            });
            group.addSeparator();
            group.add(new DumbAwareAction(
                    ClaudeCodeGuiBundle.message("diff.inline.openDiff"),
                    null,
                    AllIcons.Actions.Diff
            ) {
                @Override
                public void actionPerformed(@NotNull AnActionEvent e) {
                    approvalService.openFullDiff(filePath);
                }
            });
            return group;
        }
    }

    private static final class DotIcon implements Icon {
        private static final int SIZE = JBUI.scale(10);

        @Override
        public void paintIcon(Component c, Graphics g, int x, int y) {
            Graphics2D g2 = (Graphics2D) g.create();
            try {
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                g2.setColor(new JBColor(new Color(14, 165, 233), new Color(56, 189, 248)));
                g2.fillOval(x + 1, y + 1, SIZE - 2, SIZE - 2);
            } finally {
                g2.dispose();
            }
        }

        @Override
        public int getIconWidth() {
            return SIZE;
        }

        @Override
        public int getIconHeight() {
            return SIZE;
        }
    }
}
