package com.github.claudecodegui.pet.office;

import java.awt.Rectangle;
import java.util.Comparator;
import java.util.List;

/** Logical Swing coordinates; a removed display or smaller usable desktop cannot restore an off-screen Office. */
final class PetOfficeWindowGeometry {
    private PetOfficeWindowGeometry() { }

    static Rectangle restore(PetOfficePreferencesStore.Bounds saved, List<Rectangle> usable) {
        if (usable.isEmpty()) {
            throw new IllegalArgumentException("OFFICE_NO_RENDERER_AVAILABLE");
        }
        Rectangle old = new Rectangle(saved.x(), saved.y(), saved.width(), saved.height());
        Rectangle screen = saved.placed() ? usable.stream().max(Comparator.comparingLong(area -> {
            Rectangle overlap = area.intersection(old);
            return overlap.isEmpty() ? 0 : (long) overlap.width * overlap.height;
        })).orElse(usable.get(0)) : usable.get(0);
        if (!saved.placed() || !screen.intersects(old)) {
            screen = usable.get(0);
        }
        int width = Math.min(Math.max(320, saved.width()), screen.width);
        int height = Math.min(Math.max(320, saved.height()), screen.height);
        int x = saved.placed() ? Math.max(screen.x, Math.min(saved.x(), screen.x + screen.width - width)) : screen.x + (screen.width - width) / 2;
        int y = saved.placed() ? Math.max(screen.y, Math.min(saved.y(), screen.y + screen.height - height)) : screen.y + (screen.height - height) / 2;
        return new Rectangle(x, y, width, height);
    }
}
