package com.github.claudecodegui.handler.file;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileEditor.OpenFileDescriptor;
import com.intellij.openapi.project.DumbService;
import com.intellij.openapi.project.Project;
import com.intellij.pom.Navigatable;
import com.intellij.psi.JavaPsiFacade;
import com.intellij.psi.PsiClass;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiFile;
import com.intellij.psi.SmartPointerManager;
import com.intellij.psi.SmartPsiElementPointer;
import com.intellij.psi.search.GlobalSearchScope;

import java.util.function.Consumer;

/**
 * Java PSI-backed class navigation support.
 * This class must only be loaded when com.intellij.java is available.
 */
public class JavaClassNavigationSupport {

    private static final Logger LOG = Logger.getInstance(JavaClassNavigationSupport.class);

    /**
     * Navigate to a class in project and library scope.
     * Called reflectively from {@link OpenClassHandler}.
     */
    public static boolean navigate(Project project, String fqcn, Consumer<String> onFailure) {
        if (project == null || project.isDisposed() || fqcn == null || fqcn.isBlank()) {
            return false;
        }

        if (DumbService.isDumb(project)) {
            DumbService.getInstance(project).runWhenSmart(() -> {
                boolean navigated = navigateWhenSmart(project, fqcn);
                if (!navigated) {
                    LOG.warn("Unable to resolve class after indexing completed: " + fqcn);
                    notifyNavigationFailure(onFailure, fqcn);
                }
            });
            return true;
        }

        boolean navigated = navigateWhenSmart(project, fqcn);
        if (!navigated) {
            notifyNavigationFailure(onFailure, fqcn);
        }

        return true;
    }

    private static void notifyNavigationFailure(Consumer<String> onFailure, String fqcn) {
        if (onFailure != null) {
            onFailure.accept("Cannot open class: not found (" + fqcn + ")");
        }
    }

    private static boolean navigateWhenSmart(Project project, String fqcn) {
        SmartPsiElementPointer<PsiElement> pointer = ReadAction.compute(() -> {
            PsiClass psiClass = JavaPsiFacade.getInstance(project)
                .findClass(fqcn, createClassSearchScope(project));
            if (psiClass == null) {
                return null;
            }

            PsiElement navigationTarget = psiClass.getNavigationElement();
            PsiElement target = navigationTarget != null ? navigationTarget : psiClass;
            return SmartPointerManager.getInstance(project).createSmartPsiElementPointer(target);
        });

        if (pointer == null) {
            return false;
        }

        ApplicationManager.getApplication().invokeLater(() -> navigatePointer(project, pointer), ModalityState.nonModal());
        return true;
    }

    static GlobalSearchScope createClassSearchScope(Project project) {
        return GlobalSearchScope.allScope(project);
    }

    private static void navigatePointer(Project project, SmartPsiElementPointer<PsiElement> pointer) {
        if (project.isDisposed()) {
            return;
        }

        PsiElement target = pointer.getElement();
        if (target == null || !target.isValid()) {
            return;
        }

        if (target instanceof Navigatable navigatable && navigatable.canNavigate()) {
            navigatable.navigate(true);
            return;
        }

        PsiFile containingFile = target.getContainingFile();
        if (containingFile == null || containingFile.getVirtualFile() == null) {
            return;
        }

        int offset = Math.max(target.getTextOffset(), 0);
        new OpenFileDescriptor(project, containingFile.getVirtualFile(), offset).navigate(true);
    }
}
