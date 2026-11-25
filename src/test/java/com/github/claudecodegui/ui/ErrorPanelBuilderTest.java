package com.github.claudecodegui.ui;

import org.junit.Assert;
import org.junit.Test;

import javax.swing.JButton;
import javax.swing.JPanel;
import java.awt.Component;
import java.awt.Container;
import java.util.concurrent.atomic.AtomicInteger;

public class ErrorPanelBuilderTest {

    @Test
    public void centeredPanelActionButtonInvokesCallback() {
        AtomicInteger invocations = new AtomicInteger();
        JPanel panel = ErrorPanelBuilder.buildCenteredPanel(
                "!",
                "JCEF disabled",
                "Enable it and restart",
                "Enable JCEF",
                invocations::incrementAndGet
        );

        JButton button = findButton(panel);
        Assert.assertNotNull(button);
        Assert.assertEquals("Enable JCEF", button.getText());

        button.doClick();

        Assert.assertEquals(1, invocations.get());
    }

    /** Startup recovery must leave room for the browser and keep retry under user control. */
    @Test
    public void retryNoticeIsBoundedAndInvokesOnlyItsRetryAction() {
        AtomicInteger invocations = new AtomicInteger();
        JPanel notice = ErrorPanelBuilder.buildRetryNotice(
                "Browser still starting", "Inspect startup diagnostics.\nRetry without interrupting the session.",
                "Retry browser", invocations::incrementAndGet);
        Assert.assertTrue(notice.getPreferredSize().height < 250);
        Assert.assertEquals(0, invocations.get());
        JButton button = findButton(notice);
        Assert.assertNotNull(button);
        Assert.assertEquals("Retry browser", button.getText());
        button.doClick();
        Assert.assertEquals(1, invocations.get());
    }

    private static JButton findButton(Container container) {
        for (Component component : container.getComponents()) {
            // Scrollbar arrow buttons are not the panel's user-facing action.
            if (component instanceof JButton button && button.getText() != null && !button.getText().isEmpty()) {
                return button;
            }
            if (component instanceof Container) {
                JButton nestedButton = findButton((Container) component);
                if (nestedButton != null) {
                    return nestedButton;
                }
            }
        }
        return null;
    }
}
