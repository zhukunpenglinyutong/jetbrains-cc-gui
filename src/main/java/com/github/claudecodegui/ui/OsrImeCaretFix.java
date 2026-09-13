package com.github.claudecodegui.ui;

import com.intellij.openapi.diagnostic.Logger;
import org.cef.browser.CefBrowser;
import org.cef.input.CefCompositionUnderline;
import org.cef.misc.CefRange;

import javax.swing.JComponent;
import java.awt.Color;
import java.awt.event.InputMethodEvent;
import java.awt.event.InputMethodListener;
import java.awt.font.TextHitInfo;
import java.lang.reflect.Field;
import java.text.AttributedCharacterIterator;
import java.text.CharacterIterator;
import java.util.List;
import java.util.function.Supplier;

/**
 * Repairs IME composition handling on JCEF OSR components.
 *
 * <p>The platform's {@code JBCefInputMethodAdapter} (registered by
 * {@code JBCefOsrComponent} as its {@link InputMethodListener}) has two defects
 * that break CJK phrase-based IMEs such as Bopomofo (注音) and Pinyin:</p>
 *
 * <ol>
 *   <li>It always passes {@code new CefRange(len, len)} as the selection range to
 *       {@code CefBrowser#ImeSetComposition}, ignoring {@link InputMethodEvent#getCaret()}.
 *       The rendered caret therefore sticks to the end of the pre-edit text while the
 *       user moves the IME cursor to pick candidates for a specific character.</li>
 *   <li>It silently drops events whose text is {@code null} or whose composed part is
 *       empty, so a composition cancelled by switching the input source mid-composition
 *       never reaches Blink: the page keeps stale pre-edit text and never receives
 *       {@code compositionend}, leaving the webview's IME state stuck.</li>
 * </ol>
 *
 * <p>{@link #install(JComponent)} swaps the platform listener for a fixed
 * re-implementation. The platform adapter object stays in place as the component's
 * {@code InputMethodRequests} implementation (candidate-window positioning), and is kept
 * as a delegate fallback whenever the browser instance cannot be resolved.</p>
 *
 * <p>Only components carrying the known platform adapter are touched; if JetBrains
 * renames or fixes the adapter, this class becomes a no-op. The fix can be disabled with
 * {@code -Dccg.disable.osr.ime.fix=true}.</p>
 */
public final class OsrImeCaretFix {

    private static final Logger LOG = Logger.getInstance(OsrImeCaretFix.class);

    static final String PLATFORM_ADAPTER_CLASS = "com.intellij.ui.jcef.JBCefInputMethodAdapter";
    private static final String DISABLE_PROPERTY = "ccg.disable.osr.ime.fix";

    /** CEF's "no explicit range" sentinel, mirroring the platform adapter's DEFAULT_RANGE. */
    private static final CefRange UNMARKED_RANGE = new CefRange(-1, -1);

    /** Transparent color: tells Blink to draw the composition underline with its defaults. */
    private static final Color TRANSPARENT = new Color(0, true);

    private OsrImeCaretFix() {
    }

    /**
     * Replaces the platform IME adapter on an OSR component with the fixed listener.
     * Safe to call on any component; does nothing when the adapter is absent.
     */
    public static void install(JComponent component) {
        if (component == null || Boolean.getBoolean(DISABLE_PROPERTY)) {
            return;
        }
        for (InputMethodListener listener : component.getInputMethodListeners()) {
            if (PLATFORM_ADAPTER_CLASS.equals(listener.getClass().getName())) {
                component.removeInputMethodListener(listener);
                component.addInputMethodListener(
                        new FixedInputMethodListener(listener, new ReflectiveBrowserResolver(listener)));
                LOG.info("Installed OSR IME caret fix on " + component.getClass().getName());
                return;
            }
        }
    }

    /** Clamps the IME caret to a valid offset inside the composed text. */
    static int caretPosition(TextHitInfo caret, int composedLength) {
        if (caret == null) {
            return composedLength;
        }
        return Math.max(0, Math.min(caret.getInsertionIndex(), composedLength));
    }

