import type { TFunction } from 'i18next';

// Ordinary chat text must not pay for error-message translations on every stream update.
const AI_BRIDGE_MESSAGE_KEYS = new Map([
  ['Claude Code was interrupted (possibly response timeout or user cancellation):', 'aiBridge.claudeCodeInterrupted'],
  ['Claude Code error:', 'aiBridge.claudeCodeError'],
  ['Not configured', 'aiBridge.notConfigured'],
  ['Not configured (value is empty or missing)', 'aiBridge.notConfiguredEmpty'],
  ['Default (https://api.anthropic.com)', 'aiBridge.defaultBaseUrl'],
  ['Codex authentication error:', 'aiBridge.codexAuthError'],
  ['Codex network error:', 'aiBridge.codexNetworkError'],
  ['Codex error:', 'aiBridge.codexError'],
  ['User did not provide answers', 'aiBridge.userDidNotProvideAnswers'],
  ['Missing database file path argument', 'aiBridge.dbMissingPath'],
  ['Database file does not exist', 'aiBridge.dbFileNotExist'],
  ['Failed to read database', 'aiBridge.dbReadFailed'],
  ['Failed to parse provider config', 'aiBridge.dbParseProviderFailed'],
  ['AI response is empty', 'aiBridge.aiResponseEmpty'],
  ['Enhancement failed', 'aiBridge.enhancementFailed'],
  ['Request interrupted by user', 'chat.requestInterrupted'],
  ['[Empty message]', 'aiBridge.emptyMessage'],
  ['[Uploaded attachment(s)]', 'aiBridge.uploadedAttachments'],
]);

/**
 * Create a localization function for AI bridge messages
 * @param t - i18next translation function
 * @returns A function that localizes message text
 */
export function createLocalizeMessage(t: TFunction): (text: string) => string {
  return (text: string): string => {
    const exactKey = AI_BRIDGE_MESSAGE_KEYS.get(text);
    if (exactKey) return t(exactKey);

    // Check if contains keywords that need mapping and replace
    let result = text;
    for (const [key, value] of AI_BRIDGE_MESSAGE_KEYS) {
      if (result.includes(key)) {
        result = result.replace(key, t(value));
      }
    }

    // Handle messages with parameters
    // Match "User denied permission for XXX tool"
    const permissionDeniedMatch = result.match(/User denied permission for (.+) tool/);
    if (permissionDeniedMatch) {
      result = result.replace(
        permissionDeniedMatch[0],
        t('aiBridge.userDeniedPermission', { toolName: permissionDeniedMatch[1] })
      );
    }

    // Match "[Uploaded X image(s)]"
    const uploadedImagesMatch = result.match(/\[Uploaded (\d+) image\(s\)\]/);
    if (uploadedImagesMatch) {
      result = result.replace(
        uploadedImagesMatch[0],
        t('aiBridge.uploadedImages', { count: parseInt(uploadedImagesMatch[1], 10) })
      );
    }

    // Match "[Attachment: XXX]"
    const attachmentMatch = result.match(/\[Attachment: (.+)\]/);
    if (attachmentMatch) {
      result = result.replace(
        attachmentMatch[0],
        `[${t('aiBridge.attachment')}: ${attachmentMatch[1]}]`
      );
    }

    // Match "[Uploaded Attachments: file1, file2, ...]"
    const uploadedAttachmentsListMatch = result.match(/\[Uploaded Attachments: (.+)\]/);
    if (uploadedAttachmentsListMatch) {
      result = result.replace(
        uploadedAttachmentsListMatch[0],
        t('chat.uploadedFiles', { files: uploadedAttachmentsListMatch[1] })
      );
    }

    // Replacement callbacks avoid translation lookups when ordinary text has no error labels.
    // Handle labels in multi-line error messages
    result = result
      .replace(/- Error message:/g, () => `- ${t('aiBridge.errorMessage')}:`)
      .replace(/- Current API Key source:/g, () => `- ${t('aiBridge.currentApiKeySource')}:`)
      .replace(/- Current API Key preview:/g, () => `- ${t('aiBridge.currentApiKeyPreview')}:`)
      .replace(/- Current Base URL:/g, () => `- ${t('aiBridge.currentBaseUrl')}:`)
      .replace(/\(source:/g, () => `(${t('aiBridge.source')}:`)
      .replace(/- Tip: CLI can read from environment variables or settings\.json; this plugin only supports reading from settings\.json to avoid issues\. You can configure it in the plugin's top-right Settings > Provider Management/g,
        () => `- ${t('aiBridge.configTip')}`);

    // Handle Codex error message details
    result = result
      .replace(/Please check the following:\n1\. Is the Codex API Key in plugin settings correct\n2\. Does the API Key have sufficient permissions\n3\. If using a custom Base URL, please confirm the address is correct/g,
        () => t('aiBridge.codexAuthErrorChecks'))
      .replace(/Tip: Codex requires a valid OpenAI API Key/g, () => t('aiBridge.codexAuthTip'))
      .replace(/Please check:\n1\. Is the network connection working\n2\. If using a proxy, please confirm proxy configuration\n3\. Is the firewall blocking the connection/g,
        () => t('aiBridge.codexNetworkErrorChecks'))
      .replace(/Please check network connection and Codex configuration/g, () => t('aiBridge.codexErrorCheck'));

    // Handle API error messages
    result = result
      .replace(/API error:/g, () => `${t('aiBridge.apiError')}:`)
      .replace(/Possible causes:\n1\. API Key is not configured correctly\n2\. Third-party proxy service configuration issue\n3\. Please check the configuration in ~\/\.claude\/settings\.json/g,
        () => t('aiBridge.apiErrorCauses'));

    return result;
  };
}
