package com.github.claudecodegui.markdown;

import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

/**
 * Simulates real user journeys around Markdown review settings:
 * 1. Default disabled state (zero bridge overhead).
 * 2. Enabling the feature in settings and creating review batches.
 * 3. Runtime disablement (requests rejected with "disabled", UI teardown).
 * 4. Re-enabling with persistence and custom shortcut preferences.
 * 5. Automatic draft retraction when comments are completed or discarded.
 */
public class MarkdownSettingsUserJourneyTest {

    private ReviewBatch createSampleBatch(String id, String comment, boolean automatic) {
        ReviewBatch batch = new ReviewBatch();
        batch.id = id;
        batch.targetId = "chat-tab-1";
        batch.targetEpoch = "epoch-user-journey";
        batch.path = "docs/architecture.md";
        batch.documentHash = "doc-hash-abc";
        batch.automatic = automatic;
        Annotation annotation = new Annotation();
        annotation.id = "ann-" + id;
        annotation.selectedText = "核心架构设计";
        annotation.sourceText = "核心架构设计文档内容";
        annotation.comment = comment;
        annotation.status = "attached";
        annotation.precision = "source";
        batch.annotations.add(annotation);
        return batch;
    }

    @Test
    public void userJourney_fromDefaultDisabledToEnabledAndAnnotating() {
        MarkdownReviewService service = new MarkdownReviewService(null);

        // Step 1: Default configuration is disabled
        MarkdownReviewConfig defaultConfig = service.getConfig();
        assertFalse("By default Markdown review must be disabled", defaultConfig.enabled);
        assertFalse("Provider must refuse creation when disabled",
                NativeMarkdownExtensionProvider.shouldCreate(defaultConfig));

        // Step 2: User opens CC GUI settings and enables Markdown review
        MarkdownReviewConfig newConfig = new MarkdownReviewConfig();
        newConfig.enabled = true;
        newConfig.autoAddToChat = true;
        newConfig.submitShortcut = "ctrlEnter";
        newConfig.persist = true;
        service.updateConfig(newConfig);

        assertTrue("Settings update must enable review", service.getConfig().enabled);
        assertTrue("Provider must now allow creation",
                NativeMarkdownExtensionProvider.shouldCreate(service.getConfig()));
        assertEquals("ctrlEnter", service.getConfig().submitShortcut);
        assertTrue(service.getConfig().autoAddToChat);
        assertTrue(service.getConfig().persist);

        // Step 3: User reads Markdown and creates an automatic review draft
        ReviewBatch draft1 = createSampleBatch("batch-journey-1", "请优化此架构模块", true);
        service.saveBatch(draft1);

        List<ReviewBatch> pendingDrafts = service.pending("chat-tab-1", "epoch-user-journey", null, false);
        assertEquals(1, pendingDrafts.size());
        assertEquals("batch-journey-1", pendingDrafts.get(0).id);
        assertEquals("请优化此架构模块", pendingDrafts.get(0).annotations.get(0).comment);

        // Step 4: User updates the comment in the preview before sending
        ReviewBatch draft1Updated = createSampleBatch("batch-journey-2", "请重构此架构模块以支持插件化", true);
        draft1Updated.annotations.get(0).id = "ann-batch-journey-1"; // same annotation ID
        draft1Updated.annotations.get(0).revision = 2;
        service.saveBatch(draft1Updated);

        // The unsent automatic draft is replaced in-place
        List<ReviewBatch> updatedPending = service.pending("chat-tab-1", "epoch-user-journey", null, false);
        assertEquals(1, updatedPending.size());
        assertEquals("batch-journey-2", updatedPending.get(0).id);
        assertEquals("请重构此架构模块以支持插件化", updatedPending.get(0).annotations.get(0).comment);

        // Step 5: Chat UI acknowledges receipt
        service.acknowledge("chat-tab-1", "epoch-user-journey", "batch-journey-2", "queued",
                List.of("ann-batch-journey-1"));
        assertEquals(1, service.snapshotState().batches.size());
        assertEquals("queued", service.snapshotState().batches.get(0).status);
    }

    @Test
    public void userJourney_runtimeDisableAndReenableCycle() {
        MarkdownReviewService service = new MarkdownReviewService(null);

        // 1. User starts with feature enabled
        MarkdownReviewConfig enabledConfig = new MarkdownReviewConfig();
        enabledConfig.enabled = true;
        service.updateConfig(enabledConfig);
        assertTrue(service.getConfig().enabled);

        // User has a draft in progress
        ReviewBatch draft = createSampleBatch("draft-1", "需补充异常处理逻辑", true);
        service.saveBatch(draft);
        assertEquals(1, service.pending("chat-tab-1", "epoch-user-journey", null, false).size());

        // 2. User goes to settings and turns the feature off
        MarkdownReviewConfig disabledConfig = new MarkdownReviewConfig();
        disabledConfig.enabled = false;
        service.updateConfig(disabledConfig);

        assertFalse("Service must reflect disabled state", service.getConfig().enabled);
        assertFalse("Provider must refuse extension creation",
                NativeMarkdownExtensionProvider.shouldCreate(service.getConfig()));

        // 3. User re-enables the feature later
        enabledConfig = new MarkdownReviewConfig();
        enabledConfig.enabled = true;
        enabledConfig.persist = true;
        service.updateConfig(enabledConfig);

        assertTrue("Feature re-enabled", service.getConfig().enabled);
        assertTrue("Provider allows creation again",
                NativeMarkdownExtensionProvider.shouldCreate(service.getConfig()));
        // Saved state is preserved across settings toggle
        assertEquals(1, service.pending("chat-tab-1", "epoch-user-journey", null, false).size());
    }

    @Test
    public void userJourney_completingAnnotationWithdrawsChatDraft() {
        MarkdownReviewService service = new MarkdownReviewService(null);
        MarkdownReviewConfig config = new MarkdownReviewConfig();
        config.enabled = true;
        service.updateConfig(config);

        // Automatic draft added to chat
        ReviewBatch autoBatch = createSampleBatch("auto-batch-10", "审查反馈：已废弃的API调用", true);
        service.saveBatch(autoBatch);
        assertEquals(1, service.pending("chat-tab-1", "epoch-user-journey", null, false).size());

        // User finishes/completes the review in the preview panel
        Annotation completed = new Annotation();
        completed.id = "ann-auto-batch-10";
        completed.completed = true;
        service.update(completed);

        // The automatic draft must be withdrawn so stale instructions aren't sent to Claude
        List<ReviewBatch> pending = service.pending("chat-tab-1", "epoch-user-journey", null, false);
        boolean stillPending = pending.stream().anyMatch(b -> b.id.equals("auto-batch-10"));
        assertFalse("Completing the comment must withdraw the automatic chat draft", stillPending);
    }
}
