package com.github.claudecodegui.settings;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.PersistentStateComponent;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.components.State;
import com.intellij.openapi.components.Storage;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.HashMap;
import java.util.Map;

/** Supplier identities follow history across projects; credentials stay in supplier configuration. */
@Service(Service.Level.APP)
@State(name = "CCGuiSessionSuppliers", storages = @Storage("ccgui-session-suppliers.xml"))
public final class SessionSupplierStateService implements PersistentStateComponent<SessionSupplierStateService.Bindings> {
    private final Map<String, String> bindings = new HashMap<>();

    public static @Nullable SessionSupplierStateService getInstance() {
        var application = ApplicationManager.getApplication();
        return application == null ? null : application.getService(SessionSupplierStateService.class);
    }

    public synchronized void saveSupplier(String provider, String sessionId, String supplierId) {
        if (sessionId != null && !sessionId.isBlank() && supplierId != null && !supplierId.isBlank()) {
            bindings.put(provider + ":" + sessionId, supplierId);
        }
    }

    public synchronized String getSupplier(String provider, String sessionId) {
        return bindings.get(provider + ":" + sessionId);
    }

    /** Remove only the binding whose history has been confirmed deleted. */
    public synchronized void removeSupplier(String provider, String sessionId) {
        bindings.remove(provider + ":" + sessionId);
    }

    @Override
    public synchronized @NotNull Bindings getState() {
        Bindings state = new Bindings();
        state.suppliers.putAll(bindings);
        return state;
    }

    @Override
    public synchronized void loadState(@NotNull Bindings state) {
        bindings.clear();
        if (state.suppliers != null) {
            bindings.putAll(state.suppliers);
        }
    }

    public static class Bindings {
        public Map<String, String> suppliers = new HashMap<>();
    }
}