    /**
     * Splits an input-method event's text into committed and composed parts.
     * Returns {@code {committed, composed}}; both are empty when the event has no text
     * (composition cancelled).
     */
    static String[] splitCommittedComposed(AttributedCharacterIterator text, int committedCount) {
        if (text == null) {
            return new String[]{"", ""};
        }
        StringBuilder all = new StringBuilder();
        for (char c = text.first(); c != CharacterIterator.DONE; c = text.next()) {
            all.append(c);
        }
        int committed = Math.max(0, Math.min(committedCount, all.length()));
        return new String[]{all.substring(0, committed), all.substring(committed)};
    }

    /** Resolves the {@code CefBrowser} from the platform adapter's private field. */
    private static final class ReflectiveBrowserResolver implements Supplier<CefBrowser> {
        private final InputMethodListener platformAdapter;
        private Field browserField;
        private boolean broken;

        ReflectiveBrowserResolver(InputMethodListener platformAdapter) {
            this.platformAdapter = platformAdapter;
        }

        @Override
        public CefBrowser get() {
            if (broken) {
                return null;
            }
            try {
                if (browserField == null) {
                    Field field = platformAdapter.getClass().getDeclaredField("myBrowser");
                    field.setAccessible(true);
                    browserField = field;
                }
                Object value = browserField.get(platformAdapter);
                return value instanceof CefBrowser ? (CefBrowser) value : null;
            } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
                broken = true;
                LOG.warn("OSR IME caret fix falling back to platform behaviour: "
                        + "cannot access adapter browser field", e);
                return null;
            }
        }
    }

    /**
     * Fixed IME listener: forwards the real caret position to Blink and terminates the
     * composition when the IME cancels it. Falls back to the platform adapter whenever
     * the browser cannot be resolved.
     */
    static final class FixedInputMethodListener implements InputMethodListener {
        private final InputMethodListener platformAdapter;
        private final Supplier<CefBrowser> browserSupplier;
        private String composedText = "";
        private boolean composing;

        FixedInputMethodListener(InputMethodListener platformAdapter, Supplier<CefBrowser> browserSupplier) {
            this.platformAdapter = platformAdapter;
            this.browserSupplier = browserSupplier;
        }

        @Override
        public void inputMethodTextChanged(InputMethodEvent event) {
            CefBrowser browser = browserSupplier.get();
            if (browser == null) {
                platformAdapter.inputMethodTextChanged(event);
                return;
            }

            String[] parts = splitCommittedComposed(event.getText(), event.getCommittedCharacterCount());
            String committed = parts[0];
            String composed = parts[1];

            if (!committed.isEmpty()) {
                browser.ImeCommitText(committed, UNMARKED_RANGE, 0);
                composing = false;
                composedText = "";
            }

            if (composed.isEmpty()) {
                // Empty composed text on an active composition means the IME aborted it
                // (input source switched, Escape, ...). The platform adapter drops this
                // case, leaving the page composing forever.
                if (composing) {
                    browser.ImeCancelComposing();
                    composing = false;
                    composedText = "";
                }
            } else {
                setComposition(browser, composed, event.getCaret());
            }
            event.consume();
        }

        @Override
        public void caretPositionChanged(InputMethodEvent event) {
            // Fired when only the caret moves inside the pre-edit text (e.g. Bopomofo
            // arrow-key navigation between characters). The platform adapter ignores it.
            CefBrowser browser = composing && !composedText.isEmpty() ? browserSupplier.get() : null;
            if (browser == null) {
                platformAdapter.caretPositionChanged(event);
                return;
            }
            setComposition(browser, composedText, event.getCaret());
            event.consume();
        }

        private void setComposition(CefBrowser browser, String composed, TextHitInfo caret) {
            int caretOffset = caretPosition(caret, composed.length());
            CefCompositionUnderline underline = new CefCompositionUnderline(
                    new CefRange(0, composed.length()),
                    TRANSPARENT, TRANSPARENT, 0,
                    CefCompositionUnderline.Style.SOLID);
            browser.ImeSetComposition(
                    composed,
                    List.of(underline),
                    UNMARKED_RANGE,
                    new CefRange(caretOffset, caretOffset));
            composing = true;
            composedText = composed;
        }
    }
}
