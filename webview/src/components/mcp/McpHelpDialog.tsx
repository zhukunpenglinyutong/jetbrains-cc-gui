interface McpHelpDialogProps {
  onClose: () => void;
}

/**
 * MCP 帮助信息对话框
 */
export function McpHelpDialog({ onClose }: McpHelpDialogProps) {
  // 点击遮罩关闭
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="dialog-overlay" onClick={handleOverlayClick}>
      <div className="dialog mcp-help-dialog">
        <div className="dialog-header">
          <h3>什么是 MCP?</h3>
          <button className="close-btn" onClick={onClose}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        <div className="dialog-body">
          <div className="help-content">
            <section className="help-section">
              <h4>
                <span className="codicon codicon-info"></span>
                Model Context Protocol
              </h4>
              <p>
                MCP (Model Context Protocol) 是 Anthropic 开发的开放协议，
                让 AI 模型能够安全地访问外部工具和数据源。
              </p>
            </section>

            <section className="help-section">
              <h4>
                <span className="codicon codicon-rocket"></span>
                主要特性
              </h4>
              <ul>
                <li><strong>工具扩展</strong>：为 Claude 添加文件系统、网络访问等能力</li>
                <li><strong>数据连接</strong>：连接数据库、API 等外部数据源</li>
                <li><strong>安全可控</strong>：严格的权限控制和数据隔离</li>
                <li><strong>易于集成</strong>：支持多种编程语言和运行环境</li>
              </ul>
            </section>

            <section className="help-section">
              <h4>
                <span className="codicon codicon-book"></span>
                配置方式
              </h4>
              <p>支持两种配置类型：</p>
              <ul>
                <li>
                  <strong>STDIO</strong>：通过标准输入输出与本地进程通信
                  <code className="inline-code">npx/uvx 命令启动</code>
                </li>
                <li>
                  <strong>HTTP/SSE</strong>：通过网络与远程服务器通信
                  <code className="inline-code">URL 地址</code>
                </li>
              </ul>
            </section>

            <section className="help-section">
              <h4>
                <span className="codicon codicon-link-external"></span>
                了解更多
              </h4>
              <p>
                访问官方文档：
                <a
                  href="https://modelcontextprotocol.io"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="help-link"
                >
                  modelcontextprotocol.io
                  <span className="codicon codicon-link-external"></span>
                </a>
              </p>
            </section>
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn btn-primary" onClick={onClose}>知道了</button>
        </div>
      </div>
    </div>
  );
}
