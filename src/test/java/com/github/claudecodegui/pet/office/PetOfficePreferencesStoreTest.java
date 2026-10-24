package com.github.claudecodegui.pet.office;

import com.google.gson.Gson;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.util.Collections;

import static org.junit.Assert.*;

public class PetOfficePreferencesStoreTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder();

    @Test public void officeNameSurvivesTakeoverAndBoundsUpdatesWithLegacyDefaultsAndWindowTitles() throws Exception {
        var root = PetOfficeTestRoot.create(temporary);
        var store = new PetOfficePreferencesStore(root);
        var json = new Gson();
        var legacy = json.toJsonTree(PetOfficePreferencesStore.defaults()).getAsJsonObject();
        legacy.getAsJsonObject("preferences").remove("officeName");
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            new PetOfficeEndpointStore(root).writePrivate(PetOfficePreferencesStore.FILE, legacy, lease);
            var restored = store.read();
            assertFalse(restored.recovered());
            assertEquals("", restored.state().preferences().officeName());
            assertEquals(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("petOffice.prototype.title"),
                    PetOfficePrototypeService.windowTitle(restored.state().preferences()));
            var p = restored.state().preferences();
            var named = new PetOfficePreferencesStore.Preferences(p.limitMiB(), p.floors(), p.floor(), p.product(), p.search(),
                    p.showIdle(), p.paused(), p.topmost(), p.zoom(), p.presentation(), p.appearanceOverrides(), "研发办公室 🐾 <team>");
            var saved = store.update(restored.state().revision(), named, null, lease);
            assertEquals(named.officeName(), PetOfficePrototypeService.windowTitle(new PetOfficePreferencesStore(root).read().state().preferences()));
            var moved = store.update(saved.revision(), null, new PetOfficePreferencesStore.Bounds(50, 60, 1000, 700, true), lease);
            assertEquals(named, moved.preferences());
        }
        assertEquals("研发办公室 🐾 <team>", new PetOfficePreferencesStore(root).read().state().preferences().officeName());
    }

    @Test public void malformedOfficeNamesAreRejectedBeforeReplacingTheSavedRecord() throws Exception {
        var root = PetOfficeTestRoot.create(temporary);
        var store = new PetOfficePreferencesStore(root);
        var json = new Gson();
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            for (var invalid : new Object[]{null, 100, true, "x".repeat(65), "line\nbreak", "control\u0085"}) {
                var raw = json.toJsonTree(store.read().state().preferences()).getAsJsonObject();
                raw.add("officeName", json.toJsonTree(invalid));
                assertThrows(IOException.class, () -> PetOfficePreferencesStore.preferences(raw));
            }
            var raw = json.toJsonTree(store.read().state().preferences()).getAsJsonObject();
            raw.addProperty("officeName", "🐾".repeat(64));
            var named = PetOfficePreferencesStore.preferences(raw);
            var saved = store.update("initial", named, null, lease);
            assertEquals(named, new PetOfficePreferencesStore(root).read().state().preferences());
            var invalid = new PetOfficePreferencesStore.Preferences(named.limitMiB(), named.floors(), named.floor(), named.product(), named.search(),
                    named.showIdle(), named.paused(), named.topmost(), named.zoom(), named.presentation(), named.appearanceOverrides(), "x".repeat(65));
            assertThrows(IOException.class, () -> store.update(saved.revision(), invalid, null, lease));
            assertEquals(saved, store.read().state());
        }
    }

    @Test public void defaultsAndEverySupportedPreferenceSurviveANewOwnerWithRevisionChecks() throws Exception {
        var root = PetOfficeTestRoot.create(temporary); var store = new PetOfficePreferencesStore(root);
        assertEquals(50, store.read().state().preferences().limitMiB());
        PetOfficePreferencesStore.State saved;
        var changed = new PetOfficePreferencesStore.Preferences(128, Collections.nCopies(PetOfficeSessionRegistry.MAX_FLOORS, "cyberpunk"), 21, "PyCharm", "test", true, true, false, 125);
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            saved = store.update("initial", changed, new PetOfficePreferencesStore.Bounds(-1800, 40, 1240, 900, true), lease);
            assertThrows(IOException.class, () -> store.update("initial", changed, null, lease));
        }
        assertEquals(saved, new PetOfficePreferencesStore(root).read().state());
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            var next = store.update(saved.revision(), null, new PetOfficePreferencesStore.Bounds(30, 40, 800, 700, true), lease);
            assertEquals(changed, next.preferences()); assertNotEquals(saved.revision(), next.revision());
        }
    }

    @Test public void illustratedThemesSurviveAnOwnerChangeAndUnknownThemesRemainRejected() throws Exception {
        var root = PetOfficeTestRoot.create(temporary);
        var store = new PetOfficePreferencesStore(root);
        var floors = new java.util.ArrayList<>(Collections.nCopies(PetOfficeSessionRegistry.MAX_FLOORS, "loft"));
        var themes = java.util.List.of("forest", "library", "ocean", "zen", "retro");
        for (int index = 0; index < themes.size(); index++) {
            floors.set(index * 3, themes.get(index));
        }
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            var changed = new PetOfficePreferencesStore.Preferences(50, floors, 0, "all", "", false, false, true, 100);
            var saved = store.update("initial", changed, null, lease);
            assertEquals(changed, new PetOfficePreferencesStore(root).read().state().preferences());
            floors.set(0, "unknown");
            var invalid = new PetOfficePreferencesStore.Preferences(50, floors, 0, "all", "", false, false, true, 100);
            assertThrows(IOException.class, () -> store.update(saved.revision(), invalid, null, lease));
            assertEquals(saved, store.read().state());
        }
    }

    @Test public void aValidatedBackupRecoversPreferencesWithoutRestoringModeOrAcknowledgements() throws Exception {
        var root = PetOfficeTestRoot.create(temporary); var store = new PetOfficePreferencesStore(root); var modes = new PetOfficeModeStore(root);
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            var entering = modes.beginEnter("owner", lease); assertTrue(modes.commitOffice(entering, lease));
            store.update("initial", limit(64), null, lease);
            Files.writeString(root.resolve(PetOfficePreferencesStore.FILE), "{\"schemaVersion\":99}");
            var recovered = store.read(); assertTrue(recovered.recovered()); assertEquals(50, recovered.state().preferences().limitMiB());
            var next = store.update(recovered.state().revision(), limit(96), null, lease);
            assertNotEquals(recovered.state().revision(), next.revision()); assertFalse(store.read().recovered());
            assertEquals(PetOfficeModeStore.Mode.OFFICE, modes.read().mode());
        }
    }

    @Test public void invalidBothCopiesOrStaleLeaseCannotOverwriteTheSharedRecord() throws Exception {
        var root = PetOfficeTestRoot.create(temporary); var store = new PetOfficePreferencesStore(root);
        var old = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow();
        try (old) { store.update("initial", limit(64), null, old); }
        assertThrows(IOException.class, () -> store.update(store.read().state().revision(), limit(128), null, old));
        Files.writeString(root.resolve(PetOfficePreferencesStore.FILE), "invalid");
        Files.writeString(root.resolve(PetOfficePreferencesStore.BACKUP), "invalid");
        assertThrows(IOException.class, store::read);
    }

    @Test public void limitsTypesExtraFieldsAndControlCharactersAreRejectedBeforeWriting() throws Exception {
        var root = PetOfficeTestRoot.create(temporary); var store = new PetOfficePreferencesStore(root);
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            for (int limit : new int[]{0, 15, 257}) {
                assertThrows(IOException.class, () -> store.update("initial", limit(limit), null, lease));
            }
            var raw = new Gson().toJsonTree(PetOfficePreferencesStore.defaults().preferences()).getAsJsonObject();
            raw.addProperty("path", "outside");
            assertThrows(IOException.class, () -> PetOfficePreferencesStore.preferences(raw));
            raw.remove("path"); raw.addProperty("search", "test\nline");
            assertThrows(IOException.class, () -> PetOfficePreferencesStore.preferences(raw));
            assertEquals("initial", store.read().state().revision());
        }
    }

    @Test public void legacyFloorSettingsAreExtendedWithoutResettingExistingStylesOrWindowState() throws Exception {
        var root = PetOfficeTestRoot.create(temporary);
        var store = new PetOfficePreferencesStore(root);
        var json = new Gson();
        var original = json.toJsonTree(PetOfficePreferencesStore.defaults()).getAsJsonObject();
        var preferences = original.getAsJsonObject("preferences");
        preferences.add("floors", json.toJsonTree(Collections.nCopies(16, "forest")));
        preferences.addProperty("floor", 15);
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            new PetOfficeEndpointStore(root).writePrivate(PetOfficePreferencesStore.FILE, original, lease);
            var restored = store.read();
            assertFalse(restored.recovered());
            assertEquals(Collections.nCopies(16, "forest"), restored.state().preferences().floors().subList(0, 16));
            assertEquals(Collections.nCopies(6, "loft"), restored.state().preferences().floors().subList(16, 22));
            assertEquals(15, restored.state().preferences().floor());
            assertEquals(PetOfficePreferencesStore.defaults().bounds(), restored.state().bounds());
            var next = new PetOfficePreferencesStore.Preferences(50, restored.state().preferences().floors(), 21, "all", "", false, false, true, 100);
            var saved = store.update(restored.state().revision(), next, null, lease);
            assertEquals(next, new PetOfficePreferencesStore(root).read().state().preferences());
            var invalid = json.toJsonTree(next).getAsJsonObject();
            invalid.addProperty("floor", 22);
            assertThrows(IOException.class, () -> PetOfficePreferencesStore.preferences(invalid));
            invalid.addProperty("floor", 0);
            invalid.add("floors", json.toJsonTree(Collections.nCopies(17, "forest")));
            assertThrows(IOException.class, () -> PetOfficePreferencesStore.preferences(invalid));
            assertEquals(saved, store.read().state());
        }
    }

    private static PetOfficePreferencesStore.Preferences limit(int value) {
        var defaults = PetOfficePreferencesStore.defaults().preferences();
        return new PetOfficePreferencesStore.Preferences(value, defaults.floors(), 0, "all", "", false, false, true, 100);
    }

    @Test public void presentationSettingsSurviveTakeoverAndLegacyRecordsGetValidatedDefaults() throws Exception {
        var root = PetOfficeTestRoot.create(temporary);
        var store = new PetOfficePreferencesStore(root);
        var json = new Gson();
        var legacy = json.toJsonTree(PetOfficePreferencesStore.defaults()).getAsJsonObject();
        legacy.getAsJsonObject("preferences").remove("presentation");
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            new PetOfficeEndpointStore(root).writePrivate(PetOfficePreferencesStore.FILE, legacy, lease);
            var restored = store.read();
            assertFalse(restored.recovered());
            assertEquals(new PetOfficePreferencesStore.Presentation(true, true, true, true), restored.state().preferences().presentation());
            var p = restored.state().preferences();
            var changed = new PetOfficePreferencesStore.Preferences(p.limitMiB(), p.floors(), p.floor(), p.product(), p.search(),
                    p.showIdle(), p.paused(), p.topmost(), p.zoom(), new PetOfficePreferencesStore.Presentation(false, true, false, true));
            var saved = store.update(restored.state().revision(), changed, null, lease);
            assertEquals(saved, new PetOfficePreferencesStore(root).read().state());
        }
    }

    @Test public void malformedPresentationSettingsAreRejectedWithoutResettingStoredChoices() throws Exception {
        var json = new Gson();
        for (String malformed : new String[]{"null", "true", "{}", "{\"effects\":true,\"attention\":true,\"ambience\":true,\"depth\":\"true\"}",
                "{\"effects\":true,\"attention\":true,\"ambience\":true,\"depth\":true,\"path\":\"outside\"}"}) {
            var value = json.toJsonTree(PetOfficePreferencesStore.defaults().preferences()).getAsJsonObject();
            value.add("presentation", com.google.gson.JsonParser.parseString(malformed));
            assertThrows(IOException.class, () -> PetOfficePreferencesStore.preferences(value));
        }
    }
    @Test public void sessionOverridesSurviveTakeoverAndLegacyPreferencesDefaultToInheritance() throws Exception {
        var root = PetOfficeTestRoot.create(temporary);
        var store = new PetOfficePreferencesStore(root);
        var json = new Gson();
        var legacy = json.toJsonTree(PetOfficePreferencesStore.defaults()).getAsJsonObject();
        legacy.getAsJsonObject("preferences").remove("appearanceOverrides");
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            new PetOfficeEndpointStore(root).writePrivate(PetOfficePreferencesStore.FILE, legacy, lease);
            var restored = store.read(); assertTrue(restored.state().preferences().appearanceOverrides().isEmpty());
            var p = restored.state().preferences();
            var map = new java.util.HashMap<String, String>(); map.put("ide/tab/binding", "duck/spritesheet.png");
            var changed = new PetOfficePreferencesStore.Preferences(p.limitMiB(), p.floors(), p.floor(), p.product(), p.search(),
                    p.showIdle(), p.paused(), p.topmost(), p.zoom(), p.presentation(), map);
            map.clear(); assertEquals(1, changed.appearanceOverrides().size());
            var saved = store.update(restored.state().revision(), changed, null, lease);
            assertEquals(saved, new PetOfficePreferencesStore(root).read().state());
        }
    }

    @Test public void invalidSessionOverridesCannotReplaceTheSharedRecord() throws Exception {
        var json = new Gson();
        for (String invalid : new String[]{"null", "[]", "{\"ide/tab\":\"builtin\"}", "{\"ide/tab/binding\":\"../private.png\"}",
                "{\"ide/tab/binding\":true}", "{\"ide/tab/binding\":{\"petId\":\"builtin\"}}"}) {
            var value = json.toJsonTree(PetOfficePreferencesStore.defaults().preferences()).getAsJsonObject();
            value.add("appearanceOverrides", com.google.gson.JsonParser.parseString(invalid));
            assertThrows(IOException.class, () -> PetOfficePreferencesStore.preferences(value));
        }
    }
}
