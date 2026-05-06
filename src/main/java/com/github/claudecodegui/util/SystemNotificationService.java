package com.github.claudecodegui.util;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.WindowManager;
import com.intellij.util.ui.JBUI;
import org.jetbrains.annotations.NotNull;

import javax.swing.BorderFactory;
import javax.swing.JButton;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JWindow;
import javax.swing.SwingConstants;
import javax.swing.Timer;
import javax.swing.UIManager;
import javax.swing.border.EmptyBorder;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.Font;
import java.awt.Frame;
import java.awt.GraphicsConfiguration;
import java.awt.GraphicsDevice;
import java.awt.GraphicsEnvironment;
import java.awt.GridLayout;
import java.awt.Insets;
import java.awt.Point;
import java.awt.Rectangle;
import java.awt.Toolkit;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;

/**
 * System notification service.
 * Provides visual system notifications (custom toast window) and delegates sound notifications.
 */
public class SystemNotificationService {

    private static final Logger LOG = Logger.getInstance(SystemNotificationService.class);

    private static final int MAX_MESSAGE_LENGTH = 150;
    private static final int MESSAGE_ELLIPSIS_TAIL = 3;
    private static final int WINDOW_WIDTH = 350;
    private static final int AUTO_CLOSE_MS = 10_000;
    private static final int ANIM_STEPS = 10;
    private static final int ANIM_DELAY_MS = 20;

    private static volatile SystemNotificationService instance;

    // Track active notification window to prevent duplicates. Only mutated on EDT.
    private JWindow activeNotificationWindow = null;

    private SystemNotificationService() {
    }

    public static SystemNotificationService getInstance() {
        if (instance == null) {
            synchronized (SystemNotificationService.class) {
                if (instance == null) {
                    instance = new SystemNotificationService();
                }
            }
        }
        return instance;
    }

