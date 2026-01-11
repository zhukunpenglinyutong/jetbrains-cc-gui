package com.github.claudecodegui.handler.context;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.codeInsight.daemon.impl.HighlightInfo;
import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerImpl;
import com.intellij.lang.annotation.HighlightSeverity;
import com.intellij.lang.injection.InjectedLanguageManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Pair;
import com.intellij.openapi.util.TextRange;
import com.intellij.psi.*;
import com.intellij.psi.util.PsiTreeUtil;
import org.jetbrains.annotations.NotNull;

import java.lang.reflect.Method;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Context collector with optional Java plugin support.
 * Works in all JetBrains IDEs (IDEA, PyCharm, WebStorm, etc.)
 */
public class ContextCollector {

    private static final Logger LOG = Logger.getInstance(ContextCollector.class);

    // Check if Java plugin is available (for PyCharm, WebStorm compatibility)
    private static final boolean JAVA_PLUGIN_AVAILABLE = isJavaPluginAvailable();
    private static Method collectJavaContextMethod;
    private static Method collectFocusedContextMethod;

    static {
        if (JAVA_PLUGIN_AVAILABLE) {
            try {
                Class<?> javaCollectorClass = Class.forName(
                    "com.github.claudecodegui.handler.context.JavaContextCollector");
                collectJavaContextMethod = javaCollectorClass.getMethod(
                    "collectJavaContext",
                    JsonObject.class, Editor.class, Project.class, PsiFile.class, Document.class);
                collectFocusedContextMethod = javaCollectorClass.getMethod(
                    "collectFocusedContext",
                    JsonObject.class, Editor.class, Project.class, PsiFile.class);
            } catch (Exception e) {
                LOG.warn("Failed to load JavaContextCollector: " + e.getMessage());
            }
        }
    }

    private static boolean isJavaPluginAvailable() {
        try {
            Class.forName("com.intellij.psi.PsiJavaFile");
            LOG.info("Java plugin detected - full context collection enabled");
            return true;
        } catch (ClassNotFoundException e) {
            LOG.info("Java plugin not available - running in platform-compatible mode (PyCharm/WebStorm)");
            return false;
        }
    }

    // Constants for context collection limits
    private static final int CODE_WINDOW_LINES_RANGE = 40;
    private static final int HIGHLIGHT_LINES_RANGE = 10;
    private static final int INJECTION_SEARCH_RANGE = 500;

    private static final Set<String> IGNORED_DIRS = new HashSet<>(List.of(
        "node_modules", "build", "out", "target", "vendor", ".gradle", ".idea", ".git", ".vh", "dist", "bin"
    ));

    public @NotNull JsonObject collectSemanticContext(@NotNull Editor editor, @NotNull Project project) {
        JsonObject semanticData = new JsonObject();
        try {
            Document document = editor.getDocument();
            PsiFile psiFile = PsiDocumentManager.getInstance(project).getPsiFile(document);
            if (psiFile == null) {
                return semanticData;
            }

            collectDataRobustly(semanticData, editor, project, psiFile, document);

        } catch (Throwable t) {
            LOG.warn("Critical failure in collectSemanticContext: " + t.getMessage(), t);
        }
        return semanticData;
    }

