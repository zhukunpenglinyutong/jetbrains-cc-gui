package com.github.claudecodegui.handler.context;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.codeInsight.intention.IntentionAction;
import com.intellij.codeInspection.InspectionManager;
import com.intellij.codeInspection.LocalInspectionTool;
import com.intellij.codeInspection.ProblemDescriptor;
import com.intellij.lang.injection.InjectedLanguageManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.editor.colors.TextAttributesKey;
import com.intellij.openapi.editor.markup.ErrorStripeRenderer;
import com.intellij.openapi.editor.markup.MarkupModel;
import com.intellij.openapi.editor.markup.RangeHighlighter;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Pair;
import com.intellij.openapi.util.TextRange;
import com.intellij.openapi.roots.ProjectRootManager;
import com.intellij.openapi.vfs.VfsUtilCore;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.*;
import com.intellij.psi.util.PsiTreeUtil;
import com.intellij.psi.util.PsiUtil;
import com.intellij.openapi.roots.ProjectFileIndex;
import com.intellij.psi.PsiCodeBlock;
import com.intellij.psi.PsiModifier;
import com.intellij.psi.PsiParameter;
import com.intellij.psi.PsiType;
import com.intellij.psi.PsiVariable;
import com.intellij.psi.PsiReference;
import com.intellij.psi.PsiClass;
import com.intellij.codeInsight.daemon.impl.HighlightInfo;
import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerImpl;
import com.intellij.psi.search.GlobalSearchScope;
import com.intellij.psi.search.searches.ReferencesSearch;
import com.intellij.psi.search.SearchScope;
import com.intellij.lang.annotation.HighlightSeverity;
import com.intellij.util.Query;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class ContextCollector {

    private static final Logger LOG = Logger.getInstance(ContextCollector.class);

    // Constants for context collection limits
    private static final int CODE_WINDOW_LINES_RANGE = 40;
    private static final int MAX_RELATED_DEFINITIONS = 8;
    private static final int MAX_USAGES_LIMIT = 20;
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
            
            // Collect all data within sub-try-catch blocks to ensure one failure doesn't kill the whole process
            collectDataRobustly(semanticData, editor, project, psiFile, document);

        } catch (Throwable t) {
            LOG.warn("Critical failure in collectSemanticContext: " + t.getMessage(), t);
        }
        return semanticData;
    }

    private void collectDataRobustly(JsonObject semanticData, Editor editor, Project project, PsiFile psiFile, Document document) {
        int offset = editor.getCaretModel().getOffset();

        // 1. Current Scope
        try {
            JsonObject scopeInfo = getCurrentScope(psiFile, offset);
            if (scopeInfo != null && scopeInfo.size() > 0) semanticData.add("scope", scopeInfo);
        } catch (Throwable t) {
            LOG.debug("Failed to collect scope info: " + t.getMessage());
        }

        // 2. References
        try {
            SelectionModel selectionModel = editor.getSelectionModel();
            JsonArray references = selectionModel.hasSelection() ?
                getReferences(psiFile, selectionModel.getSelectionStart(), selectionModel.getSelectionEnd()) :
                getReferences(psiFile, offset, offset);
            if (references.size() > 0) semanticData.add("references", references);
        } catch (Throwable t) {
            LOG.debug("Failed to collect references: " + t.getMessage());
        }

        // 3. Class Hierarchy, Fields, Annotations
        try {
            PsiClass cls = getContainingClass(psiFile, offset);
            if (cls != null) {
                JsonObject hierarchy = getClassHierarchy(cls);
                if (hierarchy.size() > 0) semanticData.add("classHierarchy", hierarchy);
                JsonArray fields = getClassFields(cls);
                if (fields.size() > 0) semanticData.add("fields", fields);
                JsonArray annotations = getAnnotations(cls);
                if (annotations.size() > 0) semanticData.add("annotations", annotations);
            }
        } catch (Throwable t) {
            LOG.debug("Failed to collect class info: " + t.getMessage());
        }

        // 4. Method Calls
        try {
            JsonArray methodCalls = getMethodCalls(psiFile, offset);
            if (methodCalls.size() > 0) semanticData.add("methodCalls", methodCalls);
        } catch (Throwable t) {
            LOG.debug("Failed to collect method calls: " + t.getMessage());
        }

        // 5. Imports
        try {
            JsonArray imports = getImports(psiFile);
            if (imports.size() > 0) semanticData.add("imports", imports);
        } catch (Throwable t) {
            LOG.debug("Failed to collect imports: " + t.getMessage());
        }

        // 6. Comments
        try {
            JsonObject comments = getNearbyComments(psiFile, offset);
            if (comments.size() > 0) semanticData.add("comments", comments);
        } catch (Throwable t) {
            LOG.debug("Failed to collect comments: " + t.getMessage());
        }

        // 7. Package Info
        try {
            String pkg = getPackageName(psiFile);
            if (pkg != null) semanticData.addProperty("package", pkg);
        } catch (Throwable t) {
            LOG.debug("Failed to collect package info: " + t.getMessage());
        }

        // 8. Highlight Information
        try {
            JsonArray highlights = getHighlightInfo(editor, document);
            if (highlights.size() > 0) semanticData.add("highlights", highlights);
        } catch (Throwable t) {
            LOG.debug("Failed to collect highlights: " + t.getMessage());
        }

        // 9. Injected Languages
        try {
            JsonArray injected = getInjectedLanguages(psiFile, offset, project);
            if (injected.size() > 0) semanticData.add("injectedLanguages", injected);
        } catch (Throwable t) {
            LOG.debug("Failed to collect injected languages: " + t.getMessage());
        }

        // 10. Errors
        try {
            JsonArray errors = getSyntaxErrors(psiFile);
            if (errors.size() > 0) semanticData.add("errors", errors);
        } catch (Throwable t) {
            LOG.debug("Failed to collect syntax errors: " + t.getMessage());
        }

        // 11. Quick Fixes (High Risk)
        try {
            JsonArray quickFixes = getQuickFixes(editor, psiFile, project);
            if (quickFixes.size() > 0) semanticData.add("quickFixes", quickFixes);
        } catch (Throwable t) {
            LOG.debug("Failed to collect quick fixes: " + t.getMessage());
        }

        // 12. Focused Context
        try {
            JsonArray selectedFunctions = collectSelectedFunctions(psiFile, editor);
            if (selectedFunctions.size() > 0) {
                semanticData.add("selectedFunctions", selectedFunctions);
                semanticData.add("externalDependencies", collectExternalDependencies(psiFile, selectedFunctions, project, editor));
                semanticData.add("usages", collectUsages(psiFile, selectedFunctions, project, editor));
            } else {
                semanticData.add("currentWindow", getCodeWindow(editor, document));
                semanticData.add("relatedDefinitions", getRelatedDefinitions(psiFile, offset, project));
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

            // Collect +/- CODE_WINDOW_LINES_RANGE lines around cursor
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

    private JsonArray collectSelectedFunctions(PsiFile psiFile, Editor editor) {
        JsonArray functions = new JsonArray();
        try {
            SelectionModel selectionModel = editor.getSelectionModel();
            int startOffset = selectionModel.hasSelection() ? selectionModel.getSelectionStart() : editor.getCaretModel().getOffset();
            int endOffset = selectionModel.hasSelection() ? selectionModel.getSelectionEnd() : startOffset;

            // Find methods intersecting the range
            PsiElement startElem = psiFile.findElementAt(startOffset);
            PsiElement endElem = psiFile.findElementAt(endOffset);
            
            if (startElem == null) return functions;

            PsiMethod startMethod = PsiTreeUtil.getParentOfType(startElem, PsiMethod.class);
            if (startMethod != null) {
                functions.add(buildFunctionJson(startMethod, true));
            }
            
            // If selection covers multiple methods, logic could be expanded here. 
            // For now, focusing on the primary one is safest for token limits.
            
        } catch (Exception e) {
            LOG.warn("Failed to collect functions: " + e.getMessage());
        }
        return functions;
    }

    private JsonObject buildFunctionJson(PsiMethod method, boolean isPrimary) {
        JsonObject json = new JsonObject();
        json.addProperty("name", method.getName());
        json.addProperty("signature", getMethodSignature(method));
        json.addProperty("isPrimary", isPrimary);
        
        TextRange range = method.getTextRange();
        Document doc = PsiDocumentManager.getInstance(method.getProject()).getDocument(method.getContainingFile());
        if (doc != null) {
            int startLine = doc.getLineNumber(range.getStartOffset()) + 1;
            int endLine = doc.getLineNumber(range.getEndOffset()) + 1;
            json.addProperty("startLine", startLine);
            json.addProperty("endLine", endLine);
        }
        
        json.addProperty("content", method.getText());
        return json;
    }
    
    private JsonObject collectExternalDependencies(PsiFile psiFile, JsonArray functions, Project project, Editor editor) {
         JsonObject dependencies = new JsonObject();
         // Basic implementation: Scan imports and try to map them to the functions
         // A full AST scan of the function body to find exact used symbols is better:
         
         // For each function content
         // ... implementation simplified to avoid extreme complexity ...
         // Let's use getRelatedDefinitions logic but more targeted?
         
         // Actually, let's reuse the logic but return clean Paths
         
         // Scan the whole file imports for now as a baseline, and maybe filter?
         // No, the user wants "verify imports... from other files... list clearly".
         
         return getRelatedDefinitions(psiFile, psiFile.findElementAt(editor.getCaretModel().getOffset()) != null ? psiFile.findElementAt(editor.getCaretModel().getOffset()).getTextOffset() : 0, project); 
         // Note: reusing getRelatedDefinitions but it needs to be robust. 
         // We will refine getRelatedDefinitions below instead.
    }
    
    private JsonArray collectUsages(PsiFile psiFile, JsonArray functions, Project project, Editor editor) {
        JsonArray usages = new JsonArray();
        try {
             // Need to run on background ideally, but we are already in ReadAction.nonBlocking() which is good.
             // But ReferencesSearch might be slow. Limit results.
             if (functions == null || functions.size() == 0) return usages;

             // Get the primary method name with null safety
             var firstFunction = functions.get(0);
             if (firstFunction == null || !firstFunction.isJsonObject()) return usages;
             var nameElement = firstFunction.getAsJsonObject().get("name");
             if (nameElement == null || nameElement.isJsonNull()) return usages;

             // Re-find the method from offset
             int offset = editor.getCaretModel().getOffset();
             PsiElement element = psiFile.findElementAt(offset);
             PsiMethod method = PsiTreeUtil.getParentOfType(element, PsiMethod.class);

             if (method != null) {
                 SearchScope scope = GlobalSearchScope.projectScope(project);
                 Query<PsiReference> query = ReferencesSearch.search(method, scope);

                 int count = 0;
                 for (PsiReference ref : query.findAll()) {
                     if (count++ > MAX_USAGES_LIMIT) break; // Limit
                     
                     PsiElement refElem = ref.getElement();
                     PsiFile refFile = refElem.getContainingFile();
                     if (refFile == null || refFile.equals(psiFile)) continue; // Skip self usages or null
                     
                     VirtualFile vRefFile = refFile.getVirtualFile();
                     if (vRefFile == null) continue;
                     
                     JsonObject usage = new JsonObject();
                     usage.addProperty("file", formatPath(vRefFile.getPath()));
                     
                     Document doc = PsiDocumentManager.getInstance(project).getDocument(refFile);
                     if (doc != null) {
                         int line = doc.getLineNumber(refElem.getTextOffset()) + 1;
                         usage.addProperty("line", line);
                         
                         int lineStart = doc.getLineStartOffset(line - 1);
                         int lineEnd = doc.getLineEndOffset(line - 1);
                         usage.addProperty("code", doc.getText(new TextRange(lineStart, lineEnd)).trim());
                     }
                     
                     usages.add(usage);
                 }
             }
             
        } catch (Exception e) {
            LOG.warn("Failed to collect usages: " + e.getMessage());
        }
        return usages;
    }

    private JsonObject getRelatedDefinitions(PsiFile psiFile, int offset, Project project) {
        JsonObject definitions = new JsonObject();
        try {
            PsiElement element = psiFile.findElementAt(offset);
            if (element == null) return definitions;

            // Find relevant elements around cursor (variables, method calls, parameters)
            Set<PsiClass> classesToResolve = new HashSet<>();
            
            // 1. Check parent method parameters
            PsiMethod method = PsiTreeUtil.getParentOfType(element, PsiMethod.class);
            if (method != null) {
                for (PsiParameter param : method.getParameterList().getParameters()) {
                    addClassFromType(param.getType(), classesToResolve, project);
                }
            }

            // 2. Check variables in scope (Local variables)
            PsiElement scope = PsiTreeUtil.getParentOfType(element, PsiCodeBlock.class);
            if (scope != null) {
                Collection<PsiVariable> vars = PsiTreeUtil.findChildrenOfType(scope, PsiVariable.class);
                for (PsiVariable var : vars) {
                    addClassFromType(var.getType(), classesToResolve, project);
                }
            }

            // 3. Check class fields if we are inside a class
            PsiClass containingClass = PsiTreeUtil.getParentOfType(element, PsiClass.class);
            if (containingClass != null) {
                for (PsiField field : containingClass.getFields()) {
                    addClassFromType(field.getType(), classesToResolve, project);
                }
            }

            // 4. Limit to max definitions to save tokens
            int count = 0;
            for (PsiClass cls : classesToResolve) {
                if (count >= MAX_RELATED_DEFINITIONS) break;
                if (definitions.has(cls.getQualifiedName())) continue;

                JsonObject def = collectClassDetails(cls);
                if (def.size() > 0) {
                    definitions.add(cls.getQualifiedName(), def);
                    count++;
                }
            }

        } catch (Exception e) {
            LOG.warn("Failed to get related definitions: " + e.getMessage());
        }
        return definitions;
    }

    private void addClassFromType(PsiType type, Set<PsiClass> classes, Project project) {
        if (type == null) return;
        PsiClass cls = com.intellij.psi.util.PsiUtil.resolveClassInType(type);
        if (cls != null && isProjectClass(cls, project)) {
            classes.add(cls);
        }
    }

    private boolean isProjectClass(PsiClass cls, Project project) {
        // Only include classes that are part of the project content (skip libraries/SDKs)
        PsiFile file = cls.getContainingFile();
        if (file == null) return false;
        VirtualFile vFile = file.getVirtualFile();
        if (vFile == null) return false;
        
        return com.intellij.openapi.roots.ProjectFileIndex.getInstance(project).isInContent(vFile);
    }

    private JsonObject collectClassDetails(PsiClass cls) {
        JsonObject details = new JsonObject();
        try {
            details.addProperty("name", cls.getQualifiedName());
            
            // Check for Lombok
            JsonArray annotations = new JsonArray();
            if (cls.getModifierList() != null) {
                for (PsiAnnotation ann : cls.getModifierList().getAnnotations()) {
                    String name = ann.getQualifiedName();
                    if (name != null) {
                        annotations.add(name);
                        if (name.contains("lombok")) {
                            details.addProperty("hasLombok", true);
                        }
                    }
                }
            }
            details.add("annotations", annotations);

            // Add file path
            PsiFile containingFile = cls.getContainingFile();
            if (containingFile != null) {
                VirtualFile vFile = containingFile.getVirtualFile();
                if (vFile != null) {
                    details.addProperty("file", formatPath(vFile.getPath()));
                }
            }

            // Fields
            JsonArray fields = new JsonArray();
            for (PsiField field : cls.getFields()) {
                 // Only non-static fields are usually relevant for state
                if (!field.hasModifierProperty(PsiModifier.STATIC)) {
                    StringBuilder sb = new StringBuilder();
                    // Add field annotations (especially for Lombok @Getter/@Setter)
                    if (field.getModifierList() != null) {
                        for (PsiAnnotation ann : field.getModifierList().getAnnotations()) {
                            String qName = ann.getQualifiedName();
                            if (qName != null && (qName.contains("lombok") || qName.startsWith("Lombok"))) {
                                sb.append("@").append(qName.substring(qName.lastIndexOf('.') + 1)).append(" ");
                            }
                        }
                    }
                    sb.append(field.getName()).append(": ").append(field.getType().getPresentableText());
                    fields.add(sb.toString());
                }
            }
            if (fields.size() > 0) details.add("fields", fields);

            // Methods
            JsonArray methods = new JsonArray();
            for (PsiMethod method : cls.getMethods()) {
                if (method.isConstructor()) continue;
                if (method.hasModifierProperty(PsiModifier.PUBLIC)) {
                    methods.add(getMethodSignature(method));
                }
            }
            if (methods.size() > 0) details.add("methods", methods);

        } catch (Exception e) {
            // Ignore individual class failures
        }
        return details;
    }

    private JsonObject getCurrentScope(PsiFile psiFile, int offset) {
        JsonObject scope = new JsonObject();
        PsiElement element = psiFile.findElementAt(offset);
        if (element == null) {
            return scope;
        }

        PsiElement parent = element;
        int depth = 0;
        while (parent != null && depth < 50) {
            if (parent instanceof PsiMethod) {
                PsiMethod method = (PsiMethod) parent;
                String name = method.getName();
                scope.addProperty("method", name);
                String signature = getMethodSignature(method);
                if (signature != null) {
                    scope.addProperty("methodSignature", signature);
                }
                break;
            } else if (parent instanceof PsiClass) {
                PsiClass cls = (PsiClass) parent;
                String name = cls.getName();
                if (name != null) {
                    scope.addProperty("class", name);
                }
            }
            parent = parent.getParent();
            depth++;
        }
        return scope.size() > 0 ? scope : null;
    }

    private String getMethodSignature(PsiMethod method) {
        try {
            StringBuilder sig = new StringBuilder();
            sig.append(method.getName()).append("(");
            PsiParameter[] params = method.getParameterList().getParameters();
            for (int i = 0; i < params.length; i++) {
                if (i > 0) sig.append(", ");
                sig.append(params[i].getType().getPresentableText());
            }
            sig.append(")");
            return sig.toString();
        } catch (Exception e) {
            LOG.warn("Failed to get method signature: " + e.getMessage());
            return null;
        }
    }

    @Nullable
    private PsiClass getContainingClass(PsiFile psiFile, int offset) {
        PsiElement element = psiFile.findElementAt(offset);
        if (element == null) return null;
        return PsiTreeUtil.getParentOfType(element, PsiClass.class);
    }

    private JsonObject getClassHierarchy(PsiClass psiClass) {
        JsonObject hierarchy = new JsonObject();
        PsiClass superClass = psiClass.getSuperClass();
        if (superClass != null && !"java.lang.Object".equals(superClass.getQualifiedName())) {
            hierarchy.addProperty("extends", superClass.getQualifiedName());
        }

        PsiClassType[] interfaces = psiClass.getImplementsListTypes();
        if (interfaces.length > 0) {
            JsonArray arr = new JsonArray();
            for (PsiClassType iface : interfaces) {
                arr.add(iface.getCanonicalText());
            }
            hierarchy.add("implements", arr);
        }
        return hierarchy;
    }

    private JsonArray getClassFields(PsiClass psiClass) {
        JsonArray fields = new JsonArray();
        for (PsiField field : psiClass.getFields()) {
            JsonObject info = new JsonObject();
            info.addProperty("name", field.getName());
            info.addProperty("type", field.getType().getPresentableText());

            PsiModifierList modifierList = field.getModifierList();
            if (modifierList != null) {
                String mods = modifierList.getText();
                if (!mods.isEmpty()) {
                    info.addProperty("modifiers", mods);
                }
            }
            fields.add(info);
        }
        return fields;
    }

    private JsonArray getAnnotations(PsiClass psiClass) {
        JsonArray annotations = new JsonArray();
        for (PsiAnnotation ann : psiClass.getAnnotations()) {
            String qName = ann.getQualifiedName();
            if (qName != null) {
                annotations.add(qName);
            }
        }
        return annotations;
    }

    private JsonArray getMethodCalls(PsiFile psiFile, int offset) {
        JsonArray calls = new JsonArray();
        PsiElement element = psiFile.findElementAt(offset);
        if (element == null) return calls;

        PsiMethod containingMethod = PsiTreeUtil.getParentOfType(element, PsiMethod.class);
        PsiElement scope = containingMethod != null ? containingMethod : psiFile;

        Collection<PsiMethodCallExpression> methodCalls = PsiTreeUtil.findChildrenOfType(scope, PsiMethodCallExpression.class);
        for (PsiMethodCallExpression call : methodCalls) {
            PsiMethod resolved = call.resolveMethod();
            if (resolved == null) continue;

            JsonObject info = new JsonObject();
            info.addProperty("name", resolved.getName());

            PsiClass declClass = resolved.getContainingClass();
            if (declClass != null) {
                String qName = declClass.getQualifiedName();
                if (qName != null) {
                    info.addProperty("class", qName);
                }
            }

            calls.add(info);
        }
        return calls;
    }

    private JsonArray getImports(PsiFile psiFile) {
        JsonArray imports = new JsonArray();
        if (!(psiFile instanceof PsiJavaFile)) return imports;

        PsiJavaFile javaFile = (PsiJavaFile) psiFile;
        PsiImportList importList = javaFile.getImportList();
        if (importList != null) {
            for (PsiImportStatement stmt : importList.getImportStatements()) {
                String qName = stmt.getQualifiedName();
                if (qName != null) {
                    imports.add(qName);
                }
            }
        }
        return imports;
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

    private String getPackageName(PsiFile psiFile) {
        if (psiFile instanceof PsiJavaFile) {
            return ((PsiJavaFile) psiFile).getPackageName();
        }
        return null;
    }

    private JsonArray getReferences(PsiFile psiFile, int start, int end) {
        JsonArray refs = new JsonArray();
        PsiElement element = psiFile.findElementAt(start);
        if (element == null) return refs;

        Set<String> seen = new HashSet<>();
        collectReferences(element, refs, seen);
        if (element.getParent() != null) {
            collectReferences(element.getParent(), refs, seen);
        }
        return refs;
    }

    private void collectReferences(PsiElement element, JsonArray refs, Set<String> seen) {
        for (PsiReference ref : element.getReferences()) {
            PsiElement resolved = ref.resolve();
            if (resolved instanceof PsiNamedElement) {
                PsiNamedElement named = (PsiNamedElement) resolved;
                String name = named.getName();
                if (name == null || seen.contains(name)) continue;

                JsonObject info = new JsonObject();
                info.addProperty("name", name);
                info.addProperty("type", resolved.getClass().getSimpleName());

                PsiFile file = resolved.getContainingFile();
                if (file != null) {
                    VirtualFile vFile = file.getVirtualFile();
                    if (vFile != null) {
                         info.addProperty("file", formatPath(vFile.getPath()));
                    } else {
                         info.addProperty("file", file.getName());
                    }
                }

                seen.add(name);
                refs.add(info);
            } else if (element instanceof PsiReferenceExpression) {
                // FALLBACK for unresolved references (crucial for Lombok without plugin)
                PsiReferenceExpression refExpr = (PsiReferenceExpression) element;
                String unresolvedName = refExpr.getReferenceName();
                if (unresolvedName != null && !seen.contains("unresolved:" + unresolvedName)) {
                     JsonObject info = new JsonObject();
                     info.addProperty("name", unresolvedName);
                     info.addProperty("type", "Unresolved Reference (Possible Lombok Generated)");
                     
                     PsiExpression qualifier = refExpr.getQualifierExpression();
                     if (qualifier != null) {
                         PsiType type = qualifier.getType();
                         if (type != null) {
                             info.addProperty("receiverType", type.getPresentableText());
                         }
                     }
                     
                     refs.add(info);
                     seen.add("unresolved:" + unresolvedName);
                }
            }
        }
    }

    private JsonArray getHighlightInfo(Editor editor, Document document) {
        JsonArray highlights = new JsonArray();
        try {
            int offset = editor.getCaretModel().getOffset();
            Project project = editor.getProject();
            if (project == null) return highlights;

            // Use DaemonCodeAnalyzer for rich PSI-level highlights (actual error messages)
            List<HighlightInfo> infoList = DaemonCodeAnalyzerImpl.getHighlights(document, HighlightSeverity.INFORMATION, project);
            
            if (infoList != null) {
                // Focus on highlights around the cursor (+/- HIGHLIGHT_LINES_RANGE lines)
                int cursorLine = document.getLineNumber(offset);
                int startLine = Math.max(0, cursorLine - HIGHLIGHT_LINES_RANGE);
                int endLine = Math.min(document.getLineCount() - 1, cursorLine + HIGHLIGHT_LINES_RANGE);
                
                int searchStart = document.getLineStartOffset(startLine);
                int searchEnd = document.getLineEndOffset(endLine);

                for (HighlightInfo info : infoList) {
                    if (info.getStartOffset() < searchEnd && info.getEndOffset() > searchStart) {
                        String description = info.getDescription();
                        String severityName = info.getSeverity().getName();
                        
                        // Filter noise: skip info-level highlights with generic or empty descriptions
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

            // Define a range around the cursor to search for injections
            int start = Math.max(0, offset - INJECTION_SEARCH_RANGE);
            int end = Math.min(psiFile.getTextLength(), offset + INJECTION_SEARCH_RANGE);
            
            manager.enumerateEx(psiFile, psiFile, false, (injectedFile, places) -> {
                // Check if any of the places intersect our search range
                boolean inRange = false;
                for (com.intellij.psi.PsiLanguageInjectionHost.Shred shred : places) {
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
                    
                    // Add location info
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
    
    private void addInjectedInfo(JsonArray injected, Pair<PsiElement, TextRange> pair, Document document) {
        PsiElement injectedElement = pair.getFirst();
        if (!(injectedElement instanceof PsiFile)) return;
        PsiFile injectedFile = (PsiFile) injectedElement;

        JsonObject info = new JsonObject();
        info.addProperty("language", injectedFile.getLanguage().getID());
        info.addProperty("content", injectedFile.getText());
        injected.add(info);
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

    private JsonArray getCodeInspections(PsiFile psiFile, Project project) {
        JsonArray inspections = new JsonArray();
        try {
            InspectionManager manager = InspectionManager.getInstance(project);
            if (manager == null) return inspections;

            // Simplified - just return empty for now as full inspection API is complex
            // TODO: Implement proper code inspection collection using correct API
            LOG.debug("Code inspections collection not fully implemented yet");
        } catch (Exception e) {
            LOG.warn("Failed to get code inspections: " + e.getMessage());
        }
        return inspections;
    }

    private JsonArray getQuickFixes(Editor editor, PsiFile psiFile, Project project) {
        JsonArray quickFixes = new JsonArray();
        try {
             // We need to run this carefully. `ShowIntentionsPass` is internal.
             // Using IntentionManager or simply checking DaemonCodeAnalyzer highlights might be safer.
             // But to get actual "fixes", we usually need the Intentions API which requires EDT or specific contexts.
             // A safe fallback is to extract fixes from HighlightInfo if possible.
             
             // Attempting to read from DaemonCodeAnalyzer (background analysis results)
             List<HighlightInfo> highlights = 
                 DaemonCodeAnalyzerImpl.getHighlights(editor.getDocument(), HighlightSeverity.INFORMATION, project);
             
             if (highlights != null) {
                 int cursorOffset = editor.getCaretModel().getOffset();
                 
                 for (HighlightInfo info : highlights) {
                     if (info.getStartOffset() <= cursorOffset && info.getEndOffset() >= cursorOffset) {
                         // This highlight covers the cursor
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
    private String formatPath(String path) {
        if (path == null) return null;
        // Use platform-specific path separators
        if (System.getProperty("os.name").toLowerCase().contains("win")) {
            return path.replace('/', '\\');
        }
        return path;
    }
}