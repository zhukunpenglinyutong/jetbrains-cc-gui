import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { MessageListHandle } from './MessageList';

interface ScrollControlProps {
  containerRef: React.RefObject<HTMLElement | null>;
  inputAreaRef?: React.RefObject<HTMLDivElement | null>;
  // Virtuoso 滚动方法（用于虚拟列表的精确滚动）
  messageListRef?: React.RefObject<MessageListHandle | null>;
}

/**
 * ScrollControl - 滚动控制按钮组件
 * 功能：
 * - 鼠标向上滚动时显示 ↑，点击回到顶部
 * - 鼠标向下滚动时显示 ↓，点击回到底部
 * - 在底部时隐藏按钮
 * - 内容不足一屏时隐藏按钮
 * - 位置始终在输入框上方20px
 */
export const ScrollControl = ({ containerRef, inputAreaRef, messageListRef }: ScrollControlProps) => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [direction, setDirection] = useState<'up' | 'down'>('down');
  const [bottomOffset, setBottomOffset] = useState(120);
  const hideTimerRef = useRef<number | null>(null);
  // 追踪容器是否已挂载
  const [containerMounted, setContainerMounted] = useState(false);

  const THRESHOLD = 100; // 距离底部的阈值（像素）
  const HIDE_DELAY = 1500; // 停止滚动后隐藏的延迟时间（毫秒）

  // 检测容器挂载状态（使用 MutationObserver 替代轮询）
  useEffect(() => {
    // 立即检查
    if (containerRef.current) {
      setContainerMounted(true);
      return;
    }

    // 使用 MutationObserver 监听 DOM 变化
    const observer = new MutationObserver(() => {
      if (containerRef.current && !containerMounted) {
        setContainerMounted(true);
        observer.disconnect();
      }
    });

    // 观察 document.body 的子节点变化
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
    };
  }, [containerRef, containerMounted]);

  /**
   * 更新按钮位置，使其始终在输入框上方20px
   */
  const updatePosition = useCallback(() => {
    if (inputAreaRef?.current) {
      const inputRect = inputAreaRef.current.getBoundingClientRect();
      const windowHeight = window.innerHeight;
      const newBottom = windowHeight - inputRect.top + 20;
      setBottomOffset(newBottom);
    }
  }, [inputAreaRef]);

  /**
   * 检查滚动位置并更新按钮状态
   */
  const checkScrollPosition = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;

    // 内容不足一屏，隐藏按钮
    if (scrollHeight <= clientHeight) {
      setVisible(false);
      return;
    }

    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    // 在底部（距离底部 < THRESHOLD），隐藏按钮
    if (distanceFromBottom < THRESHOLD) {
      setVisible(false);
    }
  }, [containerRef]);

  /**
   * 处理鼠标滚轮事件
   */
  const handleWheel = useCallback((e: WheelEvent) => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;

    // 内容不足一屏，不显示
    if (scrollHeight <= clientHeight) {
      return;
    }

    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    // 在底部时不显示
    if (distanceFromBottom < THRESHOLD) {
      setVisible(false);
      return;
    }

    // 清除之前的隐藏定时器
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
    }

    // 根据滚轮方向设置箭头方向
    // deltaY > 0 表示向下滚动（内容向上移动），显示 ↓
    // deltaY < 0 表示向上滚动（内容向下移动），显示 ↑
    if (e.deltaY > 0) {
      setDirection('down');
    } else if (e.deltaY < 0) {
      setDirection('up');
    }

    setVisible(true);

    // 设置隐藏定时器
    hideTimerRef.current = setTimeout(() => {
      setVisible(false);
    }, HIDE_DELAY);
  }, [containerRef]);

  /**
   * 滚动到顶部
   */
  const scrollToTop = useCallback(() => {
    // 优先使用 Virtuoso API
    if (messageListRef?.current) {
      messageListRef.current.scrollToIndex(0);
      return;
    }
    // 回退到原生滚动
    const container = containerRef.current;
    if (!container) return;
    container.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  }, [containerRef, messageListRef]);

  /**
   * 滚动到底部
   */
  const scrollToBottom = useCallback(() => {
    // 优先使用 Virtuoso API
    if (messageListRef?.current) {
      messageListRef.current.scrollToBottom();
      return;
    }
    // 回退到原生滚动
    const container = containerRef.current;
    if (!container) return;
    container.scrollTo({
      top: container.scrollHeight,
      behavior: 'smooth',
    });
  }, [containerRef, messageListRef]);

  /**
   * 处理点击事件
   */
  const handleClick = useCallback(() => {
    if (direction === 'up') {
      scrollToTop();
    } else {
      scrollToBottom();
    }
    // 点击后隐藏按钮
    setVisible(false);
  }, [direction, scrollToTop, scrollToBottom]);

  /**
   * 监听滚动和滚轮事件
   */
  useEffect(() => {
    // 等待容器挂载
    if (!containerMounted) return;

    const container = containerRef.current;
    if (!container) return;

    // 初始检查
    checkScrollPosition();
    updatePosition();

    // 添加滚动监听（用于检测是否到达底部）
    container.addEventListener('scroll', checkScrollPosition);

    // 添加滚轮监听（用于检测滚动方向）
    container.addEventListener('wheel', handleWheel, { passive: true });

    // 监听窗口大小变化
    const handleResize = () => {
      checkScrollPosition();
      updatePosition();
    };
    window.addEventListener('resize', handleResize);

    // 使用 ResizeObserver 监听输入框大小变化
    let resizeObserver: ResizeObserver | null = null;
    if (inputAreaRef?.current) {
      resizeObserver = new ResizeObserver(updatePosition);
      resizeObserver.observe(inputAreaRef.current);
    }

    return () => {
      container.removeEventListener('scroll', checkScrollPosition);
      container.removeEventListener('wheel', handleWheel);
      window.removeEventListener('resize', handleResize);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
    };
  }, [containerMounted, containerRef, inputAreaRef, checkScrollPosition, handleWheel, updatePosition]);

  if (!visible) return null;

  return (
    <button
      className="scroll-control-button"
      style={{ bottom: `${bottomOffset}px` }}
      onClick={handleClick}
      aria-label={direction === 'up' ? t('chat.backToTop') : t('chat.backToBottom')}
      title={direction === 'up' ? t('chat.backToTop') : t('chat.backToBottom')}
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ transform: direction === 'up' ? 'rotate(180deg)' : 'none' }}
      >
        <path d="M12 5v14M19 12l-7 7-7-7" />
      </svg>
    </button>
  );
};
