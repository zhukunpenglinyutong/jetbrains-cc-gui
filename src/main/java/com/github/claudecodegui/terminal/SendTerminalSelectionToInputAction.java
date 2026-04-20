package com.github.claudecodegui.terminal;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.util.SelectionTextUtils;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.terminal.JBTerminalWidget;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;
import org.jetbrains.plugins.terminal.block.util.TerminalDataContextUtils;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

public class SendTerminalSelectionToInputAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(SendTerminalSelectionToInputAction.class);
    static final String ACTION_ID = "ClaudeCodeGUI.SendTerminalSelectionToInputAction";
    static final String TERMINAL_OUTPUT_CONTEXT_MENU = "Terminal.OutputContextMenu";
    static final String TERMINAL_PROMPT_CONTEXT_MENU = "Terminal.PromptContextMenu";
    private static final Set<String> loggedUpdateContexts = ConcurrentHashMap.newKeySet();
    private static TerminalSelectionProvider selectionProvider = TerminalSelectionProvider.DEFAULT;

    public SendTerminalSelectionToInputAction() {
        super(
                ClaudeCodeGuiBundle.message("action.sendConsoleSelection.text"),
                ClaudeCodeGuiBundle.message("action.sendConsoleSelection.description"),
                null
        );
    }

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.EDT;
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        boolean popupPlace = isTerminalPopupPlace(e.getPlace());
        boolean widgetContext = hasTerminalWidgetContext(e);
        boolean editorContext = isTerminalContext(e);
        boolean terminalContext = popupPlace || widgetContext || editorContext;
        logUpdateContext(e, popupPlace, widgetContext, editorContext, terminalContext);
        e.getPresentation().setEnabledAndVisible(terminalContext);
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        String selectedText = resolveSelectedText(e);
        if (LOG.isDebugEnabled()) {
            LOG.debug("[TerminalSend] actionPerformed place=" + e.getPlace()
                    + ", project=" + (project == null ? "null" : project.getName())
                    + ", hasTerminalWidget=" + hasTerminalWidgetContext(e)
                    + ", editorContext=" + isTerminalContext(e)
                    + ", textResolved=" + (selectedText != null)
                    + ", textLength=" + (selectedText == null ? 0 : selectedText.length()));
        }
        if (project == null || selectedText == null) {
            return;
        }
        SelectionTextUtils.sendToChatWindow(project, selectedText);
    }

    static void setSelectionProvider(@NotNull TerminalSelectionProvider provider) {
        selectionProvider = provider;
    }

    static void resetSelectionProvider() {
        selectionProvider = TerminalSelectionProvider.DEFAULT;
    }

    static @Nullable String resolveSelectedText(@Nullable AnActionEvent e) {
        String rawSelection = selectionProvider.resolveSelection(e);
        if (rawSelection == null && e != null) {
            rawSelection = e.getData(JBTerminalWidget.SELECTED_TEXT_DATA_KEY);
        }
        if (rawSelection == null) {
            Editor editor = resolveEditor(e);
            if (editor != null) {
                rawSelection = editor.getSelectionModel().getSelectedText();
            }
        }
        return SelectionTextUtils.normalizeSendableText(rawSelection);
    }

    static boolean isTerminalPopupPlace(@Nullable String place) {
        return TERMINAL_OUTPUT_CONTEXT_MENU.equals(place) || TERMINAL_PROMPT_CONTEXT_MENU.equals(place);
    }

    interface TerminalSelectionProvider {

        TerminalSelectionProvider DEFAULT = event -> {
            if (event == null) {
                return null;
            }
            try {
                Editor editor = TerminalDataContextUtils.INSTANCE.getEditor(event);
                if (editor == null || !isSupportedEditor(editor)) {
                    return null;
                }
                return editor.getSelectionModel().getSelectedText();
            } catch (Error e) {
                throw e;
            } catch (RuntimeException e) {
                LOG.debug("[TerminalSend] TerminalDataContextUtils.getEditor failed in DEFAULT provider", e);
                return null;
            }
        };

        @Nullable
        String resolveSelection(@Nullable AnActionEvent event);
    }

    private static boolean isTerminalContext(@Nullable AnActionEvent event) {
        Editor editor = resolveEditor(event);
        return editor != null && isSupportedEditor(editor);
    }

    private static boolean hasTerminalWidgetContext(@Nullable AnActionEvent event) {
        if (event == null) {
            return false;
        }
        return event.getData(JBTerminalWidget.TERMINAL_DATA_KEY) != null;
    }

    private static @Nullable Editor resolveEditor(@Nullable AnActionEvent event) {
        if (event == null) {
            return null;
        }
        try {
            Editor editor = TerminalDataContextUtils.INSTANCE.getEditor(event);
            if (editor != null && isSupportedEditor(editor)) {
                return editor;
            }
        } catch (Error e) {
            throw e;
        } catch (RuntimeException e) {
            LOG.debug("[TerminalSend] TerminalDataContextUtils.getEditor failed, falling back", e);
        }

        Editor fallbackEditor = event.getData(CommonDataKeys.EDITOR);
        if (fallbackEditor != null && isSupportedEditor(fallbackEditor)) {
            return fallbackEditor;
        }
        return null;
    }

    private static boolean isSupportedEditor(@NotNull Editor editor) {
        return TerminalDataContextUtils.INSTANCE.isPromptEditor(editor)
                || TerminalDataContextUtils.INSTANCE.isOutputEditor(editor)
                || TerminalDataContextUtils.INSTANCE.isAlternateBufferEditor(editor);
    }

    private static void logUpdateContext(@NotNull AnActionEvent event,
                                         boolean popupPlace,
                                         boolean widgetContext,
                                         boolean editorContext,
                                         boolean terminalContext) {
        String place = event.getPlace();
        boolean genericEditor = event.getData(CommonDataKeys.EDITOR) != null;
        String signature = String.valueOf(place) + "|" + popupPlace + "|" + widgetContext + "|" + editorContext + "|" + genericEditor + "|" + terminalContext;
        if (!loggedUpdateContexts.add(signature)) {
            return;
        }
        LOG.debug("[TerminalSend] update place=" + place
                + ", popupPlace=" + popupPlace
                + ", hasTerminalWidget=" + widgetContext
                + ", terminalEditorContext=" + editorContext
                + ", genericEditor=" + genericEditor
                + ", visible=" + terminalContext);
    }
}
