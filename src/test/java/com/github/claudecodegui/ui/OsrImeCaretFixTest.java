package com.github.claudecodegui.ui;

import org.cef.browser.CefBrowser;
import org.cef.misc.CefRange;
import org.junit.Test;

import javax.swing.JPanel;
import java.awt.event.InputMethodEvent;
import java.awt.event.InputMethodListener;
import java.awt.font.TextHitInfo;
import java.lang.reflect.Proxy;
import java.text.AttributedString;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Tests the OSR IME composition fix: caret propagation into ImeSetComposition,
 * composition cancellation on empty/null composed text, committed-text passthrough,
 * caret-only movement re-sends, and fallback delegation when no browser is available.
 */
public class OsrImeCaretFixTest {

    /** Records every Ime* call reaching the fake CefBrowser. */
    private static final class RecordedCall {
        final String name;
        final Object[] args;

        RecordedCall(String name, Object[] args) {
            this.name = name;
            this.args = args;
        }
    }

    private static CefBrowser recordingBrowser(List<RecordedCall> calls) {
        return (CefBrowser) Proxy.newProxyInstance(
                CefBrowser.class.getClassLoader(),
                new Class<?>[]{CefBrowser.class},
                (proxy, method, args) -> {
                    calls.add(new RecordedCall(method.getName(), args));
                    Class<?> rt = method.getReturnType();
                    if (rt == boolean.class) return false;
                    if (rt == int.class) return 0;
                    if (rt == double.class) return 0.0;
                    return null;
                });
    }

    private static final class RecordingListener implements InputMethodListener {
        int textChanged;
        int caretChanged;

        @Override
        public void inputMethodTextChanged(InputMethodEvent event) {
            textChanged++;
        }

        @Override
        public void caretPositionChanged(InputMethodEvent event) {
            caretChanged++;
        }
    }

    private static InputMethodEvent textEvent(String text, int committedCount, TextHitInfo caret) {
        return new InputMethodEvent(
                new JPanel(),
                InputMethodEvent.INPUT_METHOD_TEXT_CHANGED,
                text == null ? null : new AttributedString(text).getIterator(),
                committedCount,
                caret,
                null);
    }

    private static InputMethodEvent caretEvent(TextHitInfo caret) {
        return new InputMethodEvent(
                new JPanel(),
                InputMethodEvent.CARET_POSITION_CHANGED,
                null,
                0,
                caret,
                null);
    }

    private static CefRange selectionRangeOf(RecordedCall call) {
        // ImeSetComposition(text, underlines, replacementRange, selectionRange)
        return (CefRange) call.args[3];
    }

    // --- caretPosition ---

    @Test
    public void caretPositionUsesInsertionIndex() {
        assertEquals(2, OsrImeCaretFix.caretPosition(TextHitInfo.leading(2), 5));
    }

    @Test
    public void caretPositionClampsToComposedLength() {
        assertEquals(3, OsrImeCaretFix.caretPosition(TextHitInfo.leading(9), 3));
        assertEquals(0, OsrImeCaretFix.caretPosition(TextHitInfo.trailing(-2), 3));
    }

    @Test
    public void caretPositionDefaultsToEndWithoutCaret() {
        assertEquals(4, OsrImeCaretFix.caretPosition(null, 4));
    }

    // --- splitCommittedComposed ---

    @Test
    public void splitReturnsEmptyPartsForNullText() {
        String[] parts = OsrImeCaretFix.splitCommittedComposed(null, 0);
        assertEquals("", parts[0]);
        assertEquals("", parts[1]);
    }

    @Test
    public void splitSeparatesCommittedAndComposed() {
        String[] parts = OsrImeCaretFix.splitCommittedComposed(
                new AttributedString("好注音").getIterator(), 1);
        assertEquals("好", parts[0]);
        assertEquals("注音", parts[1]);
    }

    @Test
    public void splitClampsCommittedCount() {
        String[] parts = OsrImeCaretFix.splitCommittedComposed(
                new AttributedString("ab").getIterator(), 9);
        assertEquals("ab", parts[0]);
        assertEquals("", parts[1]);
    }

    // --- FixedInputMethodListener ---

