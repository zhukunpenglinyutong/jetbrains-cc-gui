package com.github.claudecodegui.service;

import com.intellij.execution.ExecutionManager;
import com.intellij.execution.RunnerAndConfigurationSettings;
import com.intellij.execution.process.ProcessAdapter;
import com.intellij.execution.process.ProcessEvent;
import com.intellij.execution.process.ProcessHandler;
import com.intellij.execution.ui.ConsoleView;
import com.intellij.execution.ui.ConsoleViewContentType;
import com.intellij.execution.ui.RunContentDescriptor;
import com.intellij.execution.ui.RunContentManager;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.ProjectActivity;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.util.Key;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.openapi.wm.ex.ToolWindowManagerListener;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentManager;
import com.intellij.ui.content.ContentManagerEvent;
import com.intellij.ui.content.ContentManagerListener;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.lang.reflect.Method;
import java.util.*;

/**
 * Service to monitor Run/Debug service output.
 * This service attaches listeners to all active and new Run configurations.
 *
 * Unlike TerminalMonitorService which monitors terminal widgets,
 * this service monitors Run/Debug configurations (e.g., Spring Boot services,
 * application runs, Gradle/Maven tasks, etc.)
 */
public class RunConfigMonitorService implements ProjectActivity {

    private static final Logger LOG = Logger.getInstance(RunConfigMonitorService.class);

    /**
     * Buffer storage for run configuration output using WeakHashMap.
     * Buffers are automatically cleaned up when the associated descriptor is garbage collected.
     */
    private static final Map<RunContentDescriptor, StringBuilder> buffers =
            Collections.synchronizedMap(new WeakHashMap<>());

    /**
     * Set of monitored process handlers using WeakHashMap to prevent memory leaks.
     * When a handler is garbage collected, it will be automatically removed from this set.
     */
    private static final Set<ProcessHandler> monitoredHandlers =
            Collections.newSetFromMap(new WeakHashMap<>());

    private static final int MAX_BUFFER_SIZE = 100000; // Keep last 100k chars

    private final Set<ContentManager> attachedManagers = Collections.synchronizedSet(new HashSet<>());
    private Project currentProject;

    @Nullable
    @Override
    public Object execute(@NotNull Project project, @NotNull Continuation<? super Unit> continuation) {
        this.currentProject = project;
        ApplicationManager.getApplication().invokeLater(() -> monitorRunConfigurations(project));
        return Unit.INSTANCE;
    }

    private void monitorRunConfigurations(@NotNull Project project) {
        // Listen for Run ToolWindow changes
        project.getMessageBus().connect().subscribe(ToolWindowManagerListener.TOPIC, new ToolWindowManagerListener() {
            @Override
            public void stateChanged(@NotNull ToolWindowManager toolWindowManager) {
                setupRunListener(project);
            }
        });

        // Initial check
        setupRunListener(project);
    }

    private void setupRunListener(@NotNull Project project) {
        // Monitor the "Run" tool window
        ToolWindow runWindow = ToolWindowManager.getInstance(project).getToolWindow("Run");
        if (runWindow != null) {
            attachContentListener(runWindow, "Run");
        }

        // Also monitor the "Debug" tool window
        ToolWindow debugWindow = ToolWindowManager.getInstance(project).getToolWindow("Debug");
        if (debugWindow != null) {
            attachContentListener(debugWindow, "Debug");
        }

        // Monitor "Services" tool window (for Spring Boot, etc.)
        ToolWindow servicesWindow = ToolWindowManager.getInstance(project).getToolWindow("Services");
        if (servicesWindow != null) {
            attachContentListener(servicesWindow, "Services");
        }

        // Attach to existing run descriptors
        attachToExistingDescriptors(project);
    }

