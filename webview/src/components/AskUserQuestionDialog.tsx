import { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import './AskUserQuestionDialog.css';

// 用于标识"其他"选项的特殊标记
const OTHER_OPTION_MARKER = '__OTHER__';

// 自定义输入的最大长度限制
const MAX_CUSTOM_INPUT_LENGTH = 2000;

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface AskUserQuestionRequest {
  requestId: string;
  toolName: string;
  questions: Question[];
}

interface AskUserQuestionDialogProps {
  isOpen: boolean;
  request: AskUserQuestionRequest | null;
  onSubmit: (requestId: string, answers: Record<string, string | string[]>) => void;
  onCancel: (requestId: string) => void;
}

function normalizeQuestion(raw: any): Question | null {
  if (!raw || typeof raw !== 'object') return null;
  const questionText = typeof raw.question === 'string' ? raw.question : (typeof raw.text === 'string' ? raw.text : '');
  const header = typeof raw.header === 'string' ? raw.header : '';
  const multiSelect = typeof raw.multiSelect === 'boolean' ? raw.multiSelect : false;
  const rawOptions = Array.isArray(raw.options) ? raw.options : (Array.isArray(raw.choices) ? raw.choices : []);
  const options: QuestionOption[] = rawOptions
    .map((opt: any): QuestionOption | null => {
      if (typeof opt === 'string') return { label: opt, description: '' };
      if (!opt || typeof opt !== 'object') return null;
      const label = typeof opt.label === 'string' ? opt.label : (typeof opt.value === 'string' ? opt.value : '');
      const description = typeof opt.description === 'string' ? opt.description : '';
      if (!label) return null;
      return { label, description };
    })
    .filter(Boolean) as QuestionOption[];
  if (!questionText) return null;
  return { question: questionText, header, options, multiSelect };
}

const AskUserQuestionDialog = ({
  isOpen,
  request,
  onSubmit,
  onCancel,
}: AskUserQuestionDialogProps) => {
  const { t } = useTranslation();
  // 存储每个问题的答案：question -> selectedLabel(s)
  const [answers, setAnswers] = useState<Record<string, Set<string>>>({});
  // 存储每个问题的自定义输入文本：question -> customText
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const customInputRef = useRef<HTMLTextAreaElement>(null);
  const normalizedQuestions = (Array.isArray(request?.questions) ? request!.questions : [])
    .map(normalizeQuestion)
    .filter(Boolean) as Question[];

  useEffect(() => {
    if (isOpen && request) {
      // 初始化答案状态
      const initialAnswers: Record<string, Set<string>> = {};
      const initialCustomInputs: Record<string, string> = {};
      normalizedQuestions.forEach((q) => {
        initialAnswers[q.question] = new Set<string>();
        initialCustomInputs[q.question] = '';
      });
      setAnswers(initialAnswers);
      setCustomInputs(initialCustomInputs);
      setCurrentQuestionIndex(0);

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          handleCancel();
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen]); // Remove 'request' from dependencies to prevent re-registering listeners

  if (!isOpen || !request) {
    return null;
  }

  if (normalizedQuestions.length === 0) {
    return (
      <div className="permission-dialog-overlay">
        <div className="ask-user-question-dialog">
          <h3 className="ask-user-question-dialog-title">
            {t('askUserQuestion.title', 'Claude 有一些问题想问你')}
          </h3>
          <p className="question-text">
            {t('askUserQuestion.invalidFormat', '问题数据格式不支持，请取消后重试。')}
          </p>
          <div className="ask-user-question-dialog-actions">
            <button className="action-button secondary" onClick={() => onCancel(request.requestId)}>
              {t('askUserQuestion.cancel', '取消')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // FIX: 确保 currentQuestionIndex 不会越界
  // 当 request 变化导致 normalizedQuestions 长度减少时，
  // currentQuestionIndex 可能仍是旧值（因为 useEffect 的 state 更新是异步的）
  const safeQuestionIndex = Math.max(0, Math.min(currentQuestionIndex, normalizedQuestions.length - 1));
  const currentQuestion = normalizedQuestions[safeQuestionIndex];

  // FIX: 额外的防御性检查，防止在极端边界情况下 currentQuestion 为 undefined
  // 这可能发生在 React 并发渲染或状态更新时序问题时
  if (!currentQuestion) {
    return (
      <div className="permission-dialog-overlay">
        <div className="ask-user-question-dialog">
          <h3 className="ask-user-question-dialog-title">
            {t('askUserQuestion.title', 'Claude 有一些问题想问你')}
          </h3>
          <p className="question-text">
            {t('askUserQuestion.loading', '正在加载问题...')}
          </p>
          <div className="ask-user-question-dialog-actions">
            <button className="action-button secondary" onClick={() => onCancel(request.requestId)}>
              {t('askUserQuestion.cancel', '取消')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isLastQuestion = safeQuestionIndex === normalizedQuestions.length - 1;
  const currentAnswerSet = answers[currentQuestion.question] || new Set<string>();
  const currentCustomInput = customInputs[currentQuestion.question] || '';
  const isOtherSelected = currentAnswerSet.has(OTHER_OPTION_MARKER);

  const handleOptionToggle = (label: string) => {
    setAnswers((prev) => {
      const newAnswers = { ...prev };
      const currentSet = new Set(newAnswers[currentQuestion.question] || []);

      if (currentQuestion.multiSelect) {
        // 多选模式：切换选项
        if (currentSet.has(label)) {
          currentSet.delete(label);
        } else {
          currentSet.add(label);
        }
      } else {
        // 单选模式：清空后设置新选项
        currentSet.clear();
        currentSet.add(label);
      }

      newAnswers[currentQuestion.question] = currentSet;
      return newAnswers;
    });

    // 如果选中"其他"选项，自动聚焦到输入框
    if (label === OTHER_OPTION_MARKER) {
      setTimeout(() => {
        customInputRef.current?.focus();
      }, 0);
    }
  };

  const handleCustomInputChange = (value: string) => {
    // 限制输入长度以防止过长输入
    const sanitizedValue = value.slice(0, MAX_CUSTOM_INPUT_LENGTH);
    setCustomInputs((prev) => ({
      ...prev,
      [currentQuestion.question]: sanitizedValue,
    }));
  };

  const handleNext = () => {
    if (isLastQuestion) {
      handleSubmitFinal();
    } else {
      setCurrentQuestionIndex((prev) => prev + 1);
    }
  };

  const handleBack = () => {
    if (safeQuestionIndex > 0) {
      setCurrentQuestionIndex((prev) => Math.max(0, prev - 1));
    }
  };

  const handleSubmitFinal = () => {
    const formattedAnswers: Record<string, string | string[]> = {};
    normalizedQuestions.forEach((q) => {
      const selectedSet = answers[q.question] || new Set<string>();
      const customText = customInputs[q.question] || '';

      // 过滤掉"其他"标记，获取实际选中的选项
      const selectedLabels = Array.from(selectedSet).filter(label => label !== OTHER_OPTION_MARKER);

      // 如果选中了"其他"且有自定义输入，将自定义输入添加到答案中
      if (selectedSet.has(OTHER_OPTION_MARKER) && customText.trim()) {
        selectedLabels.push(customText.trim());
      }

      if (selectedLabels.length > 0) {
        formattedAnswers[q.question] = q.multiSelect ? selectedLabels : selectedLabels[0]!;
      }
    });

    onSubmit(request.requestId, formattedAnswers);
  };

  const handleCancel = () => {
    onCancel(request.requestId);
  };

  // 检查是否可以继续：
  // 1. 选中了普通选项（非"其他"）
  // 2. 或者选中了"其他"且有有效的自定义输入
  const hasRegularSelection = Array.from(currentAnswerSet).some(label => label !== OTHER_OPTION_MARKER);
  const hasValidCustomInput = isOtherSelected && currentCustomInput.trim().length > 0;
  const canProceed = hasRegularSelection || hasValidCustomInput;

  return (
    <div className="permission-dialog-overlay">
      <div className="ask-user-question-dialog">
        {/* 标题区域 */}
        <h3 className="ask-user-question-dialog-title">
          {t('askUserQuestion.title', 'Claude 有一些问题想问你')}
        </h3>
        <div className="ask-user-question-dialog-progress">
          {t('askUserQuestion.progress', '问题 {{current}} / {{total}}', {
            current: safeQuestionIndex + 1,
            total: normalizedQuestions.length,
          })}
        </div>

        {/* 问题区域 */}
        <div className="ask-user-question-dialog-question">
          <div className="question-header">
            <span className="question-tag">{currentQuestion.header}</span>
          </div>
          <p className="question-text">{currentQuestion.question}</p>

          {/* 选项列表 */}
          <div className="question-options">
            {currentQuestion.options.map((option, index) => {
              const isSelected = currentAnswerSet.has(option.label);
              return (
                <button
                  key={index}
                  className={`question-option ${isSelected ? 'selected' : ''}`}
                  onClick={() => handleOptionToggle(option.label)}
                >
                  <div className="option-checkbox">
                    {currentQuestion.multiSelect ? (
                      <span className={`codicon codicon-${isSelected ? 'check' : 'blank'}`} />
                    ) : (
                      <span className={`codicon codicon-${isSelected ? 'circle-filled' : 'circle-outline'}`} />
                    )}
                  </div>
                  <div className="option-content">
                    <div className="option-label">{option.label}</div>
                    <div className="option-description">{option.description}</div>
                  </div>
                </button>
              );
            })}

            {/* 其他选项 - 允许用户自定义输入 */}
            <button
              className={`question-option other-option ${isOtherSelected ? 'selected' : ''}`}
              onClick={() => handleOptionToggle(OTHER_OPTION_MARKER)}
            >
              <div className="option-checkbox">
                {currentQuestion.multiSelect ? (
                  <span className={`codicon codicon-${isOtherSelected ? 'check' : 'blank'}`} />
                ) : (
                  <span className={`codicon codicon-${isOtherSelected ? 'circle-filled' : 'circle-outline'}`} />
                )}
              </div>
              <div className="option-content">
                <div className="option-label">{t('askUserQuestion.otherOption', '其他')}</div>
                <div className="option-description">{t('askUserQuestion.otherOptionDesc', '输入自定义答案')}</div>
              </div>
            </button>
          </div>

          {/* 自定义输入框 - 仅当选中"其他"时显示 */}
          {isOtherSelected && (
            <div className="custom-input-container">
              <textarea
                ref={customInputRef}
                className="custom-input"
                value={currentCustomInput}
                onChange={(e) => handleCustomInputChange(e.target.value)}
                placeholder={t('askUserQuestion.customInputPlaceholder', '请输入您的答案...')}
                rows={3}
                maxLength={MAX_CUSTOM_INPUT_LENGTH}
              />
            </div>
          )}

          {/* 提示文本 */}
          {currentQuestion.multiSelect && (
            <p className="question-hint">
              {t('askUserQuestion.multiSelectHint', '可以选择多个选项')}
            </p>
          )}
        </div>

        {/* 按钮区域 */}
        <div className="ask-user-question-dialog-actions">
          <button
            className="action-button secondary"
            onClick={handleCancel}
          >
            {t('askUserQuestion.cancel', '取消')}
          </button>

          <div className="action-buttons-right">
            {safeQuestionIndex > 0 && (
              <button
                className="action-button secondary"
                onClick={handleBack}
              >
                {t('askUserQuestion.back', '上一步')}
              </button>
            )}

            <button
              className={`action-button primary ${!canProceed ? 'disabled' : ''}`}
              onClick={handleNext}
              disabled={!canProceed}
            >
              {isLastQuestion
                ? t('askUserQuestion.submit', '提交')
                : t('askUserQuestion.next', '下一步')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AskUserQuestionDialog;
