package com.github.claudecodegui.handler.context;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.project.Project;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiFile;
import com.intellij.psi.util.PsiTreeUtil;
import com.jetbrains.python.psi.*;
import org.jetbrains.annotations.NotNull;

/**
 * Python-specific context collection.
 * This class is only loaded when com.intellij.modules.python is available.
 * DO NOT import this class directly - use reflection via ContextCollector.
 */
public class PythonContextCollector {
    
    public static void collectPythonContext(
            JsonObject semanticData,
            Editor editor,
            Project project,
            PsiFile psiFile,
            Document document) {
        
        if (!(psiFile instanceof PyFile)) {
            return;
        }

        int offset = editor.getCaretModel().getOffset();
        
        // 1. Current Scope (Function/Class)
        try {
            JsonObject scopeInfo = getCurrentScope(psiFile, offset);
            if (scopeInfo != null && scopeInfo.size() > 0) {
                semanticData.add("scope", scopeInfo);
            }
        } catch (Throwable t) { 
            // ignore 
        }
        
        // 2. Imports
        try {
            JsonArray imports = getImports((PyFile) psiFile);
            if (imports.size() > 0) {
                semanticData.add("imports", imports);
            }
        } catch (Throwable t) { 
            // ignore 
        }
    }
    
    private static JsonObject getCurrentScope(PsiFile psiFile, int offset) {
        JsonObject scope = new JsonObject();
        PsiElement element = psiFile.findElementAt(offset);
        if (element == null) return null;

        PyFunction pyFunction = PsiTreeUtil.getParentOfType(element, PyFunction.class);
        PyClass pyClass = PsiTreeUtil.getParentOfType(element, PyClass.class);

        if (pyFunction != null) {
            scope.addProperty("function", pyFunction.getName());
            if (pyFunction.getDocStringValue() != null) {
                scope.addProperty("docstring", pyFunction.getDocStringValue());
            }
            // Args
            JsonArray args = new JsonArray();
            for (PyParameter param : pyFunction.getParameterList().getParameters()) {
                if (param.getName() != null) {
                    args.add(param.getName());
                }
            }
            scope.add("args", args);
        }

        if (pyClass != null) {
            scope.addProperty("class", pyClass.getName());
            // Parent classes
            JsonArray parents = new JsonArray();
            for (PyExpression parent : pyClass.getSuperClassExpressions()) {
                parents.add(parent.getText());
            }
            if (parents.size() > 0) {
                scope.add("superClasses", parents);
            }
        }

        return scope.size() > 0 ? scope : null;
    }
    
    private static JsonArray getImports(PyFile pyFile) {
        JsonArray imports = new JsonArray();
        
        for (PyImportStatement imp : PsiTreeUtil.findChildrenOfType(pyFile, PyImportStatement.class)) {
            imports.add(imp.getText());
        }
        
        for (PyFromImportStatement imp : PsiTreeUtil.findChildrenOfType(pyFile, PyFromImportStatement.class)) {
            imports.add(imp.getText());
        }
        
        return imports;
    }
}
