package com.github.claudecodegui.completion;

import com.github.claudecodegui.provider.common.DeepSeekFimClient;
import com.github.claudecodegui.settings.CodeCompletionCredentialResolver;
import com.github.claudecodegui.settings.CodeCompletionSettings;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.codeInsight.completion.CompletionContributor;
import com.intellij.codeInsight.completion.CompletionParameters;
import com.intellij.codeInsight.completion.CompletionProvider;
import com.intellij.codeInsight.completion.CompletionResultSet;
import com.intellij.codeInsight.completion.CompletionType;
import com.intellij.codeInsight.lookup.LookupElement;
import com.intellij.codeInsight.lookup.LookupElementBuilder;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.project.Project;
import com.intellij.patterns.PlatformPatterns;
import com.intellij.util.ProcessingContext;
import org.jetbrains.annotations.NotNull;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Adds DeepSeek FIM suggestions as native completion items.
 *
 * <p>Why a CompletionContributor (not the official inline-completion API): the
 * official {@code InlineCompletionProvider} extension point only exists since
 * IDEA 2024.2 and is a Kotlin-suspend API, while this plugin supports
 * sinceBuild=233 and is plain Java. A completion contributor works on every
 * supported IDE and lets the IDE handle Tab/Enter/Esc natively.
 *
 * <p>FIM semantics: prefix is the code before the caret, suffix the code after
 * it; the returned fragment must be inserted exactly at the caret without
 * touching either side. We only add an item when the caret is in a
 * non-identifier position (typed prefix empty), so the default lookup insert
 * behaviour ("replace the typed prefix") is exactly "insert at the caret".
 * While typing an identifier the native word completion takes over and FIM is
 * skipped to avoid fighting it.
 *
 * <p>The completion pass runs on a background worker thread (not the EDT), so
 * a short bounded network call is acceptable. When the FIM request is too slow
 * or fails, we simply add nothing.
 */
public class FimCompletionContributor extends CompletionContributor {

    private static final Logger LOG = Logger.getInstance(FimCompletionContributor.class);
    private static final long REQUEST_TIMEOUT_MS = 2500;

    private final DeepSeekFimClient client = new DeepSeekFimClient();

    public FimCompletionContributor() {
        extend(CompletionType.BASIC, PlatformPatterns.psiElement(), new CompletionProvider<>() {
            @Override
            public void addCompletions(@NotNull CompletionParameters parameters,
                                       @NotNull ProcessingContext context,
                                       @NotNull CompletionResultSet result) {
                try {
                    addFimVariant(parameters, result);
                } catch (Exception e) {
                    LOG.debug("[FimCompletion] unexpected error: " + e.getMessage());
                }
            }
        });
    }

    private void addFimVariant(@NotNull CompletionParameters parameters, @NotNull CompletionResultSet result) {
        if (parameters.getCompletionType() != CompletionType.BASIC) {
            return;
        }
        Editor editor = parameters.getEditor();
        if (editor == null || editor.isDisposed()) {
            return;
        }
        Project project = editor.getProject();
        if (project == null || project.isDisposed()) {
            return;
        }

        CodeCompletionSettings cfg;
        try {
            cfg = new CodemossSettingsService().getCodeCompletionSettings();
        } catch (Exception e) {
            return;
        }
        if (cfg == null || !cfg.isEnabled()) {
            return;
        }
        // The key may be borrowed from an already-configured provider.
        String apiKey = CodeCompletionCredentialResolver.resolve(cfg).apiKey;
        if (apiKey == null || apiKey.isEmpty()) {
            return;
        }

        Document document = editor.getDocument();
        int caret = parameters.getOffset();
        if (caret <= 0 || caret > document.getTextLength()) {
            return;
        }
        String text = document.getText();
        if (!FimCompletionLogic.shouldSuggest(text, caret)) {
            return;
        }
        // Mid-identifier: native word completion is more appropriate.
        if (FimCompletionLogic.isIdentifierCharBeforeCaret(text, caret)) {
            return;
        }
        // Guard against a stale caret (e.g. the pass was re-triggered after the
        // user kept typing while we were waiting). `parameters.getOffset()` is
        // the offset this pass was started for; reading the caret model here
        // would touch IDE state from the completion worker thread.
        if (parameters.getOffset() != caret) {
            return;
        }

        FimCompletionLogic.Context ctx = FimCompletionLogic.extractContext(
                text, caret,
                FimCompletionLogic.DEFAULT_MAX_PREFIX_CHARS,
                FimCompletionLogic.DEFAULT_MAX_SUFFIX_CHARS);

        String fragment;
        try {
            // The client's own request budget (EDITOR_TIMEOUT_MS) is shorter than
            // this wait, so a slow gateway aborts its exchange first instead of
            // continuing behind a caller that has already given up.
            CompletableFuture<String> future = client.complete(ctx.prefix, ctx.suffix, cfg, apiKey);
            fragment = future.get(REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            LOG.debug("[FimCompletion] request failed/timed out: " + e);
            return;
        }
        if (fragment == null || fragment.isEmpty() || editor.isDisposed()) {
            return;
        }
        if (parameters.getOffset() != caret) {
            return; // caret moved while waiting; drop the suggestion
        }

        result.addElement(buildElement(fragment));
    }

    private static LookupElement buildElement(String fragment) {
        String oneLine = fragment.replace('\n', ' ').replace('\r', ' ').trim();
        if (oneLine.length() > 80) {
            oneLine = oneLine.substring(0, 80) + "…";
        }
        return LookupElementBuilder.create(fragment)
                .withPresentableText(oneLine)
                .withTypeText("DeepSeek FIM");
    }
}
