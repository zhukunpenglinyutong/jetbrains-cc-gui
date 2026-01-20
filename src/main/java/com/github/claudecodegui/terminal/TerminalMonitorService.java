package com.github.claudecodegui.terminal;

import com.intellij.execution.process.ProcessAdapter;
import com.intellij.execution.process.ProcessEvent;
import com.intellij.execution.process.ProcessHandler;
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
import com.intellij.ui.content.ContentManagerAdapter;
import com.intellij.ui.content.ContentManagerEvent;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;
import org.jetbrains.plugins.terminal.TerminalView;


import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;

/**
 * Service to monitor terminal output and user input (echoed).
 * This service attaches listeners to all active and new terminal widgets.
 *
 * <h3>Implementation Notes - Reflection Usage</h3>
 * <p>This service uses Java Reflection to access JetBrains Terminal plugin internals because:</p>
 * <ul>
 *   <li>Terminal plugin does not provide public APIs for reading terminal content</li>
 *   <li>Direct class dependencies would break compatibility across IDE versions</li>
 *   <li>Reflection allows graceful degradation when APIs change between versions</li>
 * </ul>
 *
 * <h3>Accessed Internal Classes (via reflection)</h3>
 * <ul>
 *   <li>{@code org.jetbrains.plugins.terminal.TerminalView} - Terminal view manager</li>
 *   <li>{@code TerminalWidget} - Individual terminal tab widget</li>
 *   <li>{@code Terminal/TerminalTextBuffer} - Terminal content buffer for screen scraping</li>
 * </ul>
 */
public class TerminalMonitorService implements ProjectActivity {

    private static final Logger LOG = Logger.getInstance(TerminalMonitorService.class);

    /**
     * Tracked terminal widgets using WeakHashMap to prevent memory leaks.
     * When a widget is garbage collected, it will be automatically removed from this set.
     * Wrapped with synchronizedSet for thread-safe access.
     */
    private static final Set<Object> monitoredWidgets =
            Collections.synchronizedSet(Collections.newSetFromMap(new WeakHashMap<>()));

