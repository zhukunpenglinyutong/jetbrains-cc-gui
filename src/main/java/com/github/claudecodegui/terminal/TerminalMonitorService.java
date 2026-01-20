package com.github.claudecodegui.terminal;

import com.intellij.execution.process.ProcessAdapter;
import com.intellij.execution.process.ProcessEvent;
import com.intellij.execution.process.ProcessHandler;
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
import com.intellij.ui.content.ContentManagerAdapter;
import com.intellij.ui.content.ContentManagerEvent;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;
import org.jetbrains.plugins.terminal.TerminalView;


import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Service to monitor terminal output and user input (echoed).
 * This service attaches listeners to all active and new terminal widgets.
 */
public class TerminalMonitorService implements ProjectActivity {

    private static final Logger LOG = Logger.getInstance(TerminalMonitorService.class);
    private static final Set<Object> monitoredWidgets = Collections.synchronizedSet(new HashSet<>());
    private static final Map<Object, StringBuilder> buffers = new ConcurrentHashMap<>();
    private static final int MAX_BUFFER_SIZE = 100000; // Keep last 100k chars
    private boolean contentHandlerAttached = false;

    @Nullable
    @Override
    public Object execute(@NotNull Project project, @NotNull Continuation<? super Unit> continuation) {
        monitorTerminals(project);
        return Unit.INSTANCE;
    }

    private void monitorTerminals(@NotNull Project project) {
        // Listen for Terminal ToolWindow changes to attach to the window when it appears
        project.getMessageBus().connect().subscribe(ToolWindowManagerListener.TOPIC, new ToolWindowManagerListener() {
            @Override
            public void stateChanged(@NotNull ToolWindowManager toolWindowManager) {
                // Check if Terminal window is available (e.g. after being hidden/shown or registered)
                setupTerminalListener(project);
            }
        });

        // Initial check
        setupTerminalListener(project);
    }

    private void setupTerminalListener(@NotNull Project project) {
        ToolWindow terminalWindow = ToolWindowManager.getInstance(project).getToolWindow("Terminal");
        if (terminalWindow == null) return;

        // Attach listener to ContentManager to detect new tabs (Terminals)
        if (!contentHandlerAttached) {
            terminalWindow.getContentManager().addContentManagerListener(new ContentManagerAdapter() {
                @Override
                public void contentAdded(@NotNull ContentManagerEvent event) {
                    // When a new tab is added, check for new widgets
                    checkForNewWidgets(project);
                }
            });
            contentHandlerAttached = true;
            LOG.info("Terminal content listener attached for project: " + project.getName());
        }

        // Always check for existing widgets (in case we missed some or just started)
        checkForNewWidgets(project);
    }

    private void checkForNewWidgets(@NotNull Project project) {
        try {
            Class<?> viewClass = Class.forName("org.jetbrains.plugins.terminal.TerminalView");
            Object view = viewClass.getMethod("getInstance", Project.class).invoke(null, project);
            if (view == null) return;
            
            Object result = viewClass.getMethod("getWidgets").invoke(view);
            List<Object> widgets = convertResultToList(result);
            for (Object widget : widgets) {
                if (!monitoredWidgets.contains(widget)) {
                    attachToWidget(widget);
                }
            }
        } catch (ClassNotFoundException e) {
            // Gracefully handle if Terminal plugin is not enabled/loaded
            LOG.warn("Terminal plugin classes not found. Monitoring disabled.");
        } catch (Exception e) {
            LOG.error("Error checking for terminal widgets", e);
        }
    }

