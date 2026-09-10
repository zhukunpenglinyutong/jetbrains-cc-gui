import { useState, useRef, useEffect } from "react";

// 1. 视角状态 (yaw, pitch)
// 经典 Isometric 投影角度：yaw = -45度 (-0.785), pitch = 35.26度 (0.615)
export const DEFAULT_YAW = -0.20;
export const DEFAULT_PITCH = 0.88;

export function useHeatmap3dView({ interactive, autoRotateInit, onResetViewRef }) {
  const [angle, setAngle] = useState({ yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH });
  const [autoRotate, setAutoRotate] = useState(autoRotateInit);
  const [zoom, setZoom] = useState(1.0);

  // 双向绑定重置视角句柄
  useEffect(() => {
    if (onResetViewRef) {
      onResetViewRef.current = {
        reset: () => {
          setAngle({ yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH });
          setAutoRotate(false);
          setZoom(1.0);
          // 触发波浪生长入场动画
          triggerGrowthWave();
        },
        toggleAutoRotate: (val) => {
          setAutoRotate(val);
        }
      };
    }
  }, [onResetViewRef]);

  // 2. 交互与物理惯性 refs
  const svgRef = useRef(null);
  const containerRef = useRef(null);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const angleStartRef = useRef({ yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH });
  const velocityRef = useRef({ x: 0, y: 0 });
  const lastMousePosRef = useRef({ x: 0, y: 0, time: 0 });
  const rafRef = useRef(null);

  // 3. Voxel 高度波浪生长动画
  const [growthWave, setGrowthWave] = useState(0); // 范围 0 到 1
  // RAF handles tracked in refs so we can cancel on unmount / re-trigger.
  // Without these, rapid `interactive` toggles overlapped multiple RAF chains
  // all racing into setGrowthWave, and unmount could fire setState on a dead
  // component.
  const growthRafRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const triggerGrowthWave = () => {
    if (growthRafRef.current) cancelAnimationFrame(growthRafRef.current);
    setGrowthWave(0);
    const start = performance.now();
    const duration = 1200; // 1.2s 生长动画
    const anim = (now) => {
      if (!mountedRef.current) return;
      const elapsed = now - start;
      const progress = Math.min(1, elapsed / duration);
      const ease = 1 - Math.pow(1 - progress, 3);
      setGrowthWave(ease);
      if (progress < 1) {
        growthRafRef.current = requestAnimationFrame(anim);
      } else {
        growthRafRef.current = null;
      }
    };
    growthRafRef.current = requestAnimationFrame(anim);
  };

  useEffect(() => {
    // 首次加载或在 interactive 改变时触发一次生长动画
    triggerGrowthWave();
    return () => {
      if (growthRafRef.current) cancelAnimationFrame(growthRafRef.current);
    };
  }, [interactive]);

  // 4. 自动旋转定时器 — pauses when tab is hidden or user prefers reduced
  // motion, so a backgrounded dashboard doesn't burn CPU re-rendering 365
  // voxels at 60fps.
  useEffect(() => {
    if (!autoRotate || isDraggingRef.current) return;
    if (typeof window === "undefined") return;
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) return;
    let animRaf;
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        animRaf = requestAnimationFrame(tick);
        return;
      }
      setAngle((prev) => ({
        yaw: prev.yaw + 0.002,
        pitch: prev.pitch,
      }));
      animRaf = requestAnimationFrame(tick);
    };
    animRaf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRaf);
  }, [autoRotate]);

  // 5. 拖拽事件监听器
  const handleStart = (clientX, clientY) => {
    if (!interactive) return;
    isDraggingRef.current = true;
    dragStartRef.current = { x: clientX, y: clientY };
    angleStartRef.current = { yaw: angle.yaw, pitch: angle.pitch };
    velocityRef.current = { x: 0, y: 0 };
    lastMousePosRef.current = { x: clientX, y: clientY, time: performance.now() };
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  };

  const handleMove = (clientX, clientY) => {
    if (!isDraggingRef.current) return;
    const dx = clientX - dragStartRef.current.x;
    const dy = clientY - dragStartRef.current.y;

    const now = performance.now();
    const dt = now - lastMousePosRef.current.time;
    if (dt > 0) {
      // 计算滑动速度，为物理阻尼提供初速度
      velocityRef.current = {
        x: (clientX - lastMousePosRef.current.x) / dt,
        y: (clientY - lastMousePosRef.current.y) / dt,
      };
    }
    lastMousePosRef.current = { x: clientX, y: clientY, time: now };

    // 拖动灵敏度：水平拖动改变 yaw，垂直拖动改变 pitch（取负以实现直观的“抓取”推拉方向）
    const sensitivity = 0.005;
    const newYaw = angleStartRef.current.yaw - dx * sensitivity;
    // 限制 pitch 角度范围，避免翻转穿帮
    const maxPitch = Math.PI / 2.3;
    const newPitch = Math.max(-maxPitch, Math.min(maxPitch, angleStartRef.current.pitch - dy * sensitivity));

    setAngle({ yaw: newYaw, pitch: newPitch });
  };

  const handleEnd = () => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;

    // 开启带阻尼的惯性旋转
    let speedX = -velocityRef.current.x * 12; // 加上负号，与手势拖动方向一致
    let speedY = -velocityRef.current.y * 12;

    const friction = 0.95; // 阻尼系数
    const inertiaTick = () => {
      if (isDraggingRef.current) return;
      speedX *= friction;
      speedY *= friction;

      if (Math.abs(speedX) < 0.01 && Math.abs(speedY) < 0.01) {
        return; // 停止
      }

      setAngle((prev) => {
        const nextYaw = prev.yaw + speedX * 0.005;
        const maxPitch = Math.PI / 2.3;
        const nextPitch = Math.max(-maxPitch, Math.min(maxPitch, prev.pitch + speedY * 0.005));
        return { yaw: nextYaw, pitch: nextPitch };
      });

      rafRef.current = requestAnimationFrame(inertiaTick);
    };
    rafRef.current = requestAnimationFrame(inertiaTick);
  };

  // 6. Hover 数据与精致 Tooltip 状态
  const [hoveredCell, setHoveredCell] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0, shiftX: 0 });
  const hideTimeoutRef = useRef(null);
  // window 级拖拽监听器的摘除函数（mouseup 与卸载 cleanup 共用）
  const dragListenersCleanupRef = useRef(null);

  // 卸载时回收防抖定时器与拖拽监听器
  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      if (dragListenersCleanupRef.current) dragListenersCleanupRef.current();
    };
  }, []);

  // 监听鼠标滚轮/触控板双指缩放手势，完全支持 Mac trackpad 双指 pinch-to-zoom
  useEffect(() => {
    if (!interactive || !containerRef.current) return;

    const handleWheel = (e) => {
      // 阻止默认页面滚动行为，仅缩放 3D 热力图
      e.preventDefault();

      // 适配 Mac 触控板，双指捏合缩放时的 deltaY 绝对值较小，普通鼠标滚轮 deltaY 较大
      // deltaY < 0 向上滚动 -> 放大 (Zoom In)
      // deltaY > 0 向下滚动 -> 缩小 (Zoom Out)
      const delta = -e.deltaY * 0.0025;

      setZoom((prev) => {
        const nextZoom = prev + delta;
        // 限制缩放比例在 0.5 到 3.0 倍之间，避免缩放过小或过大溢出
        return Math.max(0.5, Math.min(3.0, nextZoom));
      });
    };

    const container = containerRef.current;
    // 使用 passive: false 允许 preventDefault 阻止页面滚动
    container.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, [interactive]);

  // Tooltip 显隐防抖
  const cancelHide = () => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  };

  const scheduleHide = () => {
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => {
      setHoveredCell(null);
    }, 150);
  };

  // 容器级鼠标/触控手势处理器
  const handleMouseDown = (e) => {
    if (!interactive) return;
    handleStart(e.clientX, e.clientY);
    // 绑定 window 级别的拖拽以支持移出 SVG 拖拽
    if (dragListenersCleanupRef.current) dragListenersCleanupRef.current();
    const moveHandler = (me) => handleMove(me.clientX, me.clientY);
    const removeDragListeners = () => {
      window.removeEventListener("mousemove", moveHandler);
      window.removeEventListener("mouseup", upHandler);
      dragListenersCleanupRef.current = null;
    };
    const upHandler = () => {
      handleEnd();
      removeDragListeners();
    };
    dragListenersCleanupRef.current = removeDragListeners;
    window.addEventListener("mousemove", moveHandler);
    window.addEventListener("mouseup", upHandler);
  };

  const handleTouchStart = (e) => {
    if (!interactive || e.touches.length === 0) return;
    handleStart(e.touches[0].clientX, e.touches[0].clientY);
  };

  const handleTouchMove = (e) => {
    if (!interactive || e.touches.length === 0) return;
    handleMove(e.touches[0].clientX, e.touches[0].clientY);
  };

  const handleTouchEnd = () => {
    if (!interactive) return;
    handleEnd();
  };

  return {
    angle,
    zoom,
    growthWave,
    svgRef,
    containerRef,
    hoveredCell,
    tooltipPos,
    setHoveredCell,
    setTooltipPos,
    cancelHide,
    scheduleHide,
    handleMouseDown,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  };
}
