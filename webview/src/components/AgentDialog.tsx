import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentConfig } from '../types/agent';

interface AgentDialogProps {
  isOpen: boolean;
  agent?: AgentConfig | null; // null 表示添加模式
  onClose: () => void;
  onSave: (data: { name: string; prompt: string }) => void;
}

export default function AgentDialog({
  isOpen,
  agent,
  onClose,
  onSave,
}: AgentDialogProps) {
  const { t } = useTranslation();
  const isAdding = !agent;

  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [nameError, setNameError] = useState('');

  // 初始化表单
  useEffect(() => {
    if (isOpen) {
      if (agent) {
        // 编辑模式
        setName(agent.name || '');
        setPrompt(agent.prompt || '');
      } else {
        // 添加模式
        setName('');
        setPrompt('');
      }
      setNameError('');
    }
  }, [isOpen, agent]);

  // ESC 键关闭
  useEffect(() => {
    if (isOpen) {
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onClose();
        }
      };
      window.addEventListener('keydown', handleEscape);
      return () => window.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen]); // Remove onClose from dependencies - it's stable from props

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // 限制最多20字符
    if (value.length <= 20) {
      setName(value);
      setNameError('');
    }
  };

  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    // 限制最多10000字符
    if (value.length <= 10000) {
      setPrompt(value);
    }
  };

  const handleSave = () => {
    // 验证名称
    if (!name.trim()) {
      setNameError(t('settings.agent.dialog.nameRequired'));
      return;
    }

    onSave({
      name: name.trim(),
      prompt: prompt.trim(),
    });
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="dialog-overlay">
      <div className="dialog agent-dialog">
        <div className="dialog-header">
          <h3>{isAdding ? t('settings.agent.dialog.addTitle') : t('settings.agent.dialog.editTitle')}</h3>
          <button className="close-btn" onClick={onClose}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        <div className="dialog-body">
          <div className="form-group">
            <label htmlFor="agentName">
              {t('settings.agent.dialog.name')}
              <span className="required">*</span>
            </label>
            <div className="input-with-counter">
              <input
                id="agentName"
                type="text"
                className={`form-input ${nameError ? 'has-error' : ''}`}
                placeholder={t('settings.agent.dialog.namePlaceholder')}
                value={name}
                onChange={handleNameChange}
                maxLength={20}
              />
              <span className="char-counter">{name.length}/20</span>
            </div>
            {nameError && (
              <p className="form-error">
                <span className="codicon codicon-error" />
                {nameError}
              </p>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="agentPrompt">
              {t('settings.agent.dialog.prompt')}
            </label>
            <div className="textarea-with-counter">
              <textarea
                id="agentPrompt"
                className="form-textarea"
                placeholder={t('settings.agent.dialog.promptPlaceholder')}
                value={prompt}
                onChange={handlePromptChange}
                maxLength={10000}
                rows={8}
              />
              <span className="char-counter">{prompt.length}/10000</span>
            </div>
            <small className="form-hint">{t('settings.agent.dialog.promptHint')}</small>
          </div>
        </div>

        <div className="dialog-footer">
          <div className="footer-actions" style={{ marginLeft: 'auto' }}>
            <button className="btn btn-secondary" onClick={onClose}>
              <span className="codicon codicon-close" />
              {t('common.cancel')}
            </button>
            <button className="btn btn-primary" onClick={handleSave}>
              <span className="codicon codicon-save" />
              {isAdding ? t('settings.agent.dialog.confirmAdd') : t('settings.agent.dialog.saveChanges')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
