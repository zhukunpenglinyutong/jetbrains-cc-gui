package com.github.claudecodegui.handler.context;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.project.Project;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiFile;
import com.intellij.psi.PsiNameIdentifierOwner;
import com.intellij.psi.PsiNamedElement;
import com.intellij.psi.util.PsiTreeUtil;
import com.jetbrains.python.psi.*;

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
        } catch (Exception e) {
            // ignore - optional context collection
        }
        
        // 2. Imports
        try {
            JsonArray imports = getImports((PyFile) psiFile);
            if (imports.size() > 0) {
                semanticData.add("imports", imports);
            }
        } catch (Exception e) {
            // ignore - optional context collection
        }
    }
    
    private static JsonObject getCurrentScope(PsiFile psiFile, int offset) {
        JsonObject scope = new JsonObject();
        PsiElement element = psiFile.findElementAt(offset);
        if (element == null) { return null; }

        PyFunction pyFunction = PsiTreeUtil.getParentOfType(element, PyFunction.class);
        PyClass pyClass = PsiTreeUtil.getParentOfType(element, PyClass.class);

        if (pyFunction != null) {
            // Use stable PsiNamedElement/PsiNameIdentifierOwner interfaces
            // to avoid experimental API warnings from PyAstFunction
            if (pyFunction instanceof PsiNamedElement) {
                String funcName = ((PsiNamedElement) pyFunction).getName();
                if (funcName != null) {
                    scope.addProperty("function", funcName);
                }
            } else if (pyFunction instanceof PsiNameIdentifierOwner) {
                PsiElement nameId = ((PsiNameIdentifierOwner) pyFunction).getNameIdentifier();
                if (nameId != null) {
                    scope.addProperty("function", nameId.getText());
                }
            }

            // Extract docstring via PSI tree traversal to avoid experimental API
            try {
                PyStatementList statementList = pyFunction.getStatementList();
                if (statementList != null) {
                    PyStatement[] statements = statementList.getStatements();
                    if (statements.length > 0 && statements[0] instanceof PyExpressionStatement) {
                        PyExpression expr = ((PyExpressionStatement) statements[0]).getExpression();
                        if (expr instanceof PyStringLiteralExpression) {
                            String docString = ((PyStringLiteralExpression) expr).getStringValue();
                            if (docString != null) {
                                scope.addProperty("docstring", docString);
                            }
                        }
                    }
                }
            } catch (Exception e) {
                // ignore - docstring is optional
            }

            // Args
            try {
                JsonArray args = new JsonArray();
                for (PyParameter param : pyFunction.getParameterList().getParameters()) {
                    if (param.getName() != null) {
                        args.add(param.getName());
                    }
                }
                scope.add("args", args);
            } catch (Exception e) {
                // ignore - args extraction may fail with experimental API
            }
        }

        if (pyClass != null) {
            // Use stable PsiNamedElement/PsiNameIdentifierOwner interfaces
            // to avoid experimental API warnings from PyAstClass
            if (pyClass instanceof PsiNamedElement) {
                String className = ((PsiNamedElement) pyClass).getName();
                if (className != null) {
                    scope.addProperty("class", className);
                }
            } else if (pyClass instanceof PsiNameIdentifierOwner) {
                PsiElement nameId = ((PsiNameIdentifierOwner) pyClass).getNameIdentifier();
                if (nameId != null) {
                    scope.addProperty("class", nameId.getText());
                }
            }

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
