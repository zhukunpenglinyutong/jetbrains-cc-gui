package com.github.claudecodegui.util;

import org.jetbrains.annotations.Nullable;

/**
 * The chat tab a toast notification belongs to.
 * <p>
 * With several tabs running at once, a bare "Task complete" toast does not say which
 * conversation finished. The toast shows {@code tabName} above its title and runs
 * {@code focusAction} on click, so the user lands on the tab that raised it instead
 * of only getting the IDE window back.
 *
 * @param tabName     the tab name to show, or {@code null} to show none
 * @param focusAction selects the tab (or brings its detached window to the front),
 *                    or {@code null} to only activate the IDE window
 */
public record NotificationSource(@Nullable String tabName, @Nullable Runnable focusAction) {
}