    /**
     * Buffer storage for terminal output using WeakHashMap.
     * Buffers are automatically cleaned up when the associated widget is garbage collected.
     */
    private static final Map<Object, StringBuilder> buffers = Collections.synchronizedMap(new WeakHashMap<>());

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
        // ContentManager access requires EDT, so schedule this on EDT
        ApplicationManager.getApplication().invokeLater(() -> {
            if (project.isDisposed()) return;

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
                LOG.debug("Terminal content listener attached for project: " + project.getName());
            }

            // Always check for existing widgets (in case we missed some or just started)
            checkForNewWidgets(project);
        });
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
        LOG.debug("Monitoring terminal widget: " + title + " (Class: " + widget.getClass().getName() + ")");

        // Handle disposal
        if (widget instanceof com.intellij.openapi.Disposable) {
            Disposer.register((com.intellij.openapi.Disposable) widget, () -> {
                LOG.debug("Terminal widget disposed: " + TerminalMonitorService.getWidgetTitle(widget));
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
                    LOG.debug("Attached ProcessListener to terminal: " + title + " using " + getHandlerMethod.getName());
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
     * First tries dynamic capture from process listener, then supplements with screen scraping.
     */
    public static String getWidgetContent(@NotNull Object widget) {
        String captured = getCapturedContent(widget);
        LOG.debug("[Terminal] Dynamic capture length: " + captured.length());

        // Supplement with screen scrape to ensure we get history
        String scraped = scrapeTerminalScreen(widget);
        if (!scraped.isEmpty()) {
            return scraped;
        }

        LOG.debug("[Terminal] Falling back to dynamic capture (length: " + captured.length() + ")");
        return captured;
    }

    /**
     * Get cached content from process listener buffer.
     */
    private static String getCapturedContent(@NotNull Object widget) {
        StringBuilder sb = buffers.get(widget);
        if (sb == null) return "";
        synchronized (sb) {
            return sb.toString();
        }
    }

    /**
     * Scrape terminal screen content via reflection.
     * This method navigates: Widget -> Terminal -> TextBuffer -> Lines
     */
    private static String scrapeTerminalScreen(@NotNull Object widget) {
        try {
            LOG.debug("[Terminal] Starting screen scrape for widget: " + widget.getClass().getName());

            // Step 1: Get Terminal object
            Object terminal = getTerminalObject(widget);
            if (terminal == null) return "";

            // Step 2: Get TextBuffer
            Object buffer = getTextBuffer(terminal);
            if (buffer == null) return "";

            // Step 3: Scrape lines
            return scrapeBufferLines(buffer, 500);
        } catch (Exception e) {
            LOG.debug("[Terminal] Screen scrape failed: " + e.getMessage());
            return "";
        }
    }

    /**
     * Get Terminal object from widget via reflection.
     * Tries direct getTerminal() first, then falls back to getTerminalPanel().getTerminal()
     */
    private static Object getTerminalObject(@NotNull Object widget) {
        // Try direct method first
        try {
            Object terminal = widget.getClass().getMethod("getTerminal").invoke(widget);
            if (terminal != null) {
                LOG.debug("[Terminal] Found terminal via getTerminal()");
                return terminal;
            }
        } catch (Exception e) {
            LOG.debug("[Terminal] getTerminal() failed: " + e.getMessage());
        }

        // Try via panel
        try {
            java.lang.reflect.Method getPanelMethod = widget.getClass().getMethod("getTerminalPanel");
            Object panel = getPanelMethod.invoke(widget);
            if (panel != null) {
                Object terminal = panel.getClass().getMethod("getTerminal").invoke(panel);
                if (terminal != null) {
                    LOG.debug("[Terminal] Found terminal via panel.getTerminal()");
                    return terminal;
                }
            }
        } catch (Exception e) {
            LOG.debug("[Terminal] getTerminalPanel().getTerminal() failed: " + e.getMessage());
        }

        LOG.debug("[Terminal] Could not find Terminal object");
        return null;
    }

    /**
     * Get TextBuffer from Terminal object via reflection.
     */
    private static Object getTextBuffer(@NotNull Object terminal) {
        String[] bufferMethods = {"getTextBuffer", "getTerminalTextBuffer"};
        for (String methodName : bufferMethods) {
            try {
                Object buffer = terminal.getClass().getMethod(methodName).invoke(terminal);
                if (buffer != null) {
                    LOG.debug("[Terminal] Found buffer via " + methodName + "()");
                    return buffer;
                }
            } catch (Exception e) {
                LOG.debug("[Terminal] " + methodName + "() failed");
            }
        }
        LOG.debug("[Terminal] Could not find TextBuffer object");
        return null;
    }

    /**
     * Scrape lines from TextBuffer.
     * @param buffer The TextBuffer object
     * @param maxLines Maximum number of lines to scrape from the end
     * @return Scraped content as string
     */
    private static String scrapeBufferLines(@NotNull Object buffer, int maxLines) {
        try {
            // Find line count method
            java.lang.reflect.Method getLineCountMethod = findLineCountMethod(buffer);
            if (getLineCountMethod == null) {
                LOG.debug("[Terminal] Could not find line count method");
                return "";
            }

            // Find getLine method
            java.lang.reflect.Method getLineMethod = findGetLineMethod(buffer);
            if (getLineMethod == null) {
                LOG.debug("[Terminal] Could not find getLine method");
                return "";
            }

            int totalLines = (int) getLineCountMethod.invoke(buffer);
            int start = Math.max(0, totalLines - maxLines);
            LOG.debug("[Terminal] Scraping lines " + start + " to " + totalLines);

            StringBuilder scraped = new StringBuilder();
            int successCount = 0;

            for (int i = start; i < totalLines; i++) {
                String lineText = extractLineText(buffer, getLineMethod, i);
                if (lineText != null && !lineText.trim().isEmpty()) {
                    scraped.append(lineText).append("\n");
                    successCount++;
                }
            }

            LOG.debug("[Terminal] Scraped " + successCount + " non-empty lines");
            return scraped.toString().trim();
        } catch (Exception e) {
            LOG.debug("[Terminal] Failed to scrape buffer lines: " + e.getMessage());
            return "";
        }
    }

    /**
     * Find method to get line count from buffer.
     */
    private static java.lang.reflect.Method findLineCountMethod(@NotNull Object buffer) {
        String[] methodNames = {"getLineCount", "getLinesCount", "getHeight", "getBufferHeight"};
        for (String name : methodNames) {
            try {
                return buffer.getClass().getMethod(name);
            } catch (NoSuchMethodException e) {
                // continue
            }
        }

        // Fallback: search all methods
        for (java.lang.reflect.Method m : buffer.getClass().getMethods()) {
            String name = m.getName().toLowerCase();
            if ((name.contains("linecount") || name.contains("height"))
                    && m.getParameterCount() == 0 && m.getReturnType() == int.class) {
                return m;
            }
        }
        return null;
    }

    /**
     * Find method to get a line from buffer.
     */
    private static java.lang.reflect.Method findGetLineMethod(@NotNull Object buffer) {
        try {
            return buffer.getClass().getMethod("getLine", int.class);
        } catch (NoSuchMethodException e) {
            // Fallback: search methods
            for (java.lang.reflect.Method m : buffer.getClass().getMethods()) {
                if (m.getName().toLowerCase().contains("getline")
                        && m.getParameterCount() == 1
                        && m.getParameterTypes()[0] == int.class) {
                    return m;
                }
            }
        }
        return null;
    }

    /**
     * Extract text from a single line object.
     */
    private static String extractLineText(@NotNull Object buffer, @NotNull java.lang.reflect.Method getLineMethod, int lineIndex) {
        try {
            Object line = getLineMethod.invoke(buffer, lineIndex);
            if (line == null) return null;

            // Try common method names
            String[] textMethods = {"getText", "getLineText", "getLine", "getString"};
            for (String methodName : textMethods) {
                try {
                    java.lang.reflect.Method m = line.getClass().getMethod(methodName);
                    String text = (String) m.invoke(line);
                    if (text != null) return text;
                } catch (Exception e) {
                    // continue
                }
            }

            // Fallback: find any String-returning method
            for (java.lang.reflect.Method m : line.getClass().getMethods()) {
                if (m.getReturnType() == String.class
                        && m.getParameterCount() == 0
                        && !m.getName().equals("toString")
                        && !m.getName().equals("getClass")) {
                    String text = (String) m.invoke(line);
                    if (text != null && !text.isEmpty()) return text;
                }
            }
        } catch (Exception e) {
            // ignore individual line failures
        }
        return null;
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
