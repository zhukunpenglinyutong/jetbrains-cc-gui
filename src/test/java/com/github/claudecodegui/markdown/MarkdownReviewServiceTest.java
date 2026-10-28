package com.github.claudecodegui.markdown;

import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

public class MarkdownReviewServiceTest {
    private ReviewBatch batch(String id) {
        ReviewBatch batch = new ReviewBatch();
        batch.id = id;
        batch.targetId = "tab";
        batch.targetEpoch = "epoch-1";
        batch.path = "docs/plan.md";
        batch.documentHash = "hash";
        Annotation annotation = new Annotation();
        annotation.id = "comment-1";
        annotation.selectedText = "原文";
        annotation.sourceText = "原文内容";
        annotation.comment = "请修改";
        batch.annotations.add(annotation);
        return batch;
    }

    @Test
    public void freezesSavedBatchesAndDeduplicatesRetries() {
        MarkdownReviewService service = new MarkdownReviewService(null);
        ReviewBatch original = batch("batch-1");
        service.saveBatch(original);
        original.annotations.get(0).comment = "later edit";
        assertEquals("请修改", service.pending("tab", "epoch-1", null, false).get(0).annotations.get(0).comment);
        assertEquals("batch-1", service.saveBatch(batch("retry")).id);
        assertEquals(1, service.snapshotState().batches.size());
    }

    @Test
    public void automaticEditsReplaceOnlyUnsentAutomaticDrafts() {
        MarkdownReviewService service = new MarkdownReviewService(null);
        assertFalse(service.getConfig().autoAddToChat);
        assertEquals("enter", service.getConfig().submitShortcut);
        ReviewBatch first = batch("auto-1");
        first.automatic = true;
        service.saveBatch(first);
        ReviewBatch edit = batch("auto-2");
        edit.automatic = true;
        edit.annotations.get(0).comment = "新要求";
        edit.annotations.get(0).revision = 2;
        service.saveBatch(edit);
        assertEquals("auto-2", service.pending("tab", "epoch-1", null, false).get(0).id);
        service.acknowledge("tab", "epoch-1", "auto-1", "received", List.of("comment-1"));
        assertEquals(1, service.pending("tab", "epoch-1", null, false).size());
        service.acknowledge("tab", "epoch-1", "auto-2", "queued", List.of("comment-1"));
        ReviewBatch manual = batch("manual");
        service.saveBatch(manual);
        ReviewBatch later = batch("auto-3");
        later.automatic = true;
        later.annotations.get(0).revision = 3;
        service.saveBatch(later);
        assertEquals(List.of("auto-3", "manual"), service.pending("tab", "epoch-1", null, false).stream()
                .map(item -> item.id).sorted().toList());
        assertEquals("queued", service.snapshotState().batches.stream()
                .filter(item -> item.id.equals("auto-2")).findFirst().orElseThrow().state);
    }

    @Test
    public void doesNotReassignDraftsToAnotherLiveSessionEvenWhenBothIdsAreNull() {
        MarkdownReviewService service = new MarkdownReviewService(null);
        service.saveBatch(batch("batch-1"));
        assertTrue(service.pending("tab", "epoch-2", null, false).isEmpty());
        assertTrue(service.pending("other-tab", "epoch-1", null, true).isEmpty());
        assertEquals(1, service.pending("tab", "epoch-2", null, true).size());
    }

    @Test
    public void recoversOnlyTheMatchingPersistedSession() {
        MarkdownReviewService service = new MarkdownReviewService(null);
        service.saveBatch(batch("batch-1"));
        service.bindSession("tab", "epoch-1", "session-1");
        assertTrue(service.pending("tab", "epoch-2", "session-2", true).isEmpty());
        assertEquals(1, service.pending("tab", "epoch-2", "session-1", true).size());
    }

    @Test
    public void persistsPartialRemovalAndIgnoresStaleOrLateAcknowledgements() {
        MarkdownReviewService service = new MarkdownReviewService(null);
        ReviewBatch batch = batch("batch-1");
        Annotation second = new Annotation();
        second.id = "comment-2";
        batch.annotations.add(second);
        service.saveBatch(batch);
        service.acknowledge("tab", "wrong-epoch", "batch-1", "removed", List.of());
        assertEquals(2, service.pending("tab", "epoch-1", null, false).get(0).annotations.size());
        service.acknowledge("tab", "epoch-1", "batch-1", "received", List.of("comment-2"));
        assertEquals("comment-2", service.pending("tab", "epoch-1", null, false).get(0).annotations.get(0).id);
        service.acknowledge("tab", "epoch-1", "batch-1", "queued", List.of("comment-2"));
        service.acknowledge("tab", "epoch-1", "batch-1", "received", List.of("comment-2"));
        assertTrue(service.pending("tab", "epoch-1", null, false).isEmpty());
    }

    @Test
    public void restoresIndependentStateCopies() {
        MarkdownReviewService service = new MarkdownReviewService(null);
        enablePersistence(service);
        service.saveBatch(batch("batch-1"));
        MarkdownReviewService.State saved = service.getState();
        MarkdownReviewService restored = new MarkdownReviewService(null);
        restored.loadState(saved);
        saved.encodedPayload = "changed by caller";
        assertEquals(1, restored.snapshotState().batches.size());
    }