    private void collectDataRobustly(JsonObject semanticData, Editor editor, Project project, PsiFile psiFile, Document document) {
        int offset = editor.getCaretModel().getOffset();

        // 1-6. Java-specific context (scope, references, class info, method calls, imports, package)
        if (JAVA_PLUGIN_AVAILABLE && collectJavaContextMethod != null) {
            try {
                collectJavaContextMethod.invoke(null, semanticData, editor, project, psiFile, document);
            } catch (Throwable t) {
                LOG.debug("Failed to collect Java context: " + t.getMessage());
            }
        }

        // 7. Comments (platform-independent)
        try {
            JsonObject comments = getNearbyComments(psiFile, offset);
            if (comments.size() > 0) semanticData.add("comments", comments);
        } catch (Throwable t) {
            LOG.debug("Failed to collect comments: " + t.getMessage());
        }

        // 8. Highlight Information (platform-independent)
        try {
            JsonArray highlights = getHighlightInfo(editor, document);
            if (highlights.size() > 0) semanticData.add("highlights", highlights);
        } catch (Throwable t) {
            LOG.debug("Failed to collect highlights: " + t.getMessage());
        }

        // 9. Injected Languages (platform-independent)
        try {
            JsonArray injected = getInjectedLanguages(psiFile, offset, project);
            if (injected.size() > 0) semanticData.add("injectedLanguages", injected);
        } catch (Throwable t) {
            LOG.debug("Failed to collect injected languages: " + t.getMessage());
        }

        // 10. Syntax Errors (platform-independent)
        try {
            JsonArray errors = getSyntaxErrors(psiFile);
            if (errors.size() > 0) semanticData.add("errors", errors);
        } catch (Throwable t) {
            LOG.debug("Failed to collect syntax errors: " + t.getMessage());
        }

        // 11. Quick Fixes (platform-independent)
        try {
            JsonArray quickFixes = getQuickFixes(editor, psiFile, project);
            if (quickFixes.size() > 0) semanticData.add("quickFixes", quickFixes);
        } catch (Throwable t) {
            LOG.debug("Failed to collect quick fixes: " + t.getMessage());
        }

        // 12. Focused Context
        try {
            boolean focusedCollected = false;

            if (JAVA_PLUGIN_AVAILABLE && collectFocusedContextMethod != null) {
                try {
                    Object result = collectFocusedContextMethod.invoke(null, semanticData, editor, project, psiFile);
                    focusedCollected = Boolean.TRUE.equals(result);
                } catch (Throwable t) {
                    LOG.debug("Failed to collect Java focused context: " + t.getMessage());
                }
            }

            // Always provide code window as fallback or primary context for non-Java IDEs
            if (!focusedCollected || !semanticData.has("selectedFunctions")) {
                semanticData.add("currentWindow", getCodeWindow(editor, document));
            }
        } catch (Throwable t) {
            LOG.debug("Failed to collect focused context: " + t.getMessage());
        }
    }

    private JsonObject getCodeWindow(Editor editor, Document document) {
        JsonObject window = new JsonObject();
        try {
            int cursorLine = document.getLineNumber(editor.getCaretModel().getOffset());
            int totalLines = document.getLineCount();

            int startLine = Math.max(0, cursorLine - CODE_WINDOW_LINES_RANGE);
            int endLine = Math.min(totalLines - 1, cursorLine + CODE_WINDOW_LINES_RANGE);

            int startOffset = document.getLineStartOffset(startLine);
            int endOffset = document.getLineEndOffset(endLine);

            String content = document.getText(new TextRange(startOffset, endOffset));

            window.addProperty("startLine", startLine + 1);
            window.addProperty("endLine", endLine + 1);
            window.addProperty("content", content);

        } catch (Exception e) {
            LOG.warn("Failed to get code window: " + e.getMessage());
        }
        return window;
    }

    private JsonObject getNearbyComments(PsiFile psiFile, int offset) {
        JsonObject comments = new JsonObject();
        Document document = PsiDocumentManager.getInstance(psiFile.getProject()).getDocument(psiFile);
        if (document == null) return comments;

        int currentLine = document.getLineNumber(offset);
        int searchRange = 5;
        int startLine = Math.max(0, currentLine - searchRange);
        int endLine = Math.min(document.getLineCount() - 1, currentLine + searchRange);

        JsonArray before = new JsonArray();
        JsonArray after = new JsonArray();

        for (int line = startLine; line <= endLine; line++) {
            int lineStart = document.getLineStartOffset(line);
            int lineEnd = document.getLineEndOffset(line);

            PsiElement elem = psiFile.findElementAt(lineStart);
            while (elem != null && elem.getTextRange().getStartOffset() < lineEnd) {
                if (elem instanceof PsiComment) {
                    JsonObject c = new JsonObject();
                    c.addProperty("line", line + 1);
                    c.addProperty("text", elem.getText().trim());
                    if (line < currentLine) before.add(c);
                    else if (line > currentLine) after.add(c);
                }
                elem = PsiTreeUtil.nextVisibleLeaf(elem);
            }
        }

        if (before.size() > 0) comments.add("before", before);
        if (after.size() > 0) comments.add("after", after);

        return comments;
    }

    private JsonArray getHighlightInfo(Editor editor, Document document) {
        JsonArray highlights = new JsonArray();
        try {
            int offset = editor.getCaretModel().getOffset();
            Project project = editor.getProject();
            if (project == null) return highlights;

            List<HighlightInfo> infoList = DaemonCodeAnalyzerImpl.getHighlights(document, HighlightSeverity.INFORMATION, project);

            if (infoList != null) {
                int cursorLine = document.getLineNumber(offset);
                int startLine = Math.max(0, cursorLine - HIGHLIGHT_LINES_RANGE);
                int endLine = Math.min(document.getLineCount() - 1, cursorLine + HIGHLIGHT_LINES_RANGE);

                int searchStart = document.getLineStartOffset(startLine);
                int searchEnd = document.getLineEndOffset(endLine);

                for (HighlightInfo info : infoList) {
                    if (info.getStartOffset() < searchEnd && info.getEndOffset() > searchStart) {
                        String description = info.getDescription();
                        String severityName = info.getSeverity().getName();

                        if ("INFO".equals(severityName) && (description == null || description.isEmpty() || "Editor highlight".equals(description))) {
                            continue;
                        }

                        JsonObject h = new JsonObject();
                        int line = document.getLineNumber(info.getStartOffset()) + 1;
                        h.addProperty("line", line);
                        h.addProperty("severity", severityName);
                        h.addProperty("description", description != null ? description : "highlighted element");
                        if (info.getToolTip() != null) {
                            h.addProperty("toolTip", info.getToolTip());
                        }
                        highlights.add(h);
                    }
                }
            }
        } catch (Exception e) {
            LOG.warn("Failed to get rich highlight info: " + e.getMessage());
        }
        return highlights;
    }

