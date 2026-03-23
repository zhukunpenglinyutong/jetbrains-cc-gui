package com.github.claudecodegui.handler.file;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.service.RunConfigMonitorService;
import com.github.claudecodegui.terminal.TerminalMonitorService;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Collects runtime context: active terminals and services (Run/Debug configurations).
 */
class RuntimeContextCollector {

    private static final Logger LOG = Logger.getInstance(RuntimeContextCollector.class);

    private final HandlerContext context;

    RuntimeContextCollector(HandlerContext context) {
        this.context = context;
    }

    /**
     * Collect active terminals.
     */
    void collectTerminals(List<JsonObject> files, FileHandler.FileListRequest request) {
        ApplicationManager.getApplication().runReadAction(() -> {
            Project project = context.getProject();
            if (project == null || project.isDisposed()) return;

            try {
                List<Object> widgets = TerminalMonitorService.getWidgets(project);
                Map<String, Integer> nameCounts = new HashMap<>();

                for (Object widget : widgets) {
                    String baseTitle = TerminalMonitorService.getWidgetTitle(widget);
                    int count = nameCounts.getOrDefault(baseTitle, 0) + 1;
                    nameCounts.put(baseTitle, count);

                    String titleText = baseTitle;
                    if (count > 1) {
                        titleText = baseTitle + " (" + count + ")";
                    }

                    String title = "Terminal: " + titleText;
                    String safeName = titleText.replace(" ", "_").replaceAll("[^a-zA-Z0-9_]", "");
                    String path = "terminal://" + safeName;

                    if (request.matches(title, path)) {
                        JsonObject term = new JsonObject();
                        term.addProperty("name", title);
                        term.addProperty("path", path);
                        term.addProperty("absolutePath", path);
                        term.addProperty("type", "terminal");
                        term.addProperty("priority", 0); // High priority
                        files.add(term);
                    }
                }
            } catch (Throwable t) {
                LOG.warn("[FileHandler] Failed to collect terminals: " + t.getMessage());
            }
        });
    }

    /**
     * Collect active services (Run/Debug configurations).
     */
    void collectServices(List<JsonObject> files, FileHandler.FileListRequest request) {
        ApplicationManager.getApplication().runReadAction(() -> {
            Project project = context.getProject();
            if (project == null || project.isDisposed()) return;

            try {
                List<RunConfigMonitorService.RunConfigInfo> configs = RunConfigMonitorService.getRunConfigurations(project);
                for (RunConfigMonitorService.RunConfigInfo config : configs) {
                    String displayName = config.getDisplayName();
                    String title = "Service: " + displayName;

                    // Create safe name for the path (replace spaces with _, remove special chars)
                    String safeName = displayName.replace(" ", "_").replaceAll("[^a-zA-Z0-9_]", "");
                    String path = "service://" + safeName;

                    if (request.matches(title, path)) {
                        JsonObject serviceObj = new JsonObject();
                        serviceObj.addProperty("name", title);
                        serviceObj.addProperty("path", path);
                        serviceObj.addProperty("absolutePath", path); // Tag used in UI
                        serviceObj.addProperty("type", "service");
                        serviceObj.addProperty("priority", 0); // High priority
                        files.add(serviceObj);
                    }
                }
            } catch (Throwable t) {
                LOG.warn("[FileHandler] Failed to collect services: " + t.getMessage());
            }
        });
    }
}
