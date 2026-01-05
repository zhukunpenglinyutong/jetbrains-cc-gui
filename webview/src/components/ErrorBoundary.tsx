import React, { Component } from 'react';
import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: React.ErrorInfo;
}

/**
 * Error Boundary Component
 * Catches JavaScript errors anywhere in the child component tree
 * and displays a fallback UI instead of crashing the whole app
 */
class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
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
    this.setState({ hasError: false, error: undefined, errorInfo: undefined });

    // Reload the page to fully reset the app state
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      // Custom fallback UI if provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default fallback UI
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            padding: '20px',
            backgroundColor: 'var(--vscode-editor-background)',
            color: 'var(--vscode-editor-foreground)',
          }}
        >
          <div
            style={{
              maxWidth: '600px',
              padding: '24px',
              backgroundColor: 'var(--vscode-notifications-background)',
              border: '1px solid var(--vscode-notifications-border)',
              borderRadius: '6px',
            }}
          >
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
                  color: 'var(--vscode-errorForeground)',
                  marginRight: '12px',
                }}
              />
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>
                Something went wrong
              </h2>
            </div>

            <p style={{ marginBottom: '16px', lineHeight: '1.5' }}>
              The application encountered an unexpected error and needs to restart.
            </p>

            {this.state.error && (
              <details style={{ marginBottom: '16px' }}>
                <summary
                  style={{
                    cursor: 'pointer',
                    padding: '8px',
                    backgroundColor: 'var(--vscode-input-background)',
                    border: '1px solid var(--vscode-input-border)',
                    borderRadius: '4px',
                    marginBottom: '8px',
                  }}
                >
                  Error Details
                </summary>
                <pre
                  style={{
                    padding: '12px',
                    backgroundColor: 'var(--vscode-textCodeBlock-background)',
                    border: '1px solid var(--vscode-input-border)',
                    borderRadius: '4px',
                    overflow: 'auto',
                    fontSize: '12px',
                    lineHeight: '1.4',
                  }}
                >
                  {this.state.error.toString()}
                  {this.state.errorInfo?.componentStack}
                </pre>
              </details>
            )}

            <button
              onClick={this.handleReset}
              style={{
                padding: '8px 16px',
                backgroundColor: 'var(--vscode-button-background)',
                color: 'var(--vscode-button-foreground)',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 500,
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.backgroundColor =
                  'var(--vscode-button-hoverBackground)';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.backgroundColor =
                  'var(--vscode-button-background)';
              }}
            >
              <span className="codicon codicon-refresh" style={{ marginRight: '6px' }} />
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
