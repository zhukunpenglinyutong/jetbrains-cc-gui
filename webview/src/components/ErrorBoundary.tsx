import React, { Component } from 'react';
import type { ReactNode } from 'react';
import i18n from '../i18n/config';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: React.ErrorInfo;
  copied: boolean;
}

/**
 * Collect system environment information for debugging
 */
function getSystemInfo(): string {
  const info: string[] = [];

  info.push(`Time: ${new Date().toISOString()}`);
  info.push(`UserAgent: ${navigator.userAgent}`);
  info.push(`Platform: ${navigator.platform}`);
  info.push(`Language: ${navigator.language}`);
  info.push(`URL: ${window.location.href}`);
  info.push(`Screen: ${window.screen.width}x${window.screen.height}`);
  info.push(`Viewport: ${window.innerWidth}x${window.innerHeight}`);
  info.push(`DevicePixelRatio: ${window.devicePixelRatio}`);

  // Check if sendToJava bridge exists (JCEF environment)
  info.push(`JCEF Bridge: ${typeof window.sendToJava === 'function' ? 'available' : 'not available'}`);

  // Check localStorage availability
  try {
    localStorage.setItem('__test__', '1');
    localStorage.removeItem('__test__');
    info.push(`LocalStorage: available`);
  } catch {
    info.push(`LocalStorage: not available`);
  }

  return info.join('\n');
}

/**
 * Format error details for display and copy
 */
function formatErrorDetails(error?: Error, errorInfo?: React.ErrorInfo): string {
  const parts: string[] = [];

  parts.push('=== Error Information ===');
  if (error) {
    parts.push(`Error: ${error.name}`);
    parts.push(`Message: ${error.message}`);
    if (error.stack) {
      parts.push(`\nStack Trace:\n${error.stack}`);
    }
  }

  if (errorInfo?.componentStack) {
    parts.push(`\nComponent Stack:${errorInfo.componentStack}`);
  }

  parts.push('\n=== System Information ===');
  parts.push(getSystemInfo());

  return parts.join('\n');
}

/**
 * Get translated text with fallback
 */
function t(key: string, fallback: string): string {
  const translated = i18n.t(key);
  // If translation returns the key itself, use fallback
  return translated === key ? fallback : translated;
}

/**
 * Error Boundary Component
 * Catches JavaScript errors anywhere in the child component tree
 * and displays a fallback UI instead of crashing the whole app
 */
