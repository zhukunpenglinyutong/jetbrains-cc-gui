import { useState, useEffect } from 'react';

interface WaitingIndicatorProps {
  size?: number;
}

export const WaitingIndicator = ({ size = 18 }: WaitingIndicatorProps) => {
  const [dotCount, setDotCount] = useState(1);

  // 省略号动画
  useEffect(() => {
    const timer = setInterval(() => {
      setDotCount(prev => (prev % 3) + 1);
    }, 500);
    return () => clearInterval(timer);
  }, []);

  const dots = '.'.repeat(dotCount);

  return (
    <div className="waiting-indicator">
      <span className="waiting-spinner" style={{ width: size, height: size }} />
      <span className="waiting-text">
        正在生成响应<span className="waiting-dots">{dots}</span>
      </span>
    </div>
  );
};

export default WaitingIndicator;

