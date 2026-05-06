package com.github.claudecodegui.util;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.WindowManager;
import com.intellij.util.ui.JBUI;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.ImageIcon;
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
import java.awt.Component;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.Font;
import java.awt.Frame;
import java.awt.GraphicsConfiguration;
import java.awt.GraphicsDevice;
import java.awt.Graphics2D;
import java.awt.GraphicsEnvironment;
import java.awt.Insets;
import java.awt.Point;
import java.awt.Rectangle;
import java.awt.RenderingHints;
import java.awt.Toolkit;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.image.BufferedImage;
import java.net.URL;

/**
 * System notification service.
 * Provides visual system notifications (custom toast window) and delegates sound notifications.
 */
public class SystemNotificationService {

    private static final Logger LOG = Logger.getInstance(SystemNotificationService.class);

    private static final int MAX_MESSAGE_LENGTH = 220;
    // Tightened so titles fit on a single 14pt-bold line in WINDOW_WIDTH for both
    // CJK and Latin scripts, avoiding HTML JLabel height-measurement issues
    // that can clip wrapped titles inside BoxLayout.
    private static final int MAX_TITLE_LENGTH = 35;
    private static final int MESSAGE_ELLIPSIS_TAIL = 3;
    private static final int WINDOW_WIDTH = 380;
    private static final int AUTO_CLOSE_MS = 10_000;
    private static final int ANIM_STEPS = 10;
    private static final int ANIM_DELAY_MS = 20;
    private static final int BRAND_ICON_SIZE = 40;

    // Layout constants used by createNotificationWindow / buildTextPanel.
    private static final int CONTENT_PADDING_LEFT = 18;
    private static final int CONTENT_PADDING_RIGHT = 14;
    private static final int CONTENT_HGAP = 14;
    private static final int CLOSE_BUTTON_WIDTH = 24;
    private static final int ACCENT_BAR_WIDTH = 4;

    private static volatile SystemNotificationService instance;

    // Track active notification window to prevent duplicates. Only mutated on EDT.
    private JWindow activeNotificationWindow = null;

    // Cached scaled brand icon. Loaded lazily on EDT and reused across notifications.
    private ImageIcon cachedBrandIcon = null;
    private int cachedBrandIconSize = 0;

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
     * Show visual notification window with a fallback title.
     */
    public void showVisualNotificationToast(@NotNull Project project, String message) {
        showVisualNotificationToast(project, null, message);
    }

    /**
     * Show visual notification window with an explicit dynamic title.
     * When {@code title} is null/blank, the i18n default
     * {@code notifier.taskComplete.title} is used.
     */
    public void showVisualNotificationToast(@NotNull Project project, @Nullable String title, String message) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (project.isDisposed()) {
                return;
            }
            try {
                if (!isEnabled()) {
                    return;
                }
                disposeActiveWindow();

                String resolvedTitle = sanitizeTitle(title);
                JWindow window = createNotificationWindow(project, resolvedTitle, sanitizeMessage(message));
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
            LOG.debug("[SystemNotification] Failed to read enabled flag, defaulting to false: " + e.getMessage());
            return false;
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
        return truncateAndEscape(raw == null ? "" : raw, MAX_MESSAGE_LENGTH);
    }

    /**
     * Resolve the toast title: use the caller-provided title when non-blank,
     * otherwise fall back to the i18n default. The returned string is HTML-escaped
     * and truncated for safe embedding in a JLabel.
     */
    private String sanitizeTitle(@Nullable String raw) {
        String chosen = (raw == null || raw.trim().isEmpty())
            ? ClaudeCodeGuiBundle.message("notifier.taskComplete.title")
            : raw.trim();
        return truncateAndEscape(chosen, MAX_TITLE_LENGTH);
    }

