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

import java.lang.reflect.Array;
import java.lang.reflect.Method;

/**
 * Python-specific context collection.
 * This class is only loaded when com.intellij.modules.python is available.
 * DO NOT import Python PSI classes directly; keep this class verifier-safe for IDEs without Python.
 */
public class PythonContextCollector {

    private static final String PY_FILE = "com.jetbrains.python.psi.PyFile";
    private static final String PY_FUNCTION = "com.jetbrains.python.psi.PyFunction";
    private static final String PY_CLASS = "com.jetbrains.python.psi.PyClass";
    private static final String PY_EXPRESSION_STATEMENT = "com.jetbrains.python.psi.PyExpressionStatement";
    private static final String PY_STRING_LITERAL_EXPRESSION = "com.jetbrains.python.psi.PyStringLiteralExpression";
    private static final String PY_IMPORT_STATEMENT = "com.jetbrains.python.psi.PyImportStatement";
    private static final String PY_FROM_IMPORT_STATEMENT = "com.jetbrains.python.psi.PyFromImportStatement";

    public static void collectPythonContext(
            JsonObject semanticData,
            Editor editor,
            Project project,
            PsiFile psiFile,
            Document document) {

        if (!isInstance(psiFile, PY_FILE)) {
            return;
        }

        int offset = editor.getCaretModel().getOffset();

        try {
            JsonObject scopeInfo = getCurrentScope(psiFile, offset);
            if (scopeInfo != null && scopeInfo.size() > 0) {
                semanticData.add("scope", scopeInfo);
            }
        } catch (Exception e) {
            // ignore - optional context collection
        }

        try {
            JsonArray imports = getImports(psiFile);
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
        if (element == null) {
            return null;
        }

        PsiElement pyFunction = findParentOfType(element, PY_FUNCTION);
        PsiElement pyClass = findParentOfType(element, PY_CLASS);

        if (pyFunction != null) {
            String functionName = getElementName(pyFunction);
            if (functionName != null) {
                scope.addProperty("function", functionName);
            }

            String docString = getFunctionDocString(pyFunction);
            if (docString != null) {
                scope.addProperty("docstring", docString);
            }

            JsonArray args = getFunctionArgs(pyFunction);
            if (args.size() > 0) {
                scope.add("args", args);
            }
        }

        if (pyClass != null) {
            String className = getElementName(pyClass);
            if (className != null) {
                scope.addProperty("class", className);
            }

            JsonArray parents = getSuperClasses(pyClass);
            if (parents.size() > 0) {
                scope.add("superClasses", parents);
            }
        }

        return scope.size() > 0 ? scope : null;
    }

    private static JsonArray getImports(PsiFile pyFile) {
        JsonArray imports = new JsonArray();
        collectImportTexts(pyFile, imports);
        return imports;
    }

    private static void collectImportTexts(PsiElement element, JsonArray imports) {
        if (isInstance(element, PY_IMPORT_STATEMENT) || isInstance(element, PY_FROM_IMPORT_STATEMENT)) {
            imports.add(element.getText());
            return;
        }
        for (PsiElement child : element.getChildren()) {
            collectImportTexts(child, imports);
        }
    }

    private static PsiElement findParentOfType(PsiElement element, String className) {
        PsiElement current = element;
        while (current != null) {
            if (isInstance(current, className)) {
                return current;
            }
            current = current.getParent();
        }
        return null;
    }

    private static String getElementName(PsiElement element) {
        if (element instanceof PsiNamedElement) {
            return ((PsiNamedElement) element).getName();
        }
        if (element instanceof PsiNameIdentifierOwner) {
            PsiElement nameId = ((PsiNameIdentifierOwner) element).getNameIdentifier();
            return nameId != null ? nameId.getText() : null;
        }
        Object reflectedName = invokeNoArg(element, "getName");
        return reflectedName instanceof String ? (String) reflectedName : null;
    }

    private static String getFunctionDocString(PsiElement pyFunction) {
        Object statementList = invokeNoArg(pyFunction, "getStatementList");
        Object statements = invokeNoArg(statementList, "getStatements");
        if (statements == null || !statements.getClass().isArray() || Array.getLength(statements) == 0) {
            return null;
        }
        Object firstStatement = Array.get(statements, 0);
        if (!isInstance(firstStatement, PY_EXPRESSION_STATEMENT)) {
            return null;
        }
        Object expression = invokeNoArg(firstStatement, "getExpression");
        if (!isInstance(expression, PY_STRING_LITERAL_EXPRESSION)) {
            return null;
        }
        Object stringValue = invokeNoArg(expression, "getStringValue");
        return stringValue instanceof String ? (String) stringValue : null;
    }

    private static JsonArray getFunctionArgs(PsiElement pyFunction) {
        JsonArray args = new JsonArray();
        Object parameterList = invokeNoArg(pyFunction, "getParameterList");
        Object parameters = invokeNoArg(parameterList, "getParameters");
        if (parameters == null || !parameters.getClass().isArray()) {
            return args;
        }
        for (int parameterIndex = 0; parameterIndex < Array.getLength(parameters); parameterIndex++) {
            Object parameter = Array.get(parameters, parameterIndex);
            if (parameter instanceof PsiElement) {
                String parameterName = getElementName((PsiElement) parameter);
                if (parameterName != null) {
                    args.add(parameterName);
                }
            }
        }
        return args;
    }

    private static JsonArray getSuperClasses(PsiElement pyClass) {
        JsonArray parents = new JsonArray();
        Object expressions = invokeNoArg(pyClass, "getSuperClassExpressions");
        if (expressions == null || !expressions.getClass().isArray()) {
            return parents;
        }
        for (int expressionIndex = 0; expressionIndex < Array.getLength(expressions); expressionIndex++) {
            Object expression = Array.get(expressions, expressionIndex);
            if (expression instanceof PsiElement) {
                parents.add(((PsiElement) expression).getText());
            }
        }
        return parents;
    }

    private static Object invokeNoArg(Object target, String methodName) {
        if (target == null) {
            return null;
        }
        try {
            Method method = target.getClass().getMethod(methodName);
            return method.invoke(target);
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean isInstance(Object value, String className) {
        if (value == null) {
            return false;
        }
        try {
            return Class.forName(className).isInstance(value);
        } catch (ClassNotFoundException e) {
            return false;
        }
    }
}