class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, copied: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log error details for debugging
    console.error('[ErrorBoundary] Caught error:', error);
    console.error('[ErrorBoundary] Error info:', errorInfo);
    console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack);

    this.setState({
      error,
      errorInfo,
    });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined, copied: false });

    // Reload the page to fully reset the app state
    window.location.reload();
  };

  handleCopyError = async () => {
    const errorDetails = formatErrorDetails(this.state.error, this.state.errorInfo);

    try {
      await navigator.clipboard.writeText(errorDetails);
      this.setState({ copied: true });
      // Reset copied state after 2 seconds
      setTimeout(() => {
        this.setState({ copied: false });
      }, 2000);
    } catch (err) {
      // Fallback: create a textarea and copy from there
      const textarea = document.createElement('textarea');
      textarea.value = errorDetails;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        this.setState({ copied: true });
        setTimeout(() => {
          this.setState({ copied: false });
        }, 2000);
      } catch {
        console.error('Failed to copy error details');
      }
      document.body.removeChild(textarea);
    }
  };

  render() {
    if (this.state.hasError) {
      // Custom fallback UI if provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const errorDetails = formatErrorDetails(this.state.error, this.state.errorInfo);

      // Default fallback UI
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            padding: '20px',
            backgroundColor: 'var(--vscode-editor-background, #1e1e1e)',
            color: 'var(--vscode-editor-foreground, #cccccc)',
          }}
        >
          <div
            style={{
              maxWidth: '700px',
              width: '100%',
              padding: '24px',
              backgroundColor: 'var(--vscode-notifications-background, #252526)',
              border: '1px solid var(--vscode-notifications-border, #454545)',
              borderRadius: '6px',
            }}
          >
            {/* Header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                marginBottom: '16px',
              }}
            >
              <span
                className="codicon codicon-error"
                style={{
                  fontSize: '24px',
                  color: 'var(--vscode-errorForeground, #f48771)',
                  marginRight: '12px',
                }}
              />
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>
                {t('errorBoundary.title', 'Something went wrong')}
              </h2>
            </div>

            {/* Description */}
            <p style={{ marginBottom: '16px', lineHeight: '1.5' }}>
              {t('errorBoundary.description', 'The application encountered an unexpected error. Please copy the error details below and share them with the developer for troubleshooting.')}
            </p>

            {/* Possible causes hint */}
            <div
              style={{
                padding: '12px',
                marginBottom: '16px',
                backgroundColor: 'var(--vscode-inputValidation-warningBackground, #352a05)',
                border: '1px solid var(--vscode-inputValidation-warningBorder, #be8c0088)',
                borderRadius: '4px',
              }}
            >
              <div style={{ fontWeight: 500, marginBottom: '8px' }}>
                {t('errorBoundary.possibleCauses', 'Possible causes:')}
              </div>
              <ul style={{ margin: 0, paddingLeft: '20px', lineHeight: '1.6' }}>
                <li>{t('errorBoundary.cause1', 'Node.js is not installed or not configured correctly')}</li>
                <li>{t('errorBoundary.cause2', 'Network connection issues')}</li>
                <li>{t('errorBoundary.cause3', 'Plugin or IDE compatibility issues')}</li>
                <li>{t('errorBoundary.cause4', 'Insufficient system resources')}</li>
              </ul>
            </div>

            {/* Error Details */}
            {this.state.error && (
              <details style={{ marginBottom: '16px' }} open>
                <summary
                  style={{
                    cursor: 'pointer',
                    padding: '8px 12px',
                    backgroundColor: 'var(--vscode-input-background, #3c3c3c)',
                    border: '1px solid var(--vscode-input-border, #3c3c3c)',
                    borderRadius: '4px',
                    marginBottom: '8px',
                    fontWeight: 500,
                  }}
                >
                  {t('errorBoundary.errorDetails', 'Error Details')}
                </summary>
                <pre
                  style={{
                    padding: '12px',
                    backgroundColor: 'var(--vscode-textCodeBlock-background, #2d2d2d)',
                    border: '1px solid var(--vscode-input-border, #3c3c3c)',
                    borderRadius: '4px',
                    overflow: 'auto',
                    fontSize: '11px',
                    lineHeight: '1.4',
                    maxHeight: '300px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {errorDetails}
                </pre>
              </details>
            )}

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              {/* Copy Error Button */}
              <button
                onClick={this.handleCopyError}
                style={{
                  padding: '8px 16px',
                  backgroundColor: this.state.copied
                    ? 'var(--vscode-button-secondaryBackground, #3a3d41)'
                    : 'var(--vscode-button-background, #0e639c)',
                  color: this.state.copied
                    ? 'var(--vscode-button-secondaryForeground, #cccccc)'
                    : 'var(--vscode-button-foreground, #ffffff)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  transition: 'background-color 0.2s',
                }}
                onMouseOver={(e) => {
                  if (!this.state.copied) {
                    e.currentTarget.style.backgroundColor =
                      'var(--vscode-button-hoverBackground, #1177bb)';
                  }
                }}
                onMouseOut={(e) => {
                  if (!this.state.copied) {
                    e.currentTarget.style.backgroundColor =
                      'var(--vscode-button-background, #0e639c)';
                  }
                }}
              >
                <span
                  className={this.state.copied ? 'codicon codicon-check' : 'codicon codicon-copy'}
                  style={{ fontSize: '14px' }}
                />
                {this.state.copied
                  ? t('errorBoundary.copied', 'Copied!')
                  : t('errorBoundary.copyError', 'Copy Error Info')}
              </button>

              {/* Reload Button */}
              <button
                onClick={this.handleReset}
                style={{
                  padding: '8px 16px',
                  backgroundColor: 'var(--vscode-button-secondaryBackground, #3a3d41)',
                  color: 'var(--vscode-button-secondaryForeground, #cccccc)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.backgroundColor =
                    'var(--vscode-button-secondaryHoverBackground, #45494e)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.backgroundColor =
                    'var(--vscode-button-secondaryBackground, #3a3d41)';
                }}
              >
                <span className="codicon codicon-refresh" style={{ fontSize: '14px' }} />
                {t('errorBoundary.reload', 'Reload Application')}
              </button>
            </div>

            {/* Help text */}
            <p style={{
              marginTop: '16px',
              marginBottom: 0,
              fontSize: '12px',
              color: 'var(--vscode-descriptionForeground, #8b8b8b)',
              lineHeight: '1.5',
            }}>
              {t('errorBoundary.helpText', 'If the problem persists, please copy the error information and submit it as an issue on GitHub, or share it in the community group.')}
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
