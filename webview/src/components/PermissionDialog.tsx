import { useEffect, useState } from 'react';

export interface PermissionRequest {
  channelId: string;
  toolName: string;
  inputs: Record<string, any>;
  suggestions?: any;
}

interface PermissionDialogProps {
  isOpen: boolean;
  request: PermissionRequest | null;
  onApprove: (channelId: string) => void;
  onSkip: (channelId: string) => void;
  onApproveAlways: (channelId: string) => void;
}

const PermissionDialog = ({
  isOpen,
  request,
  onApprove,
  onSkip,
  onApproveAlways,
}: PermissionDialogProps) => {
  const [showDetails, setShowDetails] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (isOpen) {
      setShowDetails(false);
      setSelectedIndex(0);

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          handleSkip();
        } else if (e.key === '1') {
          handleApprove();
        } else if (e.key === '2') {
          handleApproveAlways();
        } else if (e.key === '3') {
          handleSkip();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex(prev => Math.max(0, prev - 1));
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex(prev => Math.min(2, prev + 1));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (selectedIndex === 0) handleApprove();
          else if (selectedIndex === 1) handleApproveAlways();
          else if (selectedIndex === 2) handleSkip();
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, selectedIndex]);

  if (!isOpen || !request) {
    return null;
  }

  const handleApprove = () => {
    onApprove(request.channelId);
  };

  const handleApproveAlways = () => {
    onApproveAlways(request.channelId);
  };

  const handleSkip = () => {
    onSkip(request.channelId);
  };

  // 格式化输入参数显示
  const formatInputValue = (value: any): string => {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object') {
      return JSON.stringify(value, null, 2);
    }
    return String(value);
  };

  // 获取重要的输入参数
  const getImportantInputs = () => {
    const important: Array<{ key: string; value: string }> = [];
    const priorityKeys = ['file_path', 'path', 'command', 'content', 'text', 'message'];

    // 先添加优先级高的参数
    priorityKeys.forEach(key => {
      if (request.inputs[key] !== undefined) {
        important.push({ key, value: formatInputValue(request.inputs[key]) });
      }
    });

    // 添加其他参数（最多显示5个）
    Object.entries(request.inputs).forEach(([key, value]) => {
      if (!priorityKeys.includes(key) && important.length < 5) {
        important.push({ key, value: formatInputValue(value) });
      }
    });

    return important;
  };

  const importantInputs = getImportantInputs();

  // 工具名称映射
  const getToolDisplayName = (toolName: string): string => {
    const toolNameMap: Record<string, string> = {
      'Write': '写入文件',
      'Edit': '编辑文件',
      'Read': '读取文件',
      'Bash': '执行命令',
      'TodoWrite': '写入待办',
      'TodoRead': '读取待办',
      'WebSearch': '网页搜索',
      'WebFetch': '获取网页',
    };
    return toolNameMap[toolName] || toolName;
  };

  return (
    <div className="permission-dialog-overlay" onClick={handleSkip}>
      <div className="permission-dialog-v2" onClick={(e) => e.stopPropagation()}>
        <h3 className="permission-dialog-v2-title">
          是否允许执行 {getToolDisplayName(request.toolName)}?
        </h3>

        {/* 可折叠的详情区域 */}
        <button
          className="permission-dialog-v2-details-toggle"
          onClick={() => setShowDetails(!showDetails)}
        >
          <span>详情</span>
          <span className={`codicon codicon-chevron-${showDetails ? 'up' : 'down'}`} />
        </button>

        {showDetails && importantInputs.length > 0 && (
          <div className="permission-dialog-v2-details">
            {importantInputs.map(({ key, value }) => (
              <div key={key} className="permission-dialog-v2-param">
                <span className="param-key">{key}:</span>
                <span className="param-value">{value}</span>
              </div>
            ))}
          </div>
        )}

        {/* 选项按钮列表 */}
        <div className="permission-dialog-v2-options">
          <button
            className={`permission-dialog-v2-option ${selectedIndex === 0 ? 'selected' : ''}`}
            onClick={handleApprove}
            onMouseEnter={() => setSelectedIndex(0)}
          >
            <span className="option-key">1</span>
            <span className="option-text">批准</span>
          </button>
          <button
            className={`permission-dialog-v2-option ${selectedIndex === 1 ? 'selected' : ''}`}
            onClick={handleApproveAlways}
            onMouseEnter={() => setSelectedIndex(1)}
          >
            <span className="option-key">2</span>
            <span className="option-text">总是允许</span>
          </button>
          <button
            className={`permission-dialog-v2-option ${selectedIndex === 2 ? 'selected' : ''}`}
            onClick={handleSkip}
            onMouseEnter={() => setSelectedIndex(2)}
          >
            <span className="option-key">3</span>
            <span className="option-text">拒绝</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default PermissionDialog;

