package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.ui.jcef.JBCefBrowser;

import java.awt.Cursor;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import javax.swing.JComponent;

/**
 * Handler for cursor change messages from the JS cursor tracker.
 * Maps CSS cursor values to Swing cursor types so JCEF on macOS
 * shows the correct mouse pointer.
 */
public class CursorHandler extends BaseMessageHandler {

    private static final String[] SUPPORTED_TYPES = {"cursor_change"};

    private static final Map<String, Cursor> CSS_TO_SWING_CURSOR = Map.ofEntries(
        Map.entry("text", Cursor.getPredefinedCursor(Cursor.TEXT_CURSOR)),
        Map.entry("pointer", Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)),
        Map.entry("crosshair", Cursor.getPredefinedCursor(Cursor.CROSSHAIR_CURSOR)),
        Map.entry("wait", Cursor.getPredefinedCursor(Cursor.WAIT_CURSOR)),
        Map.entry("progress", Cursor.getPredefinedCursor(Cursor.WAIT_CURSOR)),
        Map.entry("move", Cursor.getPredefinedCursor(Cursor.MOVE_CURSOR)),
        Map.entry("grab", Cursor.getPredefinedCursor(Cursor.MOVE_CURSOR)),
        Map.entry("grabbing", Cursor.getPredefinedCursor(Cursor.MOVE_CURSOR)),
        Map.entry("col-resize", Cursor.getPredefinedCursor(Cursor.E_RESIZE_CURSOR)),
        Map.entry("ew-resize", Cursor.getPredefinedCursor(Cursor.E_RESIZE_CURSOR)),
        Map.entry("e-resize", Cursor.getPredefinedCursor(Cursor.E_RESIZE_CURSOR)),
        Map.entry("w-resize", Cursor.getPredefinedCursor(Cursor.E_RESIZE_CURSOR)),
        Map.entry("row-resize", Cursor.getPredefinedCursor(Cursor.N_RESIZE_CURSOR)),
        Map.entry("ns-resize", Cursor.getPredefinedCursor(Cursor.N_RESIZE_CURSOR)),
        Map.entry("n-resize", Cursor.getPredefinedCursor(Cursor.N_RESIZE_CURSOR)),
        Map.entry("s-resize", Cursor.getPredefinedCursor(Cursor.N_RESIZE_CURSOR)),
        Map.entry("nesw-resize", Cursor.getPredefinedCursor(Cursor.NE_RESIZE_CURSOR)),
        Map.entry("ne-resize", Cursor.getPredefinedCursor(Cursor.NE_RESIZE_CURSOR)),
        Map.entry("sw-resize", Cursor.getPredefinedCursor(Cursor.NE_RESIZE_CURSOR)),
        Map.entry("nwse-resize", Cursor.getPredefinedCursor(Cursor.NW_RESIZE_CURSOR)),
        Map.entry("nw-resize", Cursor.getPredefinedCursor(Cursor.NW_RESIZE_CURSOR)),
        Map.entry("se-resize", Cursor.getPredefinedCursor(Cursor.NW_RESIZE_CURSOR)),
        Map.entry("not-allowed", Cursor.getPredefinedCursor(Cursor.DEFAULT_CURSOR)),
        Map.entry("no-drop", Cursor.getPredefinedCursor(Cursor.DEFAULT_CURSOR)),
        Map.entry("help", Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)),
        Map.entry("zoom-in", Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)),
        Map.entry("zoom-out", Cursor.getPredefinedCursor(Cursor.HAND_CURSOR))
    );

    private final AtomicReference<Cursor> pendingCursor = new AtomicReference<>(Cursor.getPredefinedCursor(Cursor.DEFAULT_CURSOR));
    private final AtomicBoolean updateScheduled = new AtomicBoolean(false);

    public CursorHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if (!"cursor_change".equals(type)) {
            return false;
        }
        if (content == null || content.isEmpty()) {
            return true;
        }
        this.pendingCursor.set(CSS_TO_SWING_CURSOR.getOrDefault(
                content,
                Cursor.getPredefinedCursor(Cursor.DEFAULT_CURSOR)
        ));
        if (this.updateScheduled.compareAndSet(false, true)) {
            ApplicationManager.getApplication().invokeLater(this::flushCursorUpdate);
        }
        return true;
    }

    private void flushCursorUpdate() {
        if (this.context.isDisposed()) {
            this.updateScheduled.set(false);
            return;
        }
        Cursor targetCursor = this.pendingCursor.get();
        updateCursor(targetCursor);
        this.updateScheduled.set(false);
        if (!this.context.isDisposed()
                && this.pendingCursor.get() != targetCursor
                && this.updateScheduled.compareAndSet(false, true)) {
            ApplicationManager.getApplication().invokeLater(this::flushCursorUpdate);
        }
    }

    private void updateCursor(Cursor targetCursor) {
        if (this.context.isDisposed()) {
            return;
        }
        JBCefBrowser browser = this.context.getBrowser();
        if (browser == null) {
            return;
        }
        JComponent comp = browser.getComponent();
        if (targetCursor.equals(comp.getCursor())) {
            return;
        }
        comp.setCursor(targetCursor);
    }
}