    /**
     * Show visual notification window.
     * Styled like Windows 10/11 toast notifications.
     *
     * @param project the current project
     * @param message the notification message to display
     */
    public void showVisualNotificationToast(@NotNull Project project, String message) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (project.isDisposed()) {
                return;
            }
            try {
                if (!isEnabled()) {
                    return;
                }
                disposeActiveWindow();

                JWindow window = createNotificationWindow(project, sanitizeMessage(message));
                activeNotificationWindow = window;

                Point position = getNotificationPosition(window, project);

                // Place window at slide-in start position BEFORE making it visible to avoid flicker.
                int startY = position.y + window.getHeight();
                window.setLocation(position.x, startY);
                window.setVisible(true);

                scheduleAutoClose(window);
                animateSlideIn(window, position.y);
            } catch (Exception e) {
                LOG.warn("[SystemNotification] Failed to show visual notification: " + e.getMessage(), e);
            }
        });
    }

    private boolean isEnabled() {
        try {
            return new CodemossSettingsService().getTaskCompletionNotificationEnabled();
        } catch (Exception e) {
            LOG.debug("[SystemNotification] Failed to read enabled flag, defaulting to true: " + e.getMessage());
            return true;
        }
    }

    private void disposeActiveWindow() {
        if (activeNotificationWindow != null) {
            activeNotificationWindow.dispose();
            activeNotificationWindow = null;
        }
    }

    /**
     * Truncate by code points (so emoji and surrogate pairs stay intact) and HTML-escape
     * the result before embedding into a {@code <html>...</html>} JLabel.
     */
    private String sanitizeMessage(String raw) {
        String text = raw == null ? "" : raw;
        int cpCount = text.codePointCount(0, text.length());
        if (cpCount > MAX_MESSAGE_LENGTH) {
            int end = text.offsetByCodePoints(0, MAX_MESSAGE_LENGTH - MESSAGE_ELLIPSIS_TAIL);
            text = text.substring(0, end) + "...";
        }
        return escapeHtml(text);
    }

    private static String escapeHtml(String input) {
        StringBuilder sb = new StringBuilder(input.length() + 16);
        for (int i = 0; i < input.length(); i++) {
            char c = input.charAt(i);
            switch (c) {
                case '&':
                    sb.append("&amp;");
                    break;
                case '<':
                    sb.append("&lt;");
                    break;
                case '>':
                    sb.append("&gt;");
                    break;
                case '"':
                    sb.append("&quot;");
                    break;
                case '\'':
                    sb.append("&#39;");
                    break;
                default:
                    sb.append(c);
            }
        }
        return sb.toString();
    }

    private JWindow createNotificationWindow(@NotNull Project project, String escapedMessage) {
        JWindow window = new JWindow();
        window.setAlwaysOnTop(true);

        boolean isDark = UIManager.getBoolean("Editor.isDarkTheme");
        Color bgColor = isDark ? new Color(32, 32, 32) : new Color(255, 255, 255);
        Color textColor = isDark ? new Color(255, 255, 255) : new Color(0, 0, 0);
        Color subtextColor = isDark ? new Color(180, 180, 180) : new Color(90, 90, 90);
        Color accentColor = new Color(0, 120, 212); // Windows blue accent

        JPanel mainPanel = new JPanel(new BorderLayout());
        mainPanel.setBorder(BorderFactory.createCompoundBorder(
            BorderFactory.createLineBorder(new Color(0, 0, 0, 80), 1),
            BorderFactory.createEmptyBorder(1, 1, 1, 1)
        ));
        mainPanel.setBackground(bgColor);

        JPanel contentPanel = new JPanel(new BorderLayout(JBUI.scale(12), JBUI.scale(8)));
        contentPanel.setBorder(new EmptyBorder(JBUI.scale(16), JBUI.scale(16), JBUI.scale(16), JBUI.scale(16)));
        contentPanel.setBackground(bgColor);

        JPanel accentBar = new JPanel();
        accentBar.setBackground(accentColor);
        accentBar.setPreferredSize(new Dimension(JBUI.scale(4), 0));

        JLabel iconLabel = new JLabel(UIManager.getIcon("OptionPane.informationIcon"));
        iconLabel.setHorizontalAlignment(SwingConstants.CENTER);
        iconLabel.setVerticalAlignment(SwingConstants.TOP);

        JPanel textPanel = buildTextPanel(escapedMessage, textColor, subtextColor);
        JButton closeButton = createCloseButton(window, isDark, subtextColor);

        JPanel headerPanel = new JPanel(new BorderLayout(JBUI.scale(12), 0));
        headerPanel.setOpaque(false);
        headerPanel.add(iconLabel, BorderLayout.WEST);
        headerPanel.add(textPanel, BorderLayout.CENTER);
        headerPanel.add(closeButton, BorderLayout.EAST);

        contentPanel.add(headerPanel, BorderLayout.CENTER);

        mainPanel.add(accentBar, BorderLayout.WEST);
        mainPanel.add(contentPanel, BorderLayout.CENTER);

        window.getContentPane().add(mainPanel);
        window.setBackground(bgColor);
        window.pack();
        window.setSize(JBUI.scale(WINDOW_WIDTH), window.getHeight());

        // Whole-window click activates IDE; clicks on the close button are handled by its own listener.
        window.addMouseListener(new MouseAdapter() {
            @Override
            public void mouseClicked(MouseEvent e) {
                if (e.getSource() == closeButton) {
                    return;
                }
                if (activeNotificationWindow == window) {
                    window.dispose();
                    activeNotificationWindow = null;
                    activateIdeWindow(project);
                }
            }
        });

        return window;
    }

    private JPanel buildTextPanel(String escapedMessage, Color textColor, Color subtextColor) {
        JPanel textPanel = new JPanel(new GridLayout(2, 1, 0, JBUI.scale(4)));
        textPanel.setOpaque(false);

        JLabel titleLabel = new JLabel(ClaudeCodeGuiBundle.message("notifier.taskComplete.title"));
        titleLabel.setFont(titleLabel.getFont().deriveFont(Font.BOLD, 13f));
        titleLabel.setForeground(textColor);

        JLabel messageLabel = new JLabel(
            "<html><body style='width: " + JBUI.scale(250) + "px; margin: 0;'>" + escapedMessage + "</body></html>");
        messageLabel.setFont(messageLabel.getFont().deriveFont(11f));
        messageLabel.setForeground(subtextColor);

        textPanel.add(titleLabel);
        textPanel.add(messageLabel);
        return textPanel;
    }

    private JButton createCloseButton(JWindow window, boolean isDark, Color subtextColor) {
        JButton closeButton = new JButton("×");
        closeButton.setFont(closeButton.getFont().deriveFont(Font.BOLD, 18f));
        closeButton.setFocusPainted(false);
        closeButton.setBorderPainted(false);
        closeButton.setContentAreaFilled(false);
        closeButton.setCursor(new Cursor(Cursor.HAND_CURSOR));
        closeButton.setForeground(subtextColor);
        closeButton.setPreferredSize(new Dimension(JBUI.scale(24), JBUI.scale(24)));
        closeButton.addMouseListener(new MouseAdapter() {
            @Override
            public void mouseEntered(MouseEvent e) {
                closeButton.setForeground(isDark ? new Color(200, 200, 200) : new Color(60, 60, 60));
                closeButton.setBackground(isDark ? new Color(60, 60, 60) : new Color(230, 230, 230));
                closeButton.setOpaque(true);
            }

            @Override
            public void mouseExited(MouseEvent e) {
                closeButton.setForeground(subtextColor);
                closeButton.setOpaque(false);
            }

            @Override
            public void mouseClicked(MouseEvent e) {
                if (activeNotificationWindow == window) {
                    window.dispose();
                    activeNotificationWindow = null;
                }
            }
        });
        return closeButton;
    }

    private void scheduleAutoClose(JWindow window) {
        Timer closeTimer = new Timer(AUTO_CLOSE_MS, ev -> {
            if (activeNotificationWindow == window) {
                window.dispose();
                activeNotificationWindow = null;
            }
        });
        closeTimer.setRepeats(false);
        closeTimer.start();
    }

    /**
     * Get optimal position for notification window.
     * Priority: 1) Near IDE window (top-right), 2) Primary screen bottom-right.
     */
    private Point getNotificationPosition(JWindow window, @NotNull Project project) {
        if (project.isDisposed()) {
            return getFallbackPosition(window);
        }
        JFrame ideFrame = WindowManager.getInstance().getFrame(project);
        if (ideFrame != null && ideFrame.isVisible()) {
            Rectangle frameBounds = ideFrame.getBounds();
            int windowWidth = window.getWidth();
            int windowHeight = window.getHeight();

            int x = frameBounds.x + frameBounds.width - windowWidth - JBUI.scale(10);
            int y = frameBounds.y + JBUI.scale(50); // Below title bar area

            for (GraphicsDevice screen : GraphicsEnvironment.getLocalGraphicsEnvironment().getScreenDevices()) {
                Rectangle screenBounds = screen.getDefaultConfiguration().getBounds();
                if (x >= screenBounds.x && x + windowWidth <= screenBounds.x + screenBounds.width &&
                    y >= screenBounds.y && y + windowHeight <= screenBounds.y + screenBounds.height) {
                    return new Point(x, y);
                }
            }
        }
        return getFallbackPosition(window);
    }

    private Point getFallbackPosition(JWindow window) {
        GraphicsEnvironment ge = GraphicsEnvironment.getLocalGraphicsEnvironment();
        GraphicsDevice gd = ge.getDefaultScreenDevice();
        GraphicsConfiguration gc = gd.getDefaultConfiguration();
        Rectangle screenBounds = gc.getBounds();
        Insets screenInsets = Toolkit.getDefaultToolkit().getScreenInsets(gc);

        int screenWidth = screenBounds.width - screenInsets.right - screenInsets.left;
        int screenHeight = screenBounds.height - screenInsets.top - screenInsets.bottom;
        int windowWidth = window.getWidth();
        int windowHeight = window.getHeight();

        int x = screenBounds.x + screenWidth - windowWidth - JBUI.scale(10) + screenInsets.right;
        int y = screenBounds.y + screenHeight - windowHeight - JBUI.scale(10) + screenInsets.bottom;
        return new Point(x, y);
    }

    /**
     * Animate notification window sliding in from bottom.
     * Window must already be positioned at the start position before being made visible.
     */
    private void animateSlideIn(JWindow window, int targetY) {
        int startX = window.getX();
        int startY = window.getY();
        Timer animTimer = new Timer(ANIM_DELAY_MS, null);
        animTimer.addActionListener(e -> {
            int currentY = window.getY();
            int step = Math.max(1, (startY - targetY) / ANIM_STEPS);
            if (currentY > targetY) {
                int newY = Math.max(currentY - step, targetY);
                window.setLocation(startX, newY);
            } else {
                window.setLocation(startX, targetY);
                animTimer.stop();
            }
        });
        animTimer.start();
    }

    /**
     * Activate and bring IDE window to front.
     * Restores from minimized state and requests focus.
     */
    private void activateIdeWindow(@NotNull Project project) {
        try {
            if (project.isDisposed()) {
                return;
            }
            JFrame frame = WindowManager.getInstance().getFrame(project);
            if (frame != null) {
                int state = frame.getExtendedState();
                if ((state & Frame.ICONIFIED) != 0) {
                    frame.setExtendedState(state & ~Frame.ICONIFIED);
                }
                frame.setVisible(true);
                frame.toFront();
                frame.requestFocus();
                frame.repaint();
            }
        } catch (Exception e) {
            LOG.debug("[SystemNotification] Failed to activate IDE window: " + e.getMessage());
        }
    }
}
