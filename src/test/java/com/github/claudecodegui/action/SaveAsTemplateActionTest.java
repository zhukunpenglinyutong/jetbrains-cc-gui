package com.github.claudecodegui.action;

import org.junit.Assert;
import org.junit.Test;

public class SaveAsTemplateActionTest {

    @Test
    public void handleNoActiveSessionShowsErrorDialog() {
        TrackingSaveAsTemplateAction action = new TrackingSaveAsTemplateAction();
        action.handleNoActiveSession(null);
        Assert.assertTrue(action.errorShown);
    }

    private static final class TrackingSaveAsTemplateAction extends SaveAsTemplateAction {
        private boolean errorShown = false;

        @Override
        protected void showErrorDialog(com.intellij.openapi.project.Project project, String message, String title) {
            errorShown = true;
        }
    }
}

