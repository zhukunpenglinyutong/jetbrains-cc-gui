package com.github.claudecodegui.util;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.WindowManager;
import org.jetbrains.annotations.NotNull;

import javax.swing.*;
import javax.swing.border.EmptyBorder;
import java.awt.*;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;

/**
 * System notification service.
 * Provides visual system notifications (custom toast window) and delegates sound notifications.
 */
public class SystemNotificationService {

    private static final Logger LOG = Logger.getInstance(SystemNotificationService.class);

    // Singleton pattern
    private static volatile SystemNotificationService instance;

    // Track active notification window to prevent duplicates
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
            try {
                CodemossSettingsService settings = new CodemossSettingsService();
                if (!settings.getTaskCompletionNotificationEnabled()) {
                    return;
                }

                // Close any existing notification window first
                if (activeNotificationWindow != null) {
                    activeNotificationWindow.dispose();
                    activeNotificationWindow = null;
                }

                // Create a custom notification window (no title bar, stays on top)
                JWindow notificationWindow = new JWindow();
                activeNotificationWindow = notificationWindow;

                // Make window always on top and skip taskbar
                notificationWindow.setAlwaysOnTop(true);

                // Create main panel with shadow border effect
                JPanel mainPanel = new JPanel(new BorderLayout());
                mainPanel.setBorder(BorderFactory.createCompoundBorder(
                    BorderFactory.createLineBorder(new Color(0, 0, 0, 80), 1),
                    BorderFactory.createEmptyBorder(1, 1, 1, 1)
                ));

                // Content panel with rounded corner appearance
                JPanel contentPanel = new JPanel(new BorderLayout(12, 8));
                contentPanel.setBorder(new EmptyBorder(16, 16, 16, 16));

                // Determine theme colors
                boolean isDark = UIManager.getBoolean("Editor.isDarkTheme");
                Color bgColor = isDark ? new Color(32, 32, 32) : new Color(255, 255, 255);
                Color textColor = isDark ? new Color(255, 255, 255) : new Color(0, 0, 0);
                Color subtextColor = isDark ? new Color(180, 180, 180) : new Color(90, 90, 90);
                Color accentColor = new Color(0, 120, 212); // Windows blue accent

                contentPanel.setBackground(bgColor);
                mainPanel.setBackground(bgColor);
                notificationWindow.setBackground(bgColor);

                // Left accent bar (Windows 11 style)
                JPanel accentBar = new JPanel();
                accentBar.setBackground(accentColor);
                accentBar.setPreferredSize(new Dimension(4, 0));

                // Icon label with information icon
                JLabel iconLabel = new JLabel(UIManager.getIcon("OptionPane.informationIcon"));
                iconLabel.setHorizontalAlignment(SwingConstants.CENTER);
                iconLabel.setVerticalAlignment(SwingConstants.TOP);

                // Text panel
                JPanel textPanel = new JPanel(new GridLayout(2, 1, 0, 4));
                textPanel.setOpaque(false);

                // Title label
                JLabel titleLabel = new JLabel(ClaudeCodeGuiBundle.message("notifier.taskComplete.title"));
                titleLabel.setFont(titleLabel.getFont().deriveFont(Font.BOLD, 13f));
                titleLabel.setForeground(textColor);

                // Message label (truncate if too long)
                String displayMessage = message.length() > 150 ? message.substring(0, 147) + "..." : message;
                JLabel messageLabel = new JLabel("<html><body style='width: 250px; margin: 0;'>" + displayMessage + "</body></html>");
                messageLabel.setFont(messageLabel.getFont().deriveFont(11f));
                messageLabel.setForeground(subtextColor);

                textPanel.add(titleLabel);
                textPanel.add(messageLabel);

                // Close button
                JButton closeButton = new JButton("×");
                closeButton.setFont(closeButton.getFont().deriveFont(Font.BOLD, 18f));
                closeButton.setFocusPainted(false);
                closeButton.setBorderPainted(false);
                closeButton.setContentAreaFilled(false);
                closeButton.setCursor(new Cursor(Cursor.HAND_CURSOR));
                closeButton.setForeground(subtextColor);
                closeButton.setPreferredSize(new Dimension(24, 24));
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
                        if (activeNotificationWindow == notificationWindow) {
                            notificationWindow.dispose();
                            activeNotificationWindow = null;
                        }
                    }
                });

                // Header panel (icon + text + close)
                JPanel headerPanel = new JPanel(new BorderLayout(12, 0));
                headerPanel.setOpaque(false);
                headerPanel.add(iconLabel, BorderLayout.WEST);
                headerPanel.add(textPanel, BorderLayout.CENTER);
                headerPanel.add(closeButton, BorderLayout.EAST);

                contentPanel.add(headerPanel, BorderLayout.CENTER);

                mainPanel.add(accentBar, BorderLayout.WEST);
                mainPanel.add(contentPanel, BorderLayout.CENTER);

                notificationWindow.getContentPane().add(mainPanel);
                notificationWindow.pack();

                // Set fixed width for consistent appearance
                int windowWidth = 350;
                int windowHeight = notificationWindow.getHeight();
                notificationWindow.setSize(windowWidth, windowHeight);

                // Get optimal position for notification
                Point position = getNotificationPosition(notificationWindow, project);
                notificationWindow.setLocation(position);
                notificationWindow.setVisible(true);

                // Add mouse click listener to activate IDEA window (click anywhere on notification)
                notificationWindow.addMouseListener(new MouseAdapter() {
                    @Override
                    public void mouseClicked(MouseEvent e) {
                        // Don't activate if clicking close button
                        if (e.getSource() == closeButton) return;

                        if (activeNotificationWindow == notificationWindow) {
                            notificationWindow.dispose();
                            activeNotificationWindow = null;
                            activateIdeWindow(project);
                        }
                    }
                });

                // Auto-close after 10 seconds
                Timer closeTimer = new Timer(10000, ev -> {
                    if (activeNotificationWindow == notificationWindow) {
                        notificationWindow.dispose();
                        activeNotificationWindow = null;
                    }
                });
                closeTimer.setRepeats(false);
                closeTimer.start();

                // Slide-in animation effect
                animateSlideIn(notificationWindow, position.y);

            } catch (Exception e) {
                LOG.warn("[SystemNotification] Failed to show visual notification: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Get optimal position for notification window.
     * Priority: 1) Near IDEA window (top-right), 2) Primary screen bottom-right.
     * This ensures the notification appears where the user is working.
     */
    private Point getNotificationPosition(JWindow window, Project project) {
        // Try to get IDE frame position
        JFrame ideFrame = WindowManager.getInstance().getFrame(project);

        if (ideFrame != null && ideFrame.isVisible()) {
            // Position near the IDE window's top-right corner (like VS Code notifications)
            Rectangle frameBounds = ideFrame.getBounds();
            int windowWidth = window.getWidth();
            int windowHeight = window.getHeight();

            // Calculate position: top-right corner of IDE window
            int x = frameBounds.x + frameBounds.width - windowWidth - 10;
            int y = frameBounds.y + 50; // Below title bar area

            // Verify this position is within screen bounds
            GraphicsEnvironment ge = GraphicsEnvironment.getLocalGraphicsEnvironment();
            GraphicsDevice[] screens = ge.getScreenDevices();

            for (GraphicsDevice screen : screens) {
                GraphicsConfiguration gc = screen.getDefaultConfiguration();
                Rectangle screenBounds = gc.getBounds();

                if (x >= screenBounds.x && x + windowWidth <= screenBounds.x + screenBounds.width &&
                    y >= screenBounds.y && y + windowHeight <= screenBounds.y + screenBounds.height) {
                    // Position is valid on this screen
                    return new Point(x, y);
                }
            }
        }

        // Fallback: bottom-right of primary screen
        GraphicsEnvironment ge = GraphicsEnvironment.getLocalGraphicsEnvironment();
        GraphicsDevice gd = ge.getDefaultScreenDevice();
        GraphicsConfiguration gc = gd.getDefaultConfiguration();
        Rectangle screenBounds = gc.getBounds();

        Insets screenInsets = Toolkit.getDefaultToolkit().getScreenInsets(gc);
        int screenWidth = screenBounds.width - screenInsets.right - screenInsets.left;
        int screenHeight = screenBounds.height - screenInsets.top - screenInsets.bottom;

        int windowWidth = window.getWidth();
        int windowHeight = window.getHeight();

        int x = screenBounds.x + screenWidth - windowWidth - 10 + screenInsets.right;
        int y = screenBounds.y + screenHeight - windowHeight - 10 + screenInsets.bottom;

        return new Point(x, y);
    }

    /**
     * Animate notification window sliding in from bottom.
     */
    private void animateSlideIn(JWindow window, int targetY) {
        int startY = targetY + window.getHeight();
        int startX = window.getX();
        window.setLocation(startX, startY);

        final int steps = 10;
        final int delay = 20;

        Timer animTimer = new Timer(delay, null);
        animTimer.addActionListener(e -> {
            int currentY = window.getY();
            int step = (startY - targetY) / steps;

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
     * Activate and bring IDEA window to front.
     * Restores from minimized state and requests focus.
     */
    private void activateIdeWindow(@NotNull Project project) {
        try {
            // Get the IDE frame for the project
            JFrame frame = WindowManager.getInstance().getFrame(project);
            if (frame != null) {
                // Restore window if minimized
                int state = frame.getExtendedState();
                if ((state & Frame.ICONIFIED) != 0) {
                    frame.setExtendedState(state & ~Frame.ICONIFIED);
                }
                // Bring window to front and request focus
                frame.setVisible(true);
                frame.toFront();
                frame.requestFocus();

                // Additional focus request for reliability
                frame.repaint();
            }
        } catch (Exception e) {
            LOG.debug("[SystemNotification] Failed to activate IDEA window: " + e.getMessage());
        }
    }

    /**
     * Dispose the active notification window.
     * Called when the user closes the notification manually.
     */
    public void disposeNotification() {
        if (activeNotificationWindow != null) {
            activeNotificationWindow.dispose();
            activeNotificationWindow = null;
        }
    }
}