    private void attachContentListener(ToolWindow toolWindow, String windowName) {
        if (toolWindow == null) return;

        ContentManager contentManager = toolWindow.getContentManager();
        if (contentManager == null) return;

        // Check if already attached
        if (attachedManagers.contains(contentManager)) {
            return;
        }
        attachedManagers.add(contentManager);

        contentManager.addContentManagerListener(new ContentManagerListener() {
            @Override
            public void contentAdded(@NotNull ContentManagerEvent event) {
                LOG.debug("Content added to " + windowName + ": " + event.getContent().getDisplayName());
                // Small delay to allow the content to be fully initialized
                com.intellij.util.Alarm alarm = new com.intellij.util.Alarm();
                alarm.addRequest(() -> {
                    if (currentProject != null) {
                        attachToExistingDescriptors(currentProject);
                    }
                }, 500);
            }

            @Override
            public void contentRemoved(@NotNull ContentManagerEvent event) {
                LOG.debug("Content removed from " + windowName + ": " + event.getContent().getDisplayName());
            }
        });

        LOG.debug("ContentManager listener attached for: " + windowName);
        
        // Check existing content
        for (Content content : contentManager.getContents()) {
            LOG.debug("Existing content in " + windowName + ": " + content.getDisplayName());
        }
    }

    private void attachToExistingDescriptors(@NotNull Project project) {
        try {
            RunContentManager runContentManager = RunContentManager.getInstance(project);
            if (runContentManager == null) {
                LOG.debug("RunContentManager is null");
                return;
            }

            List<RunContentDescriptor> descriptors = runContentManager.getAllDescriptors();
            LOG.debug("Found " + descriptors.size() + " run descriptors");
            
            for (RunContentDescriptor descriptor : descriptors) {
                attachToDescriptor(descriptor);
            }
        } catch (Exception e) {
            LOG.error("Error attaching to existing descriptors", e);
        }
    }

    private void attachToDescriptor(@NotNull RunContentDescriptor descriptor) {
        ProcessHandler processHandler = descriptor.getProcessHandler();
        if (processHandler == null) {
            LOG.debug("ProcessHandler is null for: " + descriptor.getDisplayName());
            return;
        }

        if (monitoredHandlers.contains(processHandler)) {
            return;
        }

        monitoredHandlers.add(processHandler);
        String displayName = descriptor.getDisplayName();
        LOG.debug("Monitoring run configuration: " + displayName);

        // Initialize buffer for this descriptor
        buffers.computeIfAbsent(descriptor, k -> new StringBuilder());

        // Attach process listener to capture output
        processHandler.addProcessListener(new ProcessAdapter() {
            @Override
            public void onTextAvailable(@NotNull ProcessEvent event, @NotNull Key outputType) {
                String text = event.getText();
                if (text != null && !text.isEmpty()) {
                    StringBuilder sb = buffers.computeIfAbsent(descriptor, k -> new StringBuilder());
                    synchronized (sb) {
                        sb.append(text);
                        if (sb.length() > MAX_BUFFER_SIZE) {
                            sb.delete(0, sb.length() - MAX_BUFFER_SIZE);
                        }
                    }
                }
            }

            @Override
            public void processTerminated(@NotNull ProcessEvent event) {
                LOG.debug("Process terminated: " + displayName + " with exit code: " + event.getExitCode());
            }
        });

        // Handle disposal
        if (descriptor.getProcessHandler() != null) {
            processHandler.addProcessListener(new ProcessAdapter() {
                @Override
                public void processTerminated(@NotNull ProcessEvent event) {
                    // Clean up after a delay to allow final output to be captured
                    com.intellij.util.Alarm alarm = new com.intellij.util.Alarm();
                    alarm.addRequest(() -> {
                        monitoredHandlers.remove(processHandler);
                        // Keep buffer for a while in case user wants to read it
                    }, 5000);
                }
            });
        }
    }

    // ==================== PUBLIC API ====================

