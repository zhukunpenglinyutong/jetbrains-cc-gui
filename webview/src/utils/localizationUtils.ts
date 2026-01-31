import type { TFunction } from 'i18next';

/**
 * Create a localization function for AI bridge messages
 * @param t - i18next translation function
 * @returns A function that localizes message text
 */
export function createLocalizeMessage(t: TFunction): (text: string) => string {
  return (text: string): string => {
    // ai-bridge error message English to i18n key mapping
    const aiBridgeMessageMap: Record<string, string> = {
      // Claude Code error messages
      'Claude Code was interrupted (possibly response timeout or user cancellation):': t('aiBridge.claudeCodeInterrupted'),
      'Claude Code error:': t('aiBridge.claudeCodeError'),
      'Not configured': t('aiBridge.notConfigured'),
      'Not configured (value is empty or missing)': t('aiBridge.notConfiguredEmpty'),
      'Default (https://api.anthropic.com)': t('aiBridge.defaultBaseUrl'),
      // Codex error messages
      'Codex authentication error:': t('aiBridge.codexAuthError'),
      'Codex network error:': t('aiBridge.codexNetworkError'),
      'Codex error:': t('aiBridge.codexError'),
      // Permission related
      'User did not provide answers': t('aiBridge.userDidNotProvideAnswers'),
      // Database related
      'Missing database file path argument': t('aiBridge.dbMissingPath'),
      'Database file does not exist': t('aiBridge.dbFileNotExist'),
      'Failed to read database': t('aiBridge.dbReadFailed'),
      'Failed to parse provider config': t('aiBridge.dbParseProviderFailed'),
      // Others
      'AI response is empty': t('aiBridge.aiResponseEmpty'),
      'Enhancement failed': t('aiBridge.enhancementFailed'),
      'Request interrupted by user': t('chat.requestInterrupted'),
      '[Empty message]': t('aiBridge.emptyMessage'),
      '[Uploaded attachment(s)]': t('aiBridge.uploadedAttachments'),
    };

    // Check for exact match
    if (aiBridgeMessageMap[text]) {
      return aiBridgeMessageMap[text];
    }

    // Check if contains keywords that need mapping and replace
    let result = text;
    for (const [key, value] of Object.entries(aiBridgeMessageMap)) {
      if (result.includes(key)) {
        result = result.replace(key, value);
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

    // Handle labels in multi-line error messages
    result = result
      .replace(/- Error message:/g, `- ${t('aiBridge.errorMessage')}:`)
      .replace(/- Current API Key source:/g, `- ${t('aiBridge.currentApiKeySource')}:`)
      .replace(/- Current API Key preview:/g, `- ${t('aiBridge.currentApiKeyPreview')}:`)
      .replace(/- Current Base URL:/g, `- ${t('aiBridge.currentBaseUrl')}:`)
      .replace(/\(source:/g, `(${t('aiBridge.source')}:`)
      .replace(/- Tip: CLI can read from environment variables or settings\.json; this plugin only supports reading from settings\.json to avoid issues\. You can configure it in the plugin's top-right Settings > Provider Management/g,
        `- ${t('aiBridge.configTip')}`);

    // Handle Codex error message details
    result = result
      .replace(/Please check the following:\n1\. Is the Codex API Key in plugin settings correct\n2\. Does the API Key have sufficient permissions\n3\. If using a custom Base URL, please confirm the address is correct/g,
        t('aiBridge.codexAuthErrorChecks'))
      .replace(/Tip: Codex requires a valid OpenAI API Key/g, t('aiBridge.codexAuthTip'))
      .replace(/Please check:\n1\. Is the network connection working\n2\. If using a proxy, please confirm proxy configuration\n3\. Is the firewall blocking the connection/g,
        t('aiBridge.codexNetworkErrorChecks'))
      .replace(/Please check network connection and Codex configuration/g, t('aiBridge.codexErrorCheck'));

    // Handle API error messages
    result = result
      .replace(/API error:/g, `${t('aiBridge.apiError')}:`)
      .replace(/Possible causes:\n1\. API Key is not configured correctly\n2\. Third-party proxy service configuration issue\n3\. Please check the configuration in ~\/\.claude\/settings\.json/g,
        t('aiBridge.apiErrorCauses'));

    return result;
  };
}
