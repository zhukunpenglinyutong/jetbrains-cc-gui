package com.github.claudecodegui.handler.provider.omp;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.session.ClaudeSession;
import com.intellij.openapi.application.ApplicationManager;

/**
 * Keeps the tab's OMP approval mode on the Java side.
 *
 * <p>The webview reports every change of the picker ({@code set_omp_approval_mode:<mode>}).
 * The session keeps it, so a reloaded webview gets its choice back instead of starting
 * again at "Default", which for most OMP setups means no approvals at all, and a send
 * that states no mode of its own (Quick Fix) uses the one the tab shows.
 */
public class OmpApprovalModeHandler extends BaseMessageHandler {

    static final String DISPATCH_TYPE = "set_omp_approval_mode";

    private static final String[] SUPPORTED_TYPES = {
            DISPATCH_TYPE
    };

    private final Runnable persistTabState;

    /**
     * @param persistTabState saves the tab's session snapshot; called on the EDT after a change
     */
    public OmpApprovalModeHandler(HandlerContext context, Runnable persistTabState) {
        super(context);
        this.persistTabState = persistTabState;
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if (!DISPATCH_TYPE.equals(type)) {
            return false;
        }
        ClaudeSession session = context.getSession();
        if (session == null) {
            return true;
        }
        session.getState().setOmpApprovalMode(content);
        // Tab indexes belong to Swing.
        ApplicationManager.getApplication().invokeLater(() -> {
            if (!context.isDisposed()) {
                persistTabState.run();
            }
        });
        return true;
    }
}