    private void attachToWidget(@NotNull Object widget) {
        if (monitoredWidgets.contains(widget)) return;

        monitoredWidgets.add(widget);
        String title = "Unknown";
        try {
            Object terminalTitle = widget.getClass().getMethod("getTerminalTitle").invoke(widget);
            if (terminalTitle != null) {
                title = (String) terminalTitle.getClass().getMethod("getText").invoke(terminalTitle);
            }
        } catch (Exception e) {
            // ignore
        }
        LOG.info("Monitoring terminal widget: " + title + " (Class: " + widget.getClass().getName() + ")");

        // Handle disposal
        if (widget instanceof com.intellij.openapi.Disposable) {
            Disposer.register((com.intellij.openapi.Disposable) widget, () -> {
                LOG.info("Terminal widget disposed: " + TerminalMonitorService.getWidgetTitle(widget));
                monitoredWidgets.remove(widget);
                buffers.remove(widget);
            });
        }

        // Attach ProcessListener to capture output
        try {
            java.lang.reflect.Method getHandlerMethod = null;
            String[] possibleHandlerMethods = {"getTerminalProcessHandler", "getProcessHandler"};
            
            for (String methodName : possibleHandlerMethods) {
                try {
                    getHandlerMethod = widget.getClass().getMethod(methodName);
                    if (getHandlerMethod != null) break;
                } catch (NoSuchMethodException e) {
                    // continue
                }
            }

            if (getHandlerMethod != null) {
                ProcessHandler processHandler = (ProcessHandler) getHandlerMethod.invoke(widget);
                if (processHandler != null) {
                    LOG.info("Attached ProcessListener to terminal: " + title + " using " + getHandlerMethod.getName());
                    processHandler.addProcessListener(new ProcessAdapter() {
                        @Override
                        public void onTextAvailable(@NotNull ProcessEvent event, @NotNull Key outputType) {
                            String text = event.getText();
                            if (text != null && !text.isEmpty()) {
                                StringBuilder sb = buffers.computeIfAbsent(widget, k -> new StringBuilder());
                                synchronized (sb) {
                                    sb.append(text);
                                    if (sb.length() > MAX_BUFFER_SIZE) {
                                        sb.delete(0, sb.length() - MAX_BUFFER_SIZE);
                                    }
                                }
                            }
                        }
                    });
                } else {
                    LOG.warn("ProcessHandler is null for terminal: " + title);
                }
            } else {
                LOG.warn("Could not find getTerminalProcessHandler method in " + widget.getClass().getName());
            }
        } catch (Exception e) {
            LOG.warn("Failed to attach process listener to widget: " + e.getMessage(), e);
        }
    }

    /**
     * Get all active terminal widgets for a project.
     * Returns List<Object> to avoid dependency issues.
     */
    public static List<Object> getWidgets(@NotNull Project project) {
        try {
            Class<?> viewClass = Class.forName("org.jetbrains.plugins.terminal.TerminalView");
            Object view = viewClass.getMethod("getInstance", Project.class).invoke(null, project);
            if (view == null) return List.of();

            Object result = viewClass.getMethod("getWidgets").invoke(view);
            List<Object> widgets = convertResultToList(result);
            
            // Sort widgets based on their visual tab order in the tool window
            java.util.List<Object> sortedWidgets = new java.util.ArrayList<>(widgets);
            try {
                com.intellij.openapi.wm.ToolWindow window = com.intellij.openapi.wm.ToolWindowManager.getInstance(project).getToolWindow("Terminal");
                if (window != null) {
                    com.intellij.ui.content.ContentManager cm = window.getContentManager();
                    sortedWidgets.sort((w1, w2) -> {
                        int i1 = findWidgetIndex(cm, w1);
                        int i2 = findWidgetIndex(cm, w2);
                        return Integer.compare(i1, i2);
                    });
                }
            } catch (Exception e) {
                // Fallback to identity hash if UI-based sorting fails
                sortedWidgets.sort(java.util.Comparator.comparingInt(System::identityHashCode));
            }
            return sortedWidgets;
        } catch (Exception e) {
            LOG.warn("Failed to get terminal widgets", e);
            return List.of();
        }
    }

    private static int findWidgetIndex(ContentManager cm, Object widget) {
        for (int i = 0; i < cm.getContentCount(); i++) {
            Content content = cm.getContent(i);
            if (content != null) {
                // Check if the component itself or its children match the widget
                if (widget.equals(content.getComponent()) || widget.equals(content.getPreferredFocusableComponent())) {
                    return i;
                }
                
                // Terminal specific lookup via reflection to avoid direct dependency on internal classes
                try {
                    Object contentWidget = content.getUserData(Key.findKeyByName("terminalWidget"));
                    if (widget.equals(contentWidget)) {
                        return i;
                    }
                } catch (Exception e) {
                    // ignore
                }
            }
        }
        return Integer.MAX_VALUE; // Put at the end if not found
    }

