import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

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
  const [showCommand, setShowCommand] = useState(true); // 默认展开命令
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (isOpen) {
      setShowCommand(true); // 每次打开时默认展开
      setSelectedIndex(0);

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === '1') {
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

  // 获取命令或主要操作内容
  const getCommandContent = (): string => {
    // 根据工具类型获取主要内容
    if (request.inputs.command) {
      return request.inputs.command;
    }
    if (request.inputs.content) {
      return request.inputs.content;
    }
    if (request.inputs.text) {
      return request.inputs.text;
    }
    // 对于其他工具，格式化所有输入
    return Object.entries(request.inputs)
      .map(([key, value]) => `${key}: ${formatInputValue(value)}`)
      .join('\n');
  };

  // 获取工作目录
  const getWorkingDirectory = (): string => {
    if (request.inputs.cwd) {
      return request.inputs.cwd;
    }
    if (request.inputs.file_path) {
      return request.inputs.file_path;
    }
    if (request.inputs.path) {
      return request.inputs.path;
    }
    return '~';
  };

  const { t } = useTranslation();

  // 工具名称映射到标题
  const getToolTitle = (toolName: string): string => {
    const key = `permission.tools.${toolName}`;
    const translated = t(key);
    // 如果翻译键不存在,返回默认模板
    if (translated === key) {
      return t('permission.tools.execute', { toolName });
    }
    return translated;
  };

  const commandContent = getCommandContent();
  const workingDirectory = getWorkingDirectory();

  return (
    <div className="permission-dialog-overlay">
      <div className="permission-dialog-v3">
        {/* 标题区域 */}
        <h3 className="permission-dialog-v3-title">{getToolTitle(request.toolName)}</h3>
        <p className="permission-dialog-v3-subtitle">{t('permission.fromExternalProcess')}</p>

        {/* 命令/内容区域 */}
        <div className="permission-dialog-v3-command-box">
          <div className="permission-dialog-v3-command-header">
            <span className="command-path">
              <span className="command-arrow">→</span> ~ {workingDirectory}
            </span>
            <button
              className="command-toggle"
              onClick={() => setShowCommand(!showCommand)}
              title={showCommand ? '收起' : '展开'}
            >
              <span className={`codicon codicon-chevron-${showCommand ? 'up' : 'down'}`} />
            </button>
          </div>

          {showCommand && (
            <div className="permission-dialog-v3-command-content">
              <pre>{commandContent}</pre>
            </div>
          )}
        </div>

        {/* 选项按钮列表 */}
        <div className="permission-dialog-v3-options">
          <button
            className={`permission-dialog-v3-option ${selectedIndex === 0 ? 'selected' : ''}`}
            onClick={handleApprove}
            onMouseEnter={() => setSelectedIndex(0)}
          >
            <span className="option-text">允许</span>
            <span className="option-key">1</span>
          </button>
          <button
            className={`permission-dialog-v3-option ${selectedIndex === 1 ? 'selected' : ''}`}
            onClick={handleApproveAlways}
            onMouseEnter={() => setSelectedIndex(1)}
          >
            <span className="option-text">总是允许</span>
            <span className="option-key">2</span>
          </button>
          <button
            className={`permission-dialog-v3-option ${selectedIndex === 2 ? 'selected' : ''}`}
            onClick={handleSkip}
            onMouseEnter={() => setSelectedIndex(2)}
          >
            <span className="option-text">拒绝</span>
            <span className="option-key">3</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default PermissionDialog;

