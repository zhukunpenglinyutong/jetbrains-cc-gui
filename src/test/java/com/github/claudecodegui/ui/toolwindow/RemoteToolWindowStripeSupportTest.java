package com.github.claudecodegui.ui.toolwindow;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import static org.junit.Assert.*;

public class RemoteToolWindowStripeSupportTest {
    public static final class Property {
        Object value;
        final List<Object> updates = new ArrayList<>();
        Consumer<Object> listener = ignored -> { };
        Property(Object value) { this.value = value; }
        public Object getValueOrNull() { return value; }
        public void set(Object value) {
            this.value = value;
            updates.add(value);
            listener.accept(value);
        }
    }

    public static final class WindowModel {
        final Property state = new Property(null);
        public Property getState() { return state; }
    }

    /** The client registers a bundled generic factory with no initial stripe button. */
    public static final class RemoteModel {
        final Property large = new Property(null);
        final Property available = new Property(null);
        final WindowModel window = new WindowModel();
        boolean frontendAvailable = true;
        boolean pinned;
        boolean buttonCreated;
        RemoteModel() {
            large.listener = value -> pinned = Boolean.TRUE.equals(value);
            available.listener = value -> {
                boolean next = Boolean.TRUE.equals(value);
                if (!frontendAvailable && next && pinned) buttonCreated = true;
                frontendAvailable = next;
            };
        }
        public Property isVisibleOnLargeStripe() { return large; }
        public Property getAvailable() { return available; }
        public WindowModel getToolWindow() { return window; }
        void pin() { RemoteToolWindowStripeSupport.pinEntry(Map.entry("CCG", this)); }
    }

    @Test
    public void freshModelIsPinnedBeforeIDEAvailabilityCreatesTheButton() {
        RemoteModel model = new RemoteModel();
        model.pin();
        assertTrue(model.pinned);
        assertFalse(model.frontendAvailable);
        assertFalse(model.buttonCreated);
        assertEquals(List.of(false), model.available.updates);
        model.available.set(true);
        assertTrue(model.frontendAvailable);
        assertTrue(model.buttonCreated);
        assertTrue(model.window.state.updates.isEmpty());
    }

    @Test
    public void hiddenExistingBrowserIsNeverDetachedToRepairItsLauncher() {
        RemoteModel model = new RemoteModel();
        model.available.value = true;
        model.window.state.value = "Hidden";
        model.pin();
        assertTrue(model.large.updates.isEmpty());
        assertTrue(model.available.updates.isEmpty());
        assertTrue(model.window.state.updates.isEmpty());
    }

    @Test
    public void visibleChatHasNoLayoutOrAvailabilityChanges() {
        for (String state : List.of("Active", "ActiveAndFocused")) {
            RemoteModel model = new RemoteModel();
            model.available.value = true;
            model.window.state.value = state;
            model.pin();
            assertTrue(model.large.updates.isEmpty());
            assertTrue(model.available.updates.isEmpty());
            assertTrue(model.window.state.updates.isEmpty());
        }
    }

    @Test
    public void aRestoredClientStateIsNotTreatedAsAFreshModel() {
        RemoteModel model = new RemoteModel();
        model.window.state.value = "Hidden";
        model.pin();
        assertTrue(model.large.updates.isEmpty());
        assertTrue(model.available.updates.isEmpty());
    }

    @Test
    public void unavailableWindowStaysUnavailable() {
        RemoteModel model = new RemoteModel();
        model.available.value = false;
        model.pin();
        assertEquals(false, model.available.value);
        assertTrue(model.large.updates.isEmpty());
        assertTrue(model.available.updates.isEmpty());
    }

    @Test
    public void unrelatedToolWindowsAreNotInspectedOrChanged() {
        RemoteToolWindowStripeSupport.pinEntry(Map.entry("Terminal", new Object()));
    }

    @Test
    public void reconnectInitializesOnlyTheNewModel() {
        RemoteModel old = new RemoteModel();
        old.available.value = true;
        old.window.state.value = "Active";
        old.pin();
        RemoteModel reconnected = new RemoteModel();
        reconnected.pin();
        reconnected.available.set(true);
        assertTrue(old.large.updates.isEmpty());
        assertTrue(old.available.updates.isEmpty());
        assertTrue(reconnected.buttonCreated);
    }

    @Test
    public void missingOptionalAPILeavesTheModelUnchanged() {
        RemoteToolWindowStripeSupport.pinEntry(Map.entry("CCG", new Object()));
    }
}
