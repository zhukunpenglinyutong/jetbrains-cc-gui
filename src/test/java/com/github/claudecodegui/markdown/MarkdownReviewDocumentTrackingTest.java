package com.github.claudecodegui.markdown;

import com.intellij.mock.MockApplication;
import com.intellij.mock.MockFileDocumentManagerImpl;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.editor.impl.DocumentImpl;
import com.intellij.openapi.extensions.ExtensionPoint;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.progress.impl.CoreProgressManager;
import com.intellij.openapi.util.Disposer;
import com.intellij.testFramework.LightVirtualFile;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;

/** Real IntelliJ documents and range markers, driven the way a disk reload or paste changes them. */
public class MarkdownReviewDocumentTrackingTest {
    private Disposable root;
    private Application previous;

    @Before
    public void bootApplication() {
        root = Disposer.newDisposable();
        previous = ApplicationManager.getApplication();
        MockApplication application = new MockApplication(root);
        // Not setApplication(app, root): its disposal does not restore a null previous app.
        ApplicationManager.setApplication(application);
        application.getExtensionArea().registerExtensionPoint("com.intellij.documentWriteAccessGuard",
                "com.intellij.openapi.editor.impl.DocumentWriteAccessGuard", ExtensionPoint.Kind.INTERFACE, true);
        application.registerService(ProgressManager.class, new CoreProgressManager());
        application.registerService(FileDocumentManager.class,
                new MockFileDocumentManagerImpl(null, text -> new DocumentImpl(text, true)));
    }

    @After
    public void disposeApplication() {
        ApplicationManager.setApplication(previous);
        Disposer.dispose(root);
    }

    /** Comments left on the file after {@code after} replaces {@code before}, as "quote:status". */
    private static List<String> commentsAfterReload(String before, String after, String... quotes) {
        // FileDocumentManagerImpl.reloadFromDisk -> DocumentEx.replaceText does exactly this.
        return commentsAfterEdit(before, document -> document.replaceString(0, document.getTextLength(), 0, after, 1L, true), quotes);
    }

    private static List<String> commentsAfterEdit(String before, java.util.function.Consumer<DocumentImpl> edit, String... quotes) {
        MarkdownReviewService service = new MarkdownReviewService(null);
        MarkdownReviewConfig config = service.getConfig();
        config.enabled = true;
        service.configure(config);
        LightVirtualFile file = new LightVirtualFile("plan.md", before);
        DocumentImpl document = new DocumentImpl(before, true);
        for (String quote : quotes) {
            int start = before.indexOf(quote);
            service.create(file, "plan.md", document, start, start + quote.length(), quote, "comment");
        }
        edit.accept(document);
        return service.list(file).stream().map(item -> item.sourceText + ":" + item.status).toList();
    }

    @Test
    public void reloadThatInsertsTextRightBeforeTheQuoteKeepsTheComment() {
        assertEquals(List.of("401:attached"), commentsAfterReload(
                "Reject expired tokens with 401.\n", "Reject expired tokens with HTTP 401.\n", "401"));
    }

    @Test
    public void reloadThatAppendsRightAfterTheQuoteKeepsBothComments() {
        assertEquals(List.of("401:attached", "retry:attached"), commentsAfterReload(
                "Reject expired tokens with 401.\nLog every retry.\n",
                "Reject expired tokens with 401 Unauthorized.\nLog every retry.\n", "401", "retry"));
    }

    @Test
    public void wrappingTheQuoteInEmphasisKeepsTheComment() {
        assertEquals(List.of("401:attached"), commentsAfterReload(
                "Reject expired tokens with 401.\n", "Reject expired tokens with **401**.\n", "401"));
    }

    @Test
    public void deletingTheCommentedLineInTheEditorDoesNotReattachToAnotherCopy() {
        String before = "- TODO: fix login\n- TODO: write docs\n";
        assertEquals(List.of("TODO:ambiguous"), commentsAfterEdit(
                before, document -> document.deleteString(0, before.indexOf('\n') + 1), "TODO"));
    }

    @Test
    public void deletingAllCopiesStillRemovesTheComment() {
        assertEquals(List.of(), commentsAfterReload("Keep 401 here.\n", "Keep it here.\n", "401"));
    }
}