    @Test
    public void xmlStoragePreservesEmojiQuotesAndOriginalSourceExactly() {
        MarkdownReviewService service = new MarkdownReviewService(null);
        enablePersistence(service);
        ReviewBatch batch = batch("unicode");
        batch.path = "docs/中文😀.md";
        batch.annotations.get(0).selectedText = "中文😀 <script> /clear \\\\uD83D" + Character.toString((char) 0xd83d);
        batch.annotations.get(0).sourceText = "**中文😀**\r\n下一行";
        batch.annotations.get(0).comment = "请修改 🧪";
        service.saveBatch(batch);
        var xml = com.intellij.util.xmlb.XmlSerializer.serialize(service.getState());
        var stored = com.intellij.util.xmlb.XmlSerializer.deserialize(xml, MarkdownReviewService.State.class);
        MarkdownReviewService restored = new MarkdownReviewService(null);
        restored.loadState(stored);
        var actual = restored.snapshotState().batches.get(0);
        assertEquals(batch.path, actual.path);
        assertEquals(batch.annotations.get(0).selectedText, actual.annotations.get(0).selectedText);
        assertEquals(batch.annotations.get(0).sourceText, actual.annotations.get(0).sourceText);
        assertEquals(batch.annotations.get(0).comment, actual.annotations.get(0).comment);
    }

    private void enablePersistence(MarkdownReviewService service) {
        MarkdownReviewConfig config = service.getConfig();
        config.persist = true;
        service.configure(config);
    }

    @Test
    public void defaultsToTransientContentButPersistsPreferences() {
        MarkdownReviewService service = new MarkdownReviewService(null);
        assertFalse(service.getConfig().enabled);
        service.saveBatch(batch("transient"));
        MarkdownReviewConfig config = service.getConfig();
        config.enabled = false;
        config.autoAddToChat = true;
        config.submitShortcut = "ctrlEnter";
        config.autoDeleteAffected = false;
        service.configure(config);
        var saved = service.getState();
        assertNull(saved.encodedPayload);
        assertTrue(saved.batches.isEmpty());
        assertEquals(1, service.snapshotState().batches.size());
        var restored = new MarkdownReviewService(null);
        restored.loadState(saved);
        assertTrue(restored.snapshotState().batches.isEmpty());
        assertFalse(restored.getConfig().enabled);
        assertTrue(restored.getConfig().autoAddToChat);
        assertEquals("ctrlEnter", restored.getConfig().submitShortcut);
        assertFalse(restored.getConfig().autoDeleteAffected);
    }

    @Test
    public void turningPersistenceOffDropsStoredContentWithoutClearingLiveDrafts() {
        var service = new MarkdownReviewService(null);
        enablePersistence(service);
        service.saveBatch(batch("persistent"));
        assertNotNull(service.getState().encodedPayload);
        var config = service.getConfig();
        config.persist = false;
        service.configure(config);
        assertNull(service.getState().encodedPayload);
        assertEquals(1, service.pending("tab", "epoch-1", null, false).size());
    }

    @Test
    public void trimsWholeFileRewritesAndKeepsBoundaryOrUnrelatedEdits() {
        assertFalse(MarkdownReviewService.affectsRange(0, "before target after", "header before target after", 7, 13));
        assertFalse(MarkdownReviewService.affectsRange(7, "", "prefix ", 7, 13));
        assertFalse(MarkdownReviewService.affectsRange(13, "", " suffix", 7, 13));
        assertFalse(MarkdownReviewService.affectsRange(7, "target", "target", 7, 13));
        assertTrue(MarkdownReviewService.affectsRange(8, "", "x", 7, 13));
        assertTrue(MarkdownReviewService.affectsRange(7, "target", "fixed", 7, 13));
        assertTrue(MarkdownReviewService.affectsRange(0, "before target after", "before fixed after", 7, 13));
        assertTrue(MarkdownReviewService.affectsRange(0, "before target after", "", 7, 13));
    }

    @Test
    public void distinguishesUnchangedSourceBetweenWholeFileEditsFromChangedOrDuplicateText() {
        assertTrue(MarkdownReviewService.preservesSource("before target after", "BEFORE target AFTER", "target"));
        assertFalse(MarkdownReviewService.preservesSource("target", "fixed", "target"));
        assertFalse(MarkdownReviewService.preservesSource("target target", "fixed target", "target"));
        assertFalse(MarkdownReviewService.preservesSource("target", "target target", "target"));
    }

    @Test
    public void classifiesEditImpactAgainstTrackedPositions() {
        Annotation before = new Annotation();
        before.start = 5;
        Annotation after = new Annotation();
        after.start = 50;
        List<Annotation> annotations = List.of(before, after);
        assertEquals(MarkdownReviewService.EditImpact.NONE,
                MarkdownReviewService.classifyImpact(annotations, 60, false));
        assertEquals(MarkdownReviewService.EditImpact.SHIFT,
                MarkdownReviewService.classifyImpact(annotations, 30, false));
        assertEquals(MarkdownReviewService.EditImpact.HIT,
                MarkdownReviewService.classifyImpact(annotations, 30, true));
        assertEquals(MarkdownReviewService.EditImpact.NONE,
                MarkdownReviewService.classifyImpact(List.of(), 0, false));
        after.sourceMissing = true;
        assertEquals(MarkdownReviewService.EditImpact.NONE,
                MarkdownReviewService.classifyImpact(annotations, 30, false));
    }

    @Test
    public void oneFailingListenerDoesNotCutOffTheOthers() {
        MarkdownReviewService service = new MarkdownReviewService(null);
        List<MarkdownReviewService.EditImpact> received = new java.util.ArrayList<>();
        java.util.function.Consumer<MarkdownReviewService.EditImpact> collector = received::add;
        service.subscribe(impact -> {
            throw new IllegalStateException("listener boom");
        });
        service.subscribe(collector);
        service.refreshPreviewSettings();
        assertEquals(List.of(MarkdownReviewService.EditImpact.HIT), received);
        service.unsubscribe(collector);
        service.refreshPreviewSettings();
        assertEquals(1, received.size());
    }
}