    /**
     * Get the captured content of a terminal widget.
     */
    public static String getWidgetContent(@NotNull Object widget) {
        StringBuilder sb = buffers.get(widget);
        String captured = "";
        if (sb != null) {
            synchronized (sb) {
                captured = sb.toString();
            }
        }
        
        LOG.info("[Terminal] getWidgetContent dynamic capture length: " + captured.length());

        // We supplement with a screen scrape if captured is small or always to ensure we get history
        try {
            LOG.info("[Terminal] Starting exhaustive screen scrape for widget class: " + widget.getClass().getName());
            Object terminal = null;
            
            // Step 1: Get Terminal Model
            try {
                terminal = widget.getClass().getMethod("getTerminal").invoke(widget);
                LOG.info("[Terminal] [Step 1] Found terminal object directly via getTerminal()");
            } catch (Exception e1) {
                LOG.info("[Terminal] [Step 1] getTerminal() direct failed: " + e1.getMessage() + ". Trying getTerminalPanel()...");
                try {
                    java.lang.reflect.Method getPanelMethod = widget.getClass().getMethod("getTerminalPanel");
                    Object panel = getPanelMethod.invoke(widget);
                    if (panel != null) {
                        LOG.info("[Terminal] [Step 1] Found panel: " + panel.getClass().getName());
                        terminal = panel.getClass().getMethod("getTerminal").invoke(panel);
                        if (terminal != null) {
                            LOG.info("[Terminal] [Step 1] Found terminal object via panel.getTerminal()");
                        } else {
                            LOG.warn("[Terminal] [Step 1] panel.getTerminal() returned null");
                        }
                    } else {
                        LOG.warn("[Terminal] [Step 1] getTerminalPanel() returned null");
                    }
                } catch (Exception e2) {
                    LOG.error("[Terminal] [Step 1] Exhausted all ways to find Terminal object: " + e2.getMessage());
                }
            }

            if (terminal != null) {
                // Step 2: Get Text Buffer
                Object buffer = null;
                String[] bufferMethods = {"getTextBuffer", "getTerminalTextBuffer"};
                for (String m : bufferMethods) {
                    try {
                        buffer = terminal.getClass().getMethod(m).invoke(terminal);
                        if (buffer != null) {
                            LOG.info("[Terminal] [Step 2] Found buffer via " + m + "(): " + buffer.getClass().getName());
                            break;
                        }
                    } catch (Exception e) {
                        LOG.info("[Terminal] [Step 2] Method " + m + "() failed on " + terminal.getClass().getName());
                    }
                }

                if (buffer != null) {
                    // Step 3: Scrape lines
                    StringBuilder scraped = new StringBuilder();
                    try {
                        // Dynamically find the method for line count (could be getLineCount, getLinesCount, getHeight, etc.)
                        java.lang.reflect.Method getLineCountMethod = null;
                        String[] countMethodNames = {"getLineCount", "getLinesCount", "getHeight", "getBufferHeight"};
                        for (String name : countMethodNames) {
                            try {
                                getLineCountMethod = buffer.getClass().getMethod(name);
                                break;
                            } catch (Exception e) {}
                        }

                        if (getLineCountMethod == null) {
                            // Last resort: search all methods
                            for (java.lang.reflect.Method m : buffer.getClass().getMethods()) {
                                if ((m.getName().toLowerCase().contains("linecount") || m.getName().toLowerCase().contains("height")) 
                                    && m.getParameterCount() == 0 && m.getReturnType() == int.class) {
                                    getLineCountMethod = m;
                                    break;
                                }
                            }
                        }

                        if (getLineCountMethod == null) {
                            throw new NoSuchMethodException("Could not find line count method on " + buffer.getClass().getName());
                        }

                        int totalLines = (int) getLineCountMethod.invoke(buffer);
                        
                        // Dynamically find the method to get a line
                        java.lang.reflect.Method getLineMethod = null;
                        try {
                            getLineMethod = buffer.getClass().getMethod("getLine", int.class);
                        } catch (Exception e) {
                            for (java.lang.reflect.Method m : buffer.getClass().getMethods()) {
                                if (m.getName().toLowerCase().contains("getline") && m.getParameterCount() == 1 
                                    && m.getParameterTypes()[0] == int.class) {
                                    getLineMethod = m;
                                    break;
                                }
                            }
                        }

                        if (getLineMethod == null) {
                            throw new NoSuchMethodException("Could not find getLine method on " + buffer.getClass().getName());
                        }
                        
                        LOG.info("[Terminal] [Step 3] Using methods: " + getLineCountMethod.getName() + ", " + getLineMethod.getName());
                        LOG.info("[Terminal] [Step 3] Buffer has " + totalLines + " total lines. Scraping last 500...");
                        
                        int start = Math.max(0, totalLines - 500);
                        int successCount = 0;
                        int emptyCount = 0;
                        int failCount = 0;

                        for (int i = start; i < totalLines; i++) {
                            try {
                                Object line = getLineMethod.invoke(buffer, i);
                                if (line != null) {
                                    String lineText = null;
                                    // Try common method names for line text
                                    String[] textMethods = {"getText", "getLineText", "getLine", "getString"};
                                    for (String tm : textMethods) {
                                        try {
                                            java.lang.reflect.Method m = line.getClass().getMethod(tm);
                                            lineText = (String) m.invoke(line);
                                            if (lineText != null) break;
                                        } catch (Exception e) {}
                                    }
                                    
                                    if (lineText == null) {
                                        // Try to find any method that returns String and has no params
                                        for (java.lang.reflect.Method m : line.getClass().getMethods()) {
                                            if (m.getReturnType() == String.class && m.getParameterCount() == 0 
                                                && !m.getName().equals("toString") && !m.getName().equals("getClass")) {
                                                lineText = (String) m.invoke(line);
                                                if (lineText != null && !lineText.isEmpty()) break;
                                            }
                                        }
                                    }
                                    
                                    if (lineText != null && !lineText.trim().isEmpty()) {
                                        scraped.append(lineText).append("\n");
                                        successCount++;
                                    } else {
                                        emptyCount++;
                                    }
                                } else {
                                    failCount++;
                                }
                            } catch (Exception lineEx) {
                                failCount++;
                            }
                        }
                        LOG.info("[Terminal] [Step 3] Scrape stats: Total=" + (totalLines - start) + ", Non-Empty=" + successCount + ", Empty=" + emptyCount + ", Failed=" + failCount);
                        
                        String result = scraped.toString().trim();
                        if (!result.isEmpty()) {
                            LOG.info("[Terminal] Final scraped content length: " + result.length());
                            // Merge with dynamic capture if needed, or just return scraped as it's more complete
                            return result;
                        } else {
                            LOG.warn("[Terminal] [Step 3] Scraped content is empty despite " + totalLines + " lines in buffer");
                        }
                    } catch (Exception e) {
                        LOG.error("[Terminal] [Step 3] Failed to iterate buffer lines: " + e.getMessage(), e);
                    }
                } else {
                    LOG.warn("[Terminal] [Step 2] Failed to find a valid TextBuffer object");
                }
            }
        } catch (Exception e) {
            LOG.error("[Terminal] Global crash during terminal scrape: " + e.getMessage(), e);
        }
        
        LOG.info("[Terminal] Falling back to dynamic capture (length: " + captured.length() + ")");
        return captured;
    }

    /**
     * Get the title of a terminal widget.
     */
    public static String getWidgetTitle(@NotNull Object widget) {
        try {
            Object terminalTitle = widget.getClass().getMethod("getTerminalTitle").invoke(widget);
            if (terminalTitle != null) {
                return (String) terminalTitle.getClass().getMethod("getText").invoke(terminalTitle);
            }
        } catch (Exception e) {
            // ignore
        }
        return "Terminal";
    }

    private static List<Object> convertResultToList(Object result) {
        if (result == null) return java.util.Collections.emptyList();
        if (result instanceof Object[]) {
            return java.util.Arrays.asList((Object[]) result);
        }
        if (result instanceof java.util.Collection) {
            return new java.util.ArrayList<>((java.util.Collection<?>) result);
        }
        if (result instanceof Iterable) {
            java.util.List<Object> list = new java.util.ArrayList<>();
            for (Object item : (Iterable<?>) result) {
                list.add(item);
            }
            return list;
        }
        return java.util.Collections.emptyList();
    }
}
