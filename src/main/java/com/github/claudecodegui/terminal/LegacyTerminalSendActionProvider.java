package com.github.claudecodegui.terminal;

import com.intellij.openapi.actionSystem.ActionManager;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.terminal.JBTerminalWidget;
import com.intellij.terminal.actions.TerminalActionUtil;
import com.jediterm.terminal.ui.TerminalAction;
import com.jediterm.terminal.ui.TerminalActionProvider;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.Collections;
import java.util.List;

final class LegacyTerminalSendActionProvider implements TerminalActionProvider {

    private final List<TerminalAction> actions;
    private TerminalActionProvider nextProvider;

    LegacyTerminalSendActionProvider(@NotNull JBTerminalWidget widget, @Nullable TerminalActionProvider nextProvider) {
        this.actions = Collections.singletonList(createAction(widget));
        this.nextProvider = nextProvider;
    }

    @Override
    public @NotNull List<TerminalAction> getActions() {
        return actions;
    }

    @Override
    public @Nullable TerminalActionProvider getNextProvider() {
        return nextProvider;
    }

    @Override
    public void setNextProvider(@Nullable TerminalActionProvider provider) {
        this.nextProvider = provider;
    }

    private static @NotNull TerminalAction createAction(@NotNull JBTerminalWidget widget) {
        AnAction action = ActionManager.getInstance().getAction(SendTerminalSelectionToInputAction.ACTION_ID);
        if (action == null) {
            throw new IllegalStateException("Terminal send action is not registered: " + SendTerminalSelectionToInputAction.ACTION_ID);
        }
        return TerminalActionUtil.createTerminalAction(widget, action);
    }
}
