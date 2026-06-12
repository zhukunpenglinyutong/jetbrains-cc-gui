package com.github.claudecodegui.ui.toolwindow;

import com.intellij.ui.JBColor;

import javax.swing.*;
import java.awt.*;
import java.awt.geom.*;

/**
 * Colored icons for tab context menu items.
 * Uses JBColor for automatic light/dark theme adaptation.
 */
final class TabMenuIcons {

    // ---- Category colors ----
    static final JBColor RED    = new JBColor(new Color(0xF14C4C), new Color(0xF14C4C));
    static final JBColor BLUE   = new JBColor(new Color(0x3794FF), new Color(0x3794FF));
    static final JBColor GREEN  = new JBColor(new Color(0x89D185), new Color(0x89D185));
    static final JBColor VIOLET = new JBColor(new Color(0xA989FF), new Color(0xA989FF));
    static final JBColor AMBER  = new JBColor(new Color(0xE7B85A), new Color(0xE7B85A));

    private TabMenuIcons() {}

    // ---- Icon instances (cached) ----

    static Icon closeAll() {
        return new SvgIcon(16, 16, RED) {
            @Override
            protected void draw(Graphics2D g) {
                g.draw(new RoundRectangle2D.Double(2.5, 2.5, 11, 11, 1.5, 1.5));
                g.draw(new Line2D.Double(5.5, 5.5, 10.5, 10.5));
                g.draw(new Line2D.Double(10.5, 5.5, 5.5, 10.5));
            }
        };
    }

    static Icon closeOther() {
        return new SvgIcon(16, 16, RED) {
            @Override
            protected void draw(Graphics2D g) {
                g.draw(new RoundRectangle2D.Double(4.5, 4.5, 7, 7, 1.5, 1.5));
                g.draw(new Line2D.Double(7, 6.5, 7, 9.5));
                g.draw(new Line2D.Double(5.5, 8, 8.5, 8));
                g.setStroke(new BasicStroke(1f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
                g.draw(new RoundRectangle2D.Double(2, 2, 12, 12, 2, 2));
            }
        };
    }

    static Icon nextTab() {
        return new SvgIcon(16, 16, BLUE) {
            @Override
            protected void draw(Graphics2D g) {
                Path2D p = new Path2D.Double();
                p.moveTo(6, 3);
                p.lineTo(11, 8);
                p.lineTo(6, 13);
                g.draw(p);
            }
        };
    }

    static Icon prevTab() {
        return new SvgIcon(16, 16, BLUE) {
            @Override
            protected void draw(Graphics2D g) {
                Path2D p = new Path2D.Double();
                p.moveTo(10, 3);
                p.lineTo(5, 8);
                p.lineTo(10, 13);
                g.draw(p);
            }
        };
    }

    static Icon rename() {
        return new SvgIcon(16, 16, GREEN) {
            @Override
            protected void draw(Graphics2D g) {
                Path2D pencil = new Path2D.Double();
                pencil.moveTo(11.5, 1.5);
                pencil.lineTo(14.5, 4.5);
                pencil.lineTo(5, 14);
                pencil.lineTo(2, 14);
                pencil.lineTo(2, 11);
                pencil.closePath();
                g.draw(pencil);
                g.draw(new Line2D.Double(10, 3, 13, 6));
            }
        };
    }

    static Icon detach() {
        return new SvgIcon(16, 16, VIOLET) {
            @Override
            protected void draw(Graphics2D g) {
                // Small window
                g.draw(new RoundRectangle2D.Double(1.5, 7.5, 6, 6, 1, 1));
                // Large window outline
                g.draw(new RoundRectangle2D.Double(5.5, 1.5, 9, 6, 1, 1));
                // Arrow from small to large
                g.draw(new Line2D.Double(7.5, 6, 7.5, 3.5));
                g.draw(new Line2D.Double(6, 5, 7.5, 3.5));
                g.draw(new Line2D.Double(9, 5, 7.5, 3.5));
            }
        };
    }

    static Icon saveTemplate() {
        return new SvgIcon(16, 16, AMBER) {
            @Override
            protected void draw(Graphics2D g) {
                // Document shape
                Path2D doc = new Path2D.Double();
                doc.moveTo(3, 1.5);
                doc.lineTo(10, 1.5);
                doc.lineTo(13, 4.5);
                doc.lineTo(13, 14.5);
                doc.lineTo(3, 14.5);
                doc.closePath();
                g.draw(doc);
                // Fold corner
                g.draw(new Line2D.Double(10, 1.5, 10, 4.5));
                g.draw(new Line2D.Double(10, 4.5, 13, 4.5));
                // Checkmark
                g.draw(new Line2D.Double(5.5, 9.5, 7.5, 11.5));
                g.draw(new Line2D.Double(7.5, 11.5, 11, 7));
            }
        };
    }

    static Icon createFromTemplate() {
        return new SvgIcon(16, 16, AMBER) {
            @Override
            protected void draw(Graphics2D g) {
                // Document shape
                Path2D doc = new Path2D.Double();
                doc.moveTo(3, 1.5);
                doc.lineTo(10, 1.5);
                doc.lineTo(13, 4.5);
                doc.lineTo(13, 14.5);
                doc.lineTo(3, 14.5);
                doc.closePath();
                g.draw(doc);
                // Fold corner
                g.draw(new Line2D.Double(10, 1.5, 10, 4.5));
                g.draw(new Line2D.Double(10, 4.5, 13, 4.5));
                // Plus
                g.draw(new Line2D.Double(8, 6.5, 8, 12.5));
                g.draw(new Line2D.Double(5, 9.5, 11, 9.5));
            }
        };
    }

    // ---- Base icon class ----

    abstract static class SvgIcon implements Icon {
        private final int width;
        private final int height;
        private final JBColor color;

        SvgIcon(int width, int height, JBColor color) {
            this.width = width;
            this.height = height;
            this.color = color;
        }

        @Override
        public int getIconWidth() { return width; }

        @Override
        public int getIconHeight() { return height; }

        @Override
        public void paintIcon(Component c, Graphics g, int x, int y) {
            Graphics2D g2 = (Graphics2D) g.create();
            g2.translate(x, y);
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g2.setStroke(new BasicStroke(1.4f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));

            // Detect disabled state from parent JMenuItem
            boolean enabled = true;
            if (c instanceof JMenuItem) {
                enabled = c.isEnabled();
            }
            g2.setColor(enabled ? color : JBColor.GRAY);

            draw(g2);
            g2.dispose();
        }

        protected abstract void draw(Graphics2D g);
    }
}