    private String truncateAndEscape(String text, int maxLength) {
        int cpCount = text.codePointCount(0, text.length());
        if (cpCount > maxLength) {
            int end = text.offsetByCodePoints(0, maxLength - MESSAGE_ELLIPSIS_TAIL);
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

    private JWindow createNotificationWindow(@NotNull Project project, String escapedTitle, String escapedMessage) {
        JWindow window = new JWindow();
        window.setAlwaysOnTop(true);

        boolean isDark = UIManager.getBoolean("Editor.isDarkTheme");
        Color bgColor = isDark ? new Color(40, 42, 48) : new Color(255, 255, 255);
        Color textColor = isDark ? new Color(240, 240, 242) : new Color(28, 28, 32);
        Color subtextColor = isDark ? new Color(186, 188, 195) : new Color(90, 92, 100);
        Color borderColor = isDark ? new Color(0, 0, 0, 130) : new Color(0, 0, 0, 50);
        Color accentColor = new Color(95, 99, 240); // Brand purple accent

        JPanel mainPanel = new JPanel(new BorderLayout());
        mainPanel.setBorder(BorderFactory.createLineBorder(borderColor, 1));
        mainPanel.setBackground(bgColor);

        JPanel contentPanel = new JPanel(new BorderLayout(JBUI.scale(CONTENT_HGAP), 0));
        contentPanel.setBorder(new EmptyBorder(
            JBUI.scale(18), JBUI.scale(CONTENT_PADDING_LEFT),
            JBUI.scale(18), JBUI.scale(CONTENT_PADDING_RIGHT)));
        contentPanel.setBackground(bgColor);

        JPanel accentBar = new JPanel();
        accentBar.setBackground(accentColor);
        accentBar.setPreferredSize(new Dimension(JBUI.scale(ACCENT_BAR_WIDTH), 0));

        JLabel iconLabel = createBrandIconLabel();

        JPanel textPanel = buildTextPanel(escapedTitle, escapedMessage, textColor, subtextColor);
        JButton closeButton = createCloseButton(window, isDark, subtextColor);

        JPanel rightPanel = new JPanel(new BorderLayout());
        rightPanel.setOpaque(false);
        rightPanel.add(closeButton, BorderLayout.NORTH);

        contentPanel.add(iconLabel, BorderLayout.WEST);
        contentPanel.add(textPanel, BorderLayout.CENTER);
        contentPanel.add(rightPanel, BorderLayout.EAST);

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

    /**
     * Build brand icon label using the plugin logo, scaled to {@link #BRAND_ICON_SIZE}.
     * Falls back to system information icon when the logo resource cannot be loaded.
     * Caches the scaled icon (per scaled size) to avoid re-decoding on every notification.
     */
    private JLabel createBrandIconLabel() {
        JLabel iconLabel = new JLabel();
        iconLabel.setHorizontalAlignment(SwingConstants.CENTER);
        iconLabel.setVerticalAlignment(SwingConstants.TOP);
        int size = JBUI.scale(BRAND_ICON_SIZE);
        iconLabel.setPreferredSize(new Dimension(size, size));
        iconLabel.setBorder(new EmptyBorder(JBUI.scale(2), 0, 0, 0));

        ImageIcon brandIcon = loadBrandIcon(size);
        if (brandIcon != null) {
            iconLabel.setIcon(brandIcon);
            return iconLabel;
        }

        iconLabel.setIcon(UIManager.getIcon("OptionPane.informationIcon"));
        return iconLabel;
    }

    /**
     * Load (and cache) the brand icon scaled to the given pixel size. Returns null on failure.
     * Must be called on EDT — fields are not synchronized.
     */
    private ImageIcon loadBrandIcon(int size) {
        if (cachedBrandIcon != null && cachedBrandIconSize == size) {
            return cachedBrandIcon;
        }
        try {
            URL iconUrl = getClass().getResource("/icons/logo.png");
            if (iconUrl == null) {
                return null;
            }
            // ImageIO.read blocks until the image is fully decoded, avoiding the half-loaded
            // frame that ImageIcon(URL) + drawImage can produce on slow filesystems.
            BufferedImage source = javax.imageio.ImageIO.read(iconUrl);
            if (source == null) {
                return null;
            }
            BufferedImage buffer = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
            Graphics2D g = buffer.createGraphics();
            try {
                g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
                g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
                g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                g.drawImage(source, 0, 0, size, size, null);
            } finally {
                g.dispose();
            }
            cachedBrandIcon = new ImageIcon(buffer);
            cachedBrandIconSize = size;
            return cachedBrandIcon;
        } catch (Exception e) {
            LOG.debug("[SystemNotification] Failed to load brand icon: " + e.getMessage());
            return null;
        }
    }

    /**
     * Pixel width budget available for title and message labels inside the toast.
     * Derived from layout constants so changes to padding/icon size stay consistent.
     */
    private int computeTextWidthPx() {
        int budget = WINDOW_WIDTH
            - BRAND_ICON_SIZE
            - CLOSE_BUTTON_WIDTH
            - (CONTENT_HGAP * 2)
            - CONTENT_PADDING_LEFT
            - CONTENT_PADDING_RIGHT
            - ACCENT_BAR_WIDTH;
        return JBUI.scale(Math.max(budget, 160));
    }

    private JPanel buildTextPanel(String escapedTitle, String escapedMessage, Color textColor, Color subtextColor) {
        JPanel textPanel = new JPanel();
        textPanel.setLayout(new BoxLayout(textPanel, BoxLayout.Y_AXIS));
        textPanel.setOpaque(false);

        int textWidth = computeTextWidthPx();

        JLabel titleLabel = new JLabel(
            "<html><body style='width: " + textWidth + "px; margin: 0;'>"
                + escapedTitle + "</body></html>");
        titleLabel.setFont(titleLabel.getFont().deriveFont(Font.BOLD, 14f));
        titleLabel.setForeground(textColor);
        titleLabel.setAlignmentX(Component.LEFT_ALIGNMENT);

        JLabel messageLabel = new JLabel(
            "<html><body style='width: " + textWidth + "px; margin: 0; line-height: 1.5;'>"
                + escapedMessage + "</body></html>");
        messageLabel.setFont(messageLabel.getFont().deriveFont(13f));
        messageLabel.setForeground(subtextColor);
        messageLabel.setAlignmentX(Component.LEFT_ALIGNMENT);

        textPanel.add(titleLabel);
        textPanel.add(Box.createVerticalStrut(JBUI.scale(6)));
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
        closeButton.setPreferredSize(new Dimension(JBUI.scale(CLOSE_BUTTON_WIDTH), JBUI.scale(CLOSE_BUTTON_WIDTH)));
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