    /**
     * Get all active run configuration descriptors for a project.
     */
    public static List<RunConfigInfo> getRunConfigurations(@NotNull Project project) {
        List<RunConfigInfo> configs = new ArrayList<>();
        try {
            RunContentManager runContentManager = RunContentManager.getInstance(project);
            if (runContentManager == null) return configs;

            List<RunContentDescriptor> descriptors = runContentManager.getAllDescriptors();
            for (RunContentDescriptor descriptor : descriptors) {
                ProcessHandler handler = descriptor.getProcessHandler();
                boolean isRunning = handler != null && !handler.isProcessTerminated();
                
                configs.add(new RunConfigInfo(
                    descriptor,
                    descriptor.getDisplayName(),
                    isRunning,
                    handler != null ? System.identityHashCode(handler) : -1
                ));
            }
        } catch (Exception e) {
            LOG.error("Error getting run configurations", e);
        }
        return configs;
    }

    /**
     * Get the captured output content of a run configuration.
     */
    public static String getRunConfigContent(@NotNull RunContentDescriptor descriptor) {
        StringBuilder sb = buffers.get(descriptor);
        String captured = "";
        if (sb != null) {
            synchronized (sb) {
                captured = sb.toString();
            }
        }
        
        LOG.debug("getRunConfigContent for " + descriptor.getDisplayName() + ", captured length: " + captured.length());

        // Try to get content from ConsoleView if captured is empty
        if (captured.isEmpty()) {
            captured = getConsoleContent(descriptor);
        }

        return captured;
    }

    /**
     * Get content directly from ConsoleView (fallback method).
     */
    private static String getConsoleContent(@NotNull RunContentDescriptor descriptor) {
        try {
            Object console = descriptor.getExecutionConsole();
            if (console == null) {
                LOG.debug("ExecutionConsole is null for: " + descriptor.getDisplayName());
                return "";
            }

            // Try multiple approaches to get console text
            String[] methodNames = {"getText", "getComponent"};
            
            // Approach 1: If it's a ConsoleViewImpl, try getText directly
            try {
                Method getTextMethod = console.getClass().getMethod("getText");
                Object result = getTextMethod.invoke(console);
                if (result instanceof String) {
                    LOG.debug("Got console text via getText() method");
                    return (String) result;
                }
            } catch (NoSuchMethodException e) {
                // Not a ConsoleViewImpl, try other approaches
            }

            // Approach 2: Try to get the editor and read its document
            try {
                Method getEditorMethod = console.getClass().getMethod("getEditor");
                Object editor = getEditorMethod.invoke(console);
                if (editor != null) {
                    Method getDocumentMethod = editor.getClass().getMethod("getDocument");
                    Object document = getDocumentMethod.invoke(editor);
                    if (document != null) {
                        Method getTextMethod = document.getClass().getMethod("getText");
                        Object text = getTextMethod.invoke(document);
                        if (text instanceof String) {
                            LOG.debug("Got console text via editor.getDocument().getText()");
                            return (String) text;
                        }
                    }
                }
            } catch (Exception e) {
                LOG.debug("Could not get text from editor: " + e.getMessage());
            }

            LOG.debug("Could not extract text from console: " + console.getClass().getName());
        } catch (Exception e) {
            LOG.error("Error getting console content", e);
        }
        return "";
    }

    /**
     * Data class for run configuration info.
     */
    public static class RunConfigInfo {
        private final RunContentDescriptor descriptor;
        private final String displayName;
        private final boolean running;
        private final int processId;

        public RunConfigInfo(RunContentDescriptor descriptor, String displayName, boolean running, int processId) {
            this.descriptor = descriptor;
            this.displayName = displayName;
            this.running = running;
            this.processId = processId;
        }

        public RunContentDescriptor getDescriptor() {
            return descriptor;
        }

        public String getDisplayName() {
            return displayName;
        }

        public boolean isRunning() {
            return running;
        }

        public int getProcessId() {
            return processId;
        }

        /**
         * Get the captured output of this run configuration.
         */
        public String getContent() {
            return RunConfigMonitorService.getRunConfigContent(descriptor);
        }
    }
}
