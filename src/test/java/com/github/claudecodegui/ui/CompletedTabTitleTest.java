package com.github.claudecodegui.ui;

import com.intellij.ui.content.Content;
import org.junit.Test;

import javax.swing.JLabel;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.lang.reflect.Proxy;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.*;

public class CompletedTabTitleTest {
    @Test
    public void titleDecorationRoundTripsEscapedNamesAndDoesNotDuplicateOnRefresh() {
        AtomicReference<String> title = new AtomicReference<>("AI <review> & \"quoted\"");
        Content content = (Content) Proxy.newProxyInstance(Content.class.getClassLoader(), new Class<?>[]{Content.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("getDisplayName")) return title.get();
                    if (method.getName().equals("setDisplayName")) { title.set((String) args[0]); return null; }
                    return method.getReturnType() == boolean.class ? false : null;
                });
        CompletedTabTitle.show(content);
        String decorated = title.get();
        CompletedTabTitle.show(content);
        assertEquals(decorated, title.get());
        assertEquals("AI <review> & \"quoted\"", CompletedTabTitle.plain(content));
        CompletedTabTitle.hide(content);
        assertEquals("AI <review> & \"quoted\"", title.get());
    }

    @Test
    public void greenDotRendersAboveTheRightEdgeInACompactAreaInBothThemesAndScales() {
        for (Color background : new Color[]{Color.WHITE, new Color(0x2B2D30)}) {
            for (int scale : new int[]{1, 2}) {
                JLabel label = new JLabel(CompletedTabTitle.completed("AI12"));
                label.setFont(new Font(Font.DIALOG, Font.PLAIN, 13));
                label.setForeground(background.equals(Color.WHITE) ? Color.BLACK : Color.WHITE);
                label.setOpaque(true);
                label.setBackground(background);
                label.setSize(label.getPreferredSize());
                JLabel plain = new JLabel("AI12");
                plain.setFont(label.getFont());
                assertTrue("A dot must not reserve the old 16px icon slot",
                        label.getWidth() - plain.getPreferredSize().width <= 8);
                BufferedImage image = new BufferedImage(label.getWidth() * scale, label.getHeight() * scale,
                        BufferedImage.TYPE_INT_ARGB);
                Graphics2D graphics = image.createGraphics();
                try { graphics.scale(scale, scale); label.paint(graphics); } finally { graphics.dispose(); }
                int pixels = 0, minX = image.getWidth(), maxY = -1;
                for (int y = 0; y < image.getHeight(); y++) {
                    for (int x = 0; x < image.getWidth(); x++) {
                        Color color = new Color(image.getRGB(x, y), true);
                        if (color.getAlpha() > 100 && color.getGreen() > 1.3 * color.getRed()
                                && color.getGreen() > 1.2 * color.getBlue()) {
                            pixels++; minX = Math.min(minX, x); maxY = Math.max(maxY, y);
                        }
                    }
                }
                assertTrue("Green completion dot must be visible", pixels >= 3 * scale * scale);
                assertTrue("Dot belongs after the title", minX >= (plain.getPreferredSize().width - 2) * scale);
                assertTrue("Dot belongs above the text baseline", maxY < image.getHeight() * 0.65);
            }
        }
    }
}
