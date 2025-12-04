import { useState, useEffect } from 'react';

interface WaitingIndicatorProps {
  size?: number;
  /** 开始加载的时间戳（毫秒），用于在视图切换后保持计时连续 */
  startTime?: number;
}

export const WaitingIndicator = ({ size = 18, startTime }: WaitingIndicatorProps) => {
  const [dotCount, setDotCount] = useState(1);
  const [elapsedSeconds, setElapsedSeconds] = useState(() => {
    // 如果提供了开始时间，计算已经过去的秒数
    if (startTime) {
      return Math.floor((Date.now() - startTime) / 1000);
    }
    return 0;
  });

  // 省略号动画
  useEffect(() => {
    const timer = setInterval(() => {
      setDotCount(prev => (prev % 3) + 1);
    }, 500);
    return () => clearInterval(timer);
  }, []);

  // 计时器：记录当前思考轮次已经经过的秒数
  useEffect(() => {
    const timer = setInterval(() => {
      if (startTime) {
        // 使用外部传入的开始时间计算，避免视图切换后重置
        setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
      } else {
        setElapsedSeconds(prev => prev + 1);
      }
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [startTime]);

  const dots = '.'.repeat(dotCount);

  // 格式化时间显示：60秒以内显示"X秒"，超过60秒显示"X分Y秒"
  const formatElapsedTime = (seconds: number): string => {
    if (seconds < 60) {
      return `${seconds} 秒`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes} 分 ${remainingSeconds} 秒`;
  };

  return (
    <div className="waiting-indicator">
      <span className="waiting-spinner" style={{ width: size, height: size }} />
      <span className="waiting-text">
	        正在生成响应<span className="waiting-dots">{dots}</span>
	        <span className="waiting-seconds">（已用 {formatElapsedTime(elapsedSeconds)}）</span>
      </span>
    </div>
  );
};

export default WaitingIndicator;

