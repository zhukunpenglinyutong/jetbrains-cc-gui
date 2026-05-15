package com.github.claudecodegui.settings;

import com.github.claudecodegui.model.SessionTemplate;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.PersistentStateComponent;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.components.State;
import com.intellij.openapi.components.Storage;
import com.intellij.openapi.diagnostic.Logger;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Service for managing session templates persistence.
 * Stores templates as JSON in the IDE's persistent state.
 */
@State(
    name = "SessionTemplates",
    storages = @Storage("sessionTemplates.xml")
)
@Service(Service.Level.APP)
public final class SessionTemplateService implements PersistentStateComponent<SessionTemplateService.State> {

    private static final Logger LOG = Logger.getInstance(SessionTemplateService.class);
    private State myState = new State();

    /**
     * Get the singleton instance of the service.
     */
    public static SessionTemplateService getInstance() {
        return ApplicationManager.getApplication().getService(SessionTemplateService.class);
    }

    /**
     * Save a session template.
     */
    public void saveTemplate(SessionTemplate template) {
        if (template == null || template.getName() == null || template.getName().trim().isEmpty()) {
            LOG.warn("Cannot save template with null or empty name");
            return;
        }

        myState.templates.put(template.getName().trim(), template.copy());
        LOG.info("Saved session template: " + template.getName());
    }

    /**
     * Get a template by name.
     */
    public SessionTemplate getTemplate(String name) {
        if (name == null) {
            return null;
        }
        SessionTemplate template = myState.templates.get(name.trim());
        return template != null ? template.copy() : null;
    }

    /**
     * Get all saved templates.
     */
    public List<SessionTemplate> getAllTemplates() {
        return myState.templates.values()
                .stream()
                .map(SessionTemplate::copy)
                .collect(Collectors.toList());
    }

    /**
     * Delete a template by name.
     */
    public void deleteTemplate(String name) {
        if (name != null) {
            myState.templates.remove(name.trim());
            LOG.info("Deleted session template: " + name);
        }
    }

    /**
     * Check if a template with the given name exists.
     */
    public boolean templateExists(String name) {
        return name != null && myState.templates.containsKey(name.trim());
    }

    @Override
    public State getState() {
        return myState;
    }

    @Override
    public void loadState(State state) {
        myState = state != null ? state : new State();
    }

    /**
     * Persistent state class.
     */
    public static class State {
        /**
         * Map from template name to template data.
         */
        public Map<String, SessionTemplate> templates = new HashMap<>();
    }
}
