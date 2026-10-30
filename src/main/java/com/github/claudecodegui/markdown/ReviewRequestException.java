package com.github.claudecodegui.markdown;

/**
 * A review request failure that carries a translation key instead of display text:
 * the preview overlay renders the message from its own 10-language dictionary
 * (hardening plan §7). The detail text is for logs only.
 */
final class ReviewRequestException extends IllegalStateException {

    final String messageKey;

    ReviewRequestException(String messageKey, String detail) {
        super(detail);
        this.messageKey = messageKey;
    }
}
