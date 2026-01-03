import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './AskUserQuestionDialog.css';

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
  onSubmit: (requestId: string, answers: Record<string, string>) => void;
  onCancel: (requestId: string) => void;
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
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);

  useEffect(() => {
    if (isOpen && request) {
      // 初始化答案状态
      const initialAnswers: Record<string, Set<string>> = {};
      request.questions.forEach((q) => {
        initialAnswers[q.question] = new Set<string>();
      });
      setAnswers(initialAnswers);
      setCurrentQuestionIndex(0);

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          handleCancel();
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, request]);

  if (!isOpen || !request) {
    return null;
  }

  const currentQuestion = request.questions[currentQuestionIndex];
  const isLastQuestion = currentQuestionIndex === request.questions.length - 1;
  const currentAnswerSet = answers[currentQuestion.question] || new Set<string>();

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
  };

  const handleNext = () => {
    if (isLastQuestion) {
      handleSubmitFinal();
    } else {
      setCurrentQuestionIndex((prev) => prev + 1);
    }
  };

  const handleBack = () => {
    if (currentQuestionIndex > 0) {
      setCurrentQuestionIndex((prev) => prev - 1);
    }
  };

  const handleSubmitFinal = () => {
    // 将 Set 转换为逗号分隔的字符串（多选）或单个字符串（单选）
    const formattedAnswers: Record<string, string> = {};
    request.questions.forEach((q) => {
      const selectedSet = answers[q.question] || new Set<string>();
      if (selectedSet.size > 0) {
        formattedAnswers[q.question] = Array.from(selectedSet).join(', ');
      } else {
        formattedAnswers[q.question] = '';
      }
    });

    onSubmit(request.requestId, formattedAnswers);
  };

  const handleCancel = () => {
    onCancel(request.requestId);
  };

  const canProceed = currentAnswerSet.size > 0;

  return (
    <div className="permission-dialog-overlay">
      <div className="ask-user-question-dialog">
        {/* 标题区域 */}
        <h3 className="ask-user-question-dialog-title">
          {t('askUserQuestion.title', 'Claude 有一些问题想问你')}
        </h3>
        <div className="ask-user-question-dialog-progress">
          {t('askUserQuestion.progress', '问题 {{current}} / {{total}}', {
            current: currentQuestionIndex + 1,
            total: request.questions.length,
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
          </div>

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
            {currentQuestionIndex > 0 && (
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
