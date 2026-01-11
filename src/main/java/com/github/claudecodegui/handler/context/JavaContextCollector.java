package com.github.claudecodegui.handler.context;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.TextRange;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.*;
import com.intellij.psi.util.PsiTreeUtil;
import com.intellij.psi.search.GlobalSearchScope;
import com.intellij.psi.search.searches.ReferencesSearch;
import com.intellij.psi.search.SearchScope;
import com.intellij.util.Query;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.Collection;
import java.util.HashSet;
import java.util.Set;

/**
 * Java-specific context collection.
 * This class is only loaded when com.intellij.java plugin is available.
 * DO NOT import this class directly - use reflection via ContextCollector.
 */
public class JavaContextCollector {

    private static final Logger LOG = Logger.getInstance(JavaContextCollector.class);
    private static final int MAX_RELATED_DEFINITIONS = 8;
    private static final int MAX_USAGES_LIMIT = 20;

    /**
     * Collect all Java-specific semantic context.
     * Called via reflection from ContextCollector.
     */
    public static void collectJavaContext(
            @NotNull JsonObject semanticData,
            @NotNull Editor editor,
            @NotNull Project project,
            @NotNull PsiFile psiFile,
            @NotNull Document document) {

        int offset = editor.getCaretModel().getOffset();

        // 1. Current Scope
        try {
            JsonObject scopeInfo = getCurrentScope(psiFile, offset);
            if (scopeInfo != null && scopeInfo.size() > 0) {
                semanticData.add("scope", scopeInfo);
            }
        } catch (Throwable t) {
            LOG.debug("Failed to collect scope info: " + t.getMessage());
        }

        // 2. References
        try {
            SelectionModel selectionModel = editor.getSelectionModel();
            JsonArray references = selectionModel.hasSelection() ?
                getReferences(psiFile, selectionModel.getSelectionStart(), selectionModel.getSelectionEnd()) :
                getReferences(psiFile, offset, offset);
            if (references.size() > 0) {
                semanticData.add("references", references);
            }
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
            if (methodCalls.size() > 0) {
                semanticData.add("methodCalls", methodCalls);
            }
        } catch (Throwable t) {
            LOG.debug("Failed to collect method calls: " + t.getMessage());
        }

        // 5. Imports
        try {
            JsonArray imports = getImports(psiFile);
            if (imports.size() > 0) {
                semanticData.add("imports", imports);
            }
        } catch (Throwable t) {
            LOG.debug("Failed to collect imports: " + t.getMessage());
        }

        // 6. Package Info
        try {
            String pkg = getPackageName(psiFile);
            if (pkg != null) {
                semanticData.addProperty("package", pkg);
            }
        } catch (Throwable t) {
            LOG.debug("Failed to collect package info: " + t.getMessage());
        }
    }

    /**
     * Collect focused context (selected functions, dependencies, usages).
     * Returns true if focused context was collected, false to use fallback.
     */
    public static boolean collectFocusedContext(
            @NotNull JsonObject semanticData,
            @NotNull Editor editor,
            @NotNull Project project,
            @NotNull PsiFile psiFile) {

        try {
            JsonArray selectedFunctions = collectSelectedFunctions(psiFile, editor);
            if (selectedFunctions.size() > 0) {
                semanticData.add("selectedFunctions", selectedFunctions);
                semanticData.add("externalDependencies",
                    collectExternalDependencies(psiFile, selectedFunctions, project, editor));
                semanticData.add("usages",
                    collectUsages(psiFile, selectedFunctions, project, editor));
                return true;
            } else {
                int offset = editor.getCaretModel().getOffset();
                semanticData.add("relatedDefinitions", getRelatedDefinitions(psiFile, offset, project));
                return false;
            }
        } catch (Throwable t) {
            LOG.debug("Failed to collect focused context: " + t.getMessage());
            return false;
        }
    }

    // ==================== Private Helper Methods ====================

