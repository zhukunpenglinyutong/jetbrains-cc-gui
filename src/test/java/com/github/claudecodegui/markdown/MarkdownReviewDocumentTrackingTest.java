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

    /** One file with comments on {@code quotes}, tracked by a real document. */
    private static final class Fixture {
        final MarkdownReviewService service = new MarkdownReviewService(null);
        final LightVirtualFile file;
        final DocumentImpl document;

        Fixture(String before, boolean autoDelete, String... quotes) {
            MarkdownReviewConfig config = service.getConfig();
            config.enabled = true;
            config.autoDeleteAffected = autoDelete;
            config.persist = true;
            service.configure(config);
            file = new LightVirtualFile("plan.md", before);
            document = new DocumentImpl(before, true);
            for (String quote : quotes) {
                int start = before.indexOf(quote);
                service.create(file, "plan.md", document, start, start + quote.length(), quote, "comment");
            }
        }

        /** FileDocumentManagerImpl.reloadFromDisk -> DocumentEx.replaceText does exactly this. */
        void reload(String after) {
            document.replaceString(0, document.getTextLength(), 0, after, 1L, true);
        }

        /** "quote:status" per comment after the preview's caught-up sync. */
        List<String> comments() {
            service.reconcile(file, document);
            return service.list(file).stream().map(item -> item.sourceText + ":" + item.status).toList();
        }

        /** The document text each comment currently points at. */
        List<String> anchoredText() {
            String text = document.getCharsSequence().toString();
            return service.list(file).stream().map(item -> text.substring(item.start, item.end)).toList();
        }
    }

    private static List<String> commentsAfterReload(String before, String after, String... quotes) {
        Fixture fixture = new Fixture(before, false, quotes);
        fixture.reload(after);
        return fixture.comments();
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
    public void rewritingTheSentenceAroundTheQuoteKeepsTheCommentOnIt() {
        String intro = "# Auth plan\n\nWe keep sessions short.\n";
        Fixture fixture = new Fixture(intro + "Reject expired tokens with 401.\n", false, "401");
        fixture.reload(intro + "Always reject stale tokens with status 401 Unauthorized.\n");
        assertEquals(List.of("401:attached"), fixture.comments());
        assertEquals(List.of("401"), fixture.anchoredText());
    }

    @Test
    public void insertingAnotherCopyAtTheQuoteEdgeKeepsTheOriginalCopy() {
        Fixture fixture = new Fixture("Reject expired tokens with 401.\n", false, "401");
        fixture.reload("Reject expired tokens with 401 (HTTP 401).\n");
        assertEquals(List.of("401:attached"), fixture.comments());
        assertEquals("Reject expired tokens with ".length(), fixture.service.list(fixture.file).get(0).start);
    }

    @Test
    public void cutAndPasteKeepsTheCommentByDefault() {
        String paragraph = "Reject expired tokens with 401.\n\n";
        Fixture fixture = new Fixture("# Plan\n\n" + paragraph + "Log every retry.\n",
                new MarkdownReviewConfig().autoDeleteAffected, "401", "Reject expired tokens with 401");
        int start = fixture.document.getCharsSequence().toString().indexOf(paragraph);
        fixture.document.deleteString(start, start + paragraph.length());
        assertEquals(List.of("401:orphaned", "Reject expired tokens with 401:orphaned"), fixture.comments());
        fixture.document.insertString(fixture.document.getTextLength(), "\n" + paragraph);
        // A long quote is followed; a short one waits for a manual relocate instead of guessing.
        assertEquals(List.of("401:ambiguous", "Reject expired tokens with 401:attached"), fixture.comments());
    }

    @Test
    public void restartAfterEditsNearTheQuoteStillFindsIt() {
        Fixture fixture = new Fixture("Reject expired tokens with 401.\n", false, "401");
        fixture.document.insertString("Reject expired tokens with ".length(), "HTTP ");
        fixture.comments();
        MarkdownReviewService restarted = new MarkdownReviewService(null);
        restarted.loadState(fixture.service.getState());
        restarted.reconcile(fixture.file, new DocumentImpl(fixture.document.getCharsSequence().toString(), true));
        assertEquals(List.of("attached"), restarted.list(fixture.file).stream().map(item -> item.status).toList());
    }

    @Test
    public void deletingTheCommentedLineInTheEditorDoesNotReattachToAnotherCopy() {
        String before = "- TODO: fix login\n- TODO: write docs\n";
        Fixture fixture = new Fixture(before, false, "TODO");
        fixture.document.deleteString(0, before.indexOf('\n') + 1);
        assertEquals(List.of("TODO:ambiguous"), fixture.comments());
    }

    @Test
    public void rewriteDoesNotMoveAnUnlocatedCommentOntoAnotherCopy() {
        String before = "Alpha says TODO here.\nBeta says TODO there.\n";
        Fixture fixture = new Fixture(before, false);
        int second = before.lastIndexOf("TODO");
        fixture.service.create(fixture.file, "plan.md", fixture.document, second, second + 4, "TODO", "comment");
        fixture.document.replaceString(second + 3, second + 4, "X");
        assertEquals(List.of("TODO:ambiguous"), fixture.comments());
        // The rewrite keeps one TODO, but it is the first line's copy, not the commented one.
        fixture.reload("Gamma says TODO here.\nBeta done.\n");
        assertEquals(List.of("TODO:ambiguous"), fixture.comments());
    }

    @Test
    public void rewriteThatDropsTheQuoteAndAddsItOnAnotherLineDoesNotFollowIt() {
        // One reload hunk spans both lines: the commented TODO goes, another TODO appears below.
        assertEquals(List.of("TODO:ambiguous"), commentsAfterReload(
                "# Plan\n\nA: fix the TODO in login.\nB: ship it.\n",
                "# Plan\n\nA: login fixed.\nB: ship it, TODO add tests.\n", "TODO"));
        assertEquals(List.of("401:ambiguous"), commentsAfterReload(
                "# Plan\n\n## Auth\nReturn 401 for expired tokens.\n\n## Cache\nKeep entries 5 minutes.\n",
                "# Plan\n\n## Cache\nKeep entries 10 minutes.\n\n## Errors\nNever log a 401 body.\n", "401"));
    }

    @Test
    public void deletingAllCopiesRemovesTheCommentOnlyWhenAutoDeleteIsOn() {
        Fixture deleting = new Fixture("Keep 401 here.\n", true, "401");
        deleting.reload("Keep it here.\n");
        assertEquals(List.of(), deleting.comments());
        assertEquals(List.of("401:orphaned"), commentsAfterReload("Keep 401 here.\n", "Keep it here.\n", "401"));
    }
}