    private JsonArray getInjectedLanguages(PsiFile psiFile, int offset, Project project) {
        JsonArray injected = new JsonArray();
        try {
            InjectedLanguageManager manager = InjectedLanguageManager.getInstance(project);
            Document document = PsiDocumentManager.getInstance(project).getDocument(psiFile);
            if (document == null) return injected;

            int start = Math.max(0, offset - INJECTION_SEARCH_RANGE);
            int end = Math.min(psiFile.getTextLength(), offset + INJECTION_SEARCH_RANGE);

            manager.enumerateEx(psiFile, psiFile, false, (injectedFile, places) -> {
                boolean inRange = false;
                for (PsiLanguageInjectionHost.Shred shred : places) {
                    TextRange hostRange = shred.getHost().getTextRange();
                    if (hostRange.getStartOffset() < end && hostRange.getEndOffset() > start) {
                        inRange = true;
                        break;
                    }
                }

                if (inRange) {
                    JsonObject info = new JsonObject();
                    info.addProperty("language", injectedFile.getLanguage().getID());
                    info.addProperty("content", injectedFile.getText());

                    if (!places.isEmpty()) {
                        PsiElement host = places.get(0).getHost();
                        int line = document.getLineNumber(host.getTextRange().getStartOffset()) + 1;
                        info.addProperty("hostLine", line);
                        info.addProperty("hostLanguage", psiFile.getLanguage().getID());
                    }

                    injected.add(info);
                }
            });

        } catch (Exception e) {
            LOG.warn("Failed to get injected languages: " + e.getMessage());
        }
        return injected;
    }

    private JsonArray getSyntaxErrors(PsiFile psiFile) {
        JsonArray errors = new JsonArray();
        try {
            Document document = PsiDocumentManager.getInstance(psiFile.getProject()).getDocument(psiFile);
            if (document == null) return errors;

            Collection<PsiErrorElement> errorElements = PsiTreeUtil.findChildrenOfType(psiFile, PsiErrorElement.class);
            for (PsiErrorElement error : errorElements) {
                JsonObject err = new JsonObject();
                int line = document.getLineNumber(error.getTextRange().getStartOffset()) + 1;
                err.addProperty("line", line);
                err.addProperty("message", error.getErrorDescription());
                errors.add(err);
            }
        } catch (Exception e) {
            LOG.warn("Failed to get syntax errors: " + e.getMessage());
        }
        return errors;
    }

    private JsonArray getQuickFixes(Editor editor, PsiFile psiFile, Project project) {
        JsonArray quickFixes = new JsonArray();
        try {
            List<HighlightInfo> highlights =
                DaemonCodeAnalyzerImpl.getHighlights(editor.getDocument(), HighlightSeverity.INFORMATION, project);

            if (highlights != null) {
                int cursorOffset = editor.getCaretModel().getOffset();

                for (HighlightInfo info : highlights) {
                    if (info.getStartOffset() <= cursorOffset && info.getEndOffset() >= cursorOffset) {
                        if (info.quickFixActionRanges != null) {
                            for (Pair<HighlightInfo.IntentionActionDescriptor, TextRange> pair : info.quickFixActionRanges) {
                                HighlightInfo.IntentionActionDescriptor desc = pair.getFirst();
                                if (desc != null) {
                                    JsonObject fix = new JsonObject();
                                    fix.addProperty("name", desc.getAction().getText());
                                    fix.addProperty("family", desc.getAction().getFamilyName());
                                    if (info.getDescription() != null) {
                                        fix.addProperty("problem", info.getDescription());
                                    }
                                    quickFixes.add(fix);
                                }
                            }
                        }
                    }
                }
            }

        } catch (Exception e) {
            LOG.warn("Failed to get quick fixes: " + e.getMessage());
        }
        return quickFixes;
    }
}