    private static JsonObject getCurrentScope(PsiFile psiFile, int offset) {
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

    private static String getMethodSignature(PsiMethod method) {
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
    private static PsiClass getContainingClass(PsiFile psiFile, int offset) {
        PsiElement element = psiFile.findElementAt(offset);
        if (element == null) return null;
        return PsiTreeUtil.getParentOfType(element, PsiClass.class);
    }

    private static JsonObject getClassHierarchy(PsiClass psiClass) {
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

    private static JsonArray getClassFields(PsiClass psiClass) {
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

    private static JsonArray getAnnotations(PsiClass psiClass) {
        JsonArray annotations = new JsonArray();
        for (PsiAnnotation ann : psiClass.getAnnotations()) {
            String qName = ann.getQualifiedName();
            if (qName != null) {
                annotations.add(qName);
            }
        }
        return annotations;
    }

    private static JsonArray getMethodCalls(PsiFile psiFile, int offset) {
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

    private static JsonArray getImports(PsiFile psiFile) {
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

    private static String getPackageName(PsiFile psiFile) {
        if (psiFile instanceof PsiJavaFile) {
            return ((PsiJavaFile) psiFile).getPackageName();
        }
        return null;
    }

    private static JsonArray getReferences(PsiFile psiFile, int start, int end) {
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

    private static void collectReferences(PsiElement element, JsonArray refs, Set<String> seen) {
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

    private static JsonArray collectSelectedFunctions(PsiFile psiFile, Editor editor) {
        JsonArray functions = new JsonArray();
        try {
            SelectionModel selectionModel = editor.getSelectionModel();
            int startOffset = selectionModel.hasSelection() ? selectionModel.getSelectionStart() : editor.getCaretModel().getOffset();

            PsiElement startElem = psiFile.findElementAt(startOffset);
            if (startElem == null) return functions;

            PsiMethod startMethod = PsiTreeUtil.getParentOfType(startElem, PsiMethod.class);
            if (startMethod != null) {
                functions.add(buildFunctionJson(startMethod, true));
            }
        } catch (Exception e) {
            LOG.warn("Failed to collect functions: " + e.getMessage());
        }
        return functions;
    }

    private static JsonObject buildFunctionJson(PsiMethod method, boolean isPrimary) {
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

    private static JsonObject collectExternalDependencies(PsiFile psiFile, JsonArray functions, Project project, Editor editor) {
        int offset = editor.getCaretModel().getOffset();
        PsiElement elem = psiFile.findElementAt(offset);
        return getRelatedDefinitions(psiFile, elem != null ? elem.getTextOffset() : 0, project);
    }

    private static JsonArray collectUsages(PsiFile psiFile, JsonArray functions, Project project, Editor editor) {
        JsonArray usages = new JsonArray();
        try {
            if (functions == null || functions.size() == 0) return usages;

            var firstFunction = functions.get(0);
            if (firstFunction == null || !firstFunction.isJsonObject()) return usages;
            var nameElement = firstFunction.getAsJsonObject().get("name");
            if (nameElement == null || nameElement.isJsonNull()) return usages;

            int offset = editor.getCaretModel().getOffset();
            PsiElement element = psiFile.findElementAt(offset);
            PsiMethod method = PsiTreeUtil.getParentOfType(element, PsiMethod.class);

            if (method != null) {
                SearchScope scope = GlobalSearchScope.projectScope(project);
                Query<PsiReference> query = ReferencesSearch.search(method, scope);

                int count = 0;
                for (PsiReference ref : query.findAll()) {
                    if (count++ > MAX_USAGES_LIMIT) break;

                    PsiElement refElem = ref.getElement();
                    PsiFile refFile = refElem.getContainingFile();
                    if (refFile == null || refFile.equals(psiFile)) continue;

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

    private static JsonObject getRelatedDefinitions(PsiFile psiFile, int offset, Project project) {
        JsonObject definitions = new JsonObject();
        try {
            PsiElement element = psiFile.findElementAt(offset);
            if (element == null) return definitions;

            Set<PsiClass> classesToResolve = new HashSet<>();

            // 1. Check parent method parameters
            PsiMethod method = PsiTreeUtil.getParentOfType(element, PsiMethod.class);
            if (method != null) {
                for (PsiParameter param : method.getParameterList().getParameters()) {
                    addClassFromType(param.getType(), classesToResolve, project);
                }
            }

            // 2. Check variables in scope
            PsiElement scope = PsiTreeUtil.getParentOfType(element, PsiCodeBlock.class);
            if (scope != null) {
                Collection<PsiVariable> vars = PsiTreeUtil.findChildrenOfType(scope, PsiVariable.class);
                for (PsiVariable var : vars) {
                    addClassFromType(var.getType(), classesToResolve, project);
                }
            }

            // 3. Check class fields
            PsiClass containingClass = PsiTreeUtil.getParentOfType(element, PsiClass.class);
            if (containingClass != null) {
                for (PsiField field : containingClass.getFields()) {
                    addClassFromType(field.getType(), classesToResolve, project);
                }
            }

            // 4. Limit results
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

    private static void addClassFromType(PsiType type, Set<PsiClass> classes, Project project) {
        if (type == null) return;
        PsiClass cls = com.intellij.psi.util.PsiUtil.resolveClassInType(type);
        if (cls != null && isProjectClass(cls, project)) {
            classes.add(cls);
        }
    }

    private static boolean isProjectClass(PsiClass cls, Project project) {
        PsiFile file = cls.getContainingFile();
        if (file == null) return false;
        VirtualFile vFile = file.getVirtualFile();
        if (vFile == null) return false;
        return com.intellij.openapi.roots.ProjectFileIndex.getInstance(project).isInContent(vFile);
    }

    private static JsonObject collectClassDetails(PsiClass cls) {
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
                if (!field.hasModifierProperty(PsiModifier.STATIC)) {
                    StringBuilder sb = new StringBuilder();
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
            for (PsiMethod m : cls.getMethods()) {
                if (m.isConstructor()) continue;
                if (m.hasModifierProperty(PsiModifier.PUBLIC)) {
                    methods.add(getMethodSignature(m));
                }
            }
            if (methods.size() > 0) details.add("methods", methods);

        } catch (Exception e) {
            // Ignore individual class failures
        }
        return details;
    }

    private static String formatPath(String path) {
        if (path == null) return null;
        if (System.getProperty("os.name").toLowerCase().contains("win")) {
            return path.replace('/', '\\');
        }
        return path;
    }
}
