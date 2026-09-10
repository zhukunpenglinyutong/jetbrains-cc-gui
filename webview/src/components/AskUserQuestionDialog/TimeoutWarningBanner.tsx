import { useTranslation } from 'react-i18next';

interface TimeoutWarningBannerProps {
  remainingSeconds: number;
}

const TimeoutWarningBanner = ({ remainingSeconds }: TimeoutWarningBannerProps) => {
  const { t } = useTranslation();

  return (
    <div className="timeout-warning-banner">
      <span className="codicon codicon-warning" />
      <span>{t('askUserQuestion.timeoutWarning', '请尽快回答，对话框将在 {{seconds}} 秒后自动关闭', { seconds: remainingSeconds })}</span>
    </div>
  );
};

export default TimeoutWarningBanner;
