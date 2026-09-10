import { useEffect, useRef, useState } from "react";

// 3D 弹窗与控制状态：open/close-with-exit-animation lifecycle, Escape key
// handling, auto-rotate + reset-view handles, and the active color palette.
export function useHeatmapModal() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [modalAutoRotate, setModalAutoRotate] = useState(false);
  const resetViewRef = useRef(null);
  const [activePalette, setActivePalette] = useState("emerald");

  const handleOpenModal = () => {
    setIsClosing(false);
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsClosing(true);
  };

  const handleAnimationEnd = (e) => {
    // 仅响应最外层 Backdrop div 自身的退场动画结束事件，进行 DOM 卸载与状态清理
    if (e.target === e.currentTarget && isClosing) {
      setIsModalOpen(false);
      setIsClosing(false);
    }
  };

  // 监听全局键盘事件，按 Escape 键优雅退场
  useEffect(() => {
    if (!isModalOpen || isClosing) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        handleCloseModal();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isModalOpen, isClosing]);

  return {
    isModalOpen,
    isClosing,
    modalAutoRotate,
    setModalAutoRotate,
    resetViewRef,
    activePalette,
    setActivePalette,
    handleOpenModal,
    handleCloseModal,
    handleAnimationEnd,
  };
}
