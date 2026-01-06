import { useEffect, useState, useRef } from 'react';
import styles from './style.module.less';

interface AnimatedTextProps {
  text: string;
}

export const AnimatedText = ({ text }: AnimatedTextProps) => {
  const [displayContent, setDisplayContent] = useState(text);
  const [mode, setMode] = useState<'visible' | 'hidden'>('visible');
  const [animDirection, setAnimDirection] = useState<'in' | 'out'>('in');
  
  // Ref to track if it's the first render to avoid initial animation
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    if (text !== displayContent) {
      // Step 1: Animate out current text (Right to Left)
      setAnimDirection('out');
      setMode('hidden');

      const step = 8; // ms per char
      const duration = 35; // transition duration
      // Calculate max delay + duration
      const exitTime = displayContent.length * step + duration;

      const timer = setTimeout(() => {
        // Step 2: Swap content and animate in (Left to Right)
        setDisplayContent(text);
        setAnimDirection('in');
        setMode('visible');
      }, exitTime);

      return () => clearTimeout(timer);
    }
  }, [text, displayContent]);

  const chars = displayContent.split('');

  return (
    <div className={styles.container}>
      {chars.map((char, i) => {
        let delay = 0;
        const step = 10;

        if (animDirection === 'out') {
          // Disappear from Right to Left
          // Last char (N-1) disappears first (delay 0)
          // First char (0) disappears last
          delay = (chars.length - 1 - i) * step;
        } else {
          // Appear from Left to Right
          // First char (0) appears first (delay 0)
          delay = i * step;
        }

        return (
          <span
            key={i}
            className={`${styles.char} ${mode === 'visible' ? styles.visible : styles.hidden}`}
            style={{ transitionDelay: `${delay}ms` }}
          >
            {char}
          </span>
        );
      })}
    </div>
  );
};