    @Test
    public void compositionForwardsCaretPositionToBlink() {
        List<RecordedCall> calls = new ArrayList<>();
        CefBrowser browser = recordingBrowser(calls);
        RecordingListener fallback = new RecordingListener();
        OsrImeCaretFix.FixedInputMethodListener listener =
                new OsrImeCaretFix.FixedInputMethodListener(fallback, () -> browser);

        listener.inputMethodTextChanged(textEvent("注音輸入", 0, TextHitInfo.leading(2)));

        assertEquals(1, calls.size());
        assertEquals("ImeSetComposition", calls.get(0).name);
        assertEquals("注音輸入", calls.get(0).args[0]);
        CefRange selection = selectionRangeOf(calls.get(0));
        assertEquals(2, selection.from);
        assertEquals(2, selection.to);
        assertEquals(0, fallback.textChanged);
    }

    @Test
    public void caretOnlyMovementResendsCompositionWithNewCaret() {
        List<RecordedCall> calls = new ArrayList<>();
        CefBrowser browser = recordingBrowser(calls);
        OsrImeCaretFix.FixedInputMethodListener listener =
                new OsrImeCaretFix.FixedInputMethodListener(new RecordingListener(), () -> browser);

        listener.inputMethodTextChanged(textEvent("注音", 0, TextHitInfo.leading(2)));
        listener.caretPositionChanged(caretEvent(TextHitInfo.leading(1)));

        assertEquals(2, calls.size());
        assertEquals("ImeSetComposition", calls.get(1).name);
        assertEquals("注音", calls.get(1).args[0]);
        CefRange selection = selectionRangeOf(calls.get(1));
        assertEquals(1, selection.from);
        assertEquals(1, selection.to);
    }

    @Test
    public void nullTextCancelsActiveComposition() {
        List<RecordedCall> calls = new ArrayList<>();
        CefBrowser browser = recordingBrowser(calls);
        OsrImeCaretFix.FixedInputMethodListener listener =
                new OsrImeCaretFix.FixedInputMethodListener(new RecordingListener(), () -> browser);

        listener.inputMethodTextChanged(textEvent("ㄊㄞ", 0, null));
        listener.inputMethodTextChanged(textEvent(null, 0, null));

        assertEquals(2, calls.size());
        assertEquals("ImeCancelComposing", calls.get(1).name);
    }

    @Test
    public void emptyComposedTextWithoutActiveCompositionDoesNothing() {
        List<RecordedCall> calls = new ArrayList<>();
        CefBrowser browser = recordingBrowser(calls);
        OsrImeCaretFix.FixedInputMethodListener listener =
                new OsrImeCaretFix.FixedInputMethodListener(new RecordingListener(), () -> browser);

        listener.inputMethodTextChanged(textEvent(null, 0, null));

        assertTrue(calls.isEmpty());
    }

    @Test
    public void committedTextIsCommittedAndEndsComposition() {
        List<RecordedCall> calls = new ArrayList<>();
        CefBrowser browser = recordingBrowser(calls);
        OsrImeCaretFix.FixedInputMethodListener listener =
                new OsrImeCaretFix.FixedInputMethodListener(new RecordingListener(), () -> browser);

        listener.inputMethodTextChanged(textEvent("注音", 0, null));
        listener.inputMethodTextChanged(textEvent("注音", 2, null));
        // A later null-text event must not send a redundant cancel.
        listener.inputMethodTextChanged(textEvent(null, 0, null));

        assertEquals(2, calls.size());
        assertEquals("ImeSetComposition", calls.get(0).name);
        assertEquals("ImeCommitText", calls.get(1).name);
        assertEquals("注音", calls.get(1).args[0]);
    }

    @Test
    public void missingBrowserDelegatesToPlatformAdapter() {
        RecordingListener fallback = new RecordingListener();
        OsrImeCaretFix.FixedInputMethodListener listener =
                new OsrImeCaretFix.FixedInputMethodListener(fallback, () -> null);

        listener.inputMethodTextChanged(textEvent("注", 0, null));
        listener.caretPositionChanged(caretEvent(TextHitInfo.leading(0)));

        assertEquals(1, fallback.textChanged);
        assertEquals(1, fallback.caretChanged);
    }

    // --- install ---

    @Test
    public void installIgnoresComponentsWithoutPlatformAdapter() {
        JPanel panel = new JPanel();
        RecordingListener listener = new RecordingListener();
        panel.addInputMethodListener(listener);

        OsrImeCaretFix.install(panel);

        InputMethodListener[] listeners = panel.getInputMethodListeners();
        assertEquals(1, listeners.length);
        assertEquals(listener, listeners[0]);
    }

    @Test
    public void installToleratesNullComponent() {
        OsrImeCaretFix.install(null);
        assertNull(null);
    }
}
