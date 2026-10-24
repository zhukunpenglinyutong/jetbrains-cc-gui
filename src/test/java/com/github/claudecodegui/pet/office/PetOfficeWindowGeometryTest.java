package com.github.claudecodegui.pet.office;

import org.junit.Test;
import java.awt.Rectangle;
import java.util.List;
import static org.junit.Assert.*;

public class PetOfficeWindowGeometryTest {
    @Test public void restoresNegativeCoordinatesOnAnExistingSecondaryDisplay() {
        var saved = new PetOfficePreferencesStore.Bounds(-1700, 20, 1000, 800, true);
        assertEquals(new Rectangle(-1700, 20, 1000, 800), PetOfficeWindowGeometry.restore(saved,
                List.of(new Rectangle(0, 0, 1920, 1040), new Rectangle(-1920, 0, 1920, 1040))));
    }
    @Test public void aRemovedDisplayAndSmallerUsableAreaKeepTheWholeWindowReachable() {
        var saved = new PetOfficePreferencesStore.Bounds(5000, -2000, 1240, 900, true);
        assertEquals(new Rectangle(0, 40, 800, 600), PetOfficeWindowGeometry.restore(saved, List.of(new Rectangle(0, 40, 800, 600))));
    }
    @Test public void aTinyDesktopAndDefaultCenteringDoNotUseOverlayRelativeCoordinates() {
        assertEquals(new Rectangle(25, 0, 1240, 900), PetOfficeWindowGeometry.restore(PetOfficePreferencesStore.defaults().bounds(), List.of(new Rectangle(0, 0, 1290, 900))));
        assertEquals(new Rectangle(0, 0, 300, 250), PetOfficeWindowGeometry.restore(PetOfficePreferencesStore.defaults().bounds(), List.of(new Rectangle(0, 0, 300, 250))));
    }
}
