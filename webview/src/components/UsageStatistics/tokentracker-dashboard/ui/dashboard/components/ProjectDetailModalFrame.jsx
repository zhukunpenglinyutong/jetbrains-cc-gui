import React from "react";
import { X } from "lucide-react";
import { copy } from "../../../lib/copy";
import { cn } from "../../../lib/cn";

// Render inline (NOT createPortal to document.body) — see
// TrendMonitorZoomModal: body-portaled overlays don't present on-screen in
// the Windows WebView2 host's transparent composition.
export function ProjectDetailModalFrame({ projectKey, onClose, children }) {
  const [isClosing, setIsClosing] = React.useState(false);

  const handleClose = React.useCallback(() => setIsClosing(true), []);
  const handleAnimationEnd = (e) => {
    if (e.target === e.currentTarget && isClosing) onClose();
  };

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  return (
    <div
      onAnimationEnd={handleAnimationEnd}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 backdrop-blur-md bg-black/15 dark:bg-black/40",
        isClosing ? "animate-tt-fade-out" : "animate-tt-fade-in",
      )}
    >
      {/* animate-tt-* / tt-* keyframes live in styles.css (shared modal motion) */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={projectKey}
        className={cn(
          "relative w-full max-w-4xl max-h-[88vh] backdrop-blur-2xl bg-white/90 dark:bg-oai-gray-900/90 border border-oai-gray-200/50 dark:border-white/10 shadow-2xl rounded-2xl flex flex-col md:flex-row overflow-hidden",
          isClosing ? "animate-tt-modal-exit" : "animate-tt-modal",
        )}
      >
        <button
          type="button"
          onClick={handleClose}
          aria-label={copy("dashboard.projects.detail.close_aria")}
          className="absolute top-4 right-4 z-50 p-2 rounded-full border border-oai-gray-200/60 dark:border-oai-gray-800/60 bg-white/50 dark:bg-oai-gray-900/50 text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-900 dark:hover:text-white hover:rotate-90 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand/60 transition-all duration-300"
        >
          <X size={16} />
        </button>

        {children}
      </div>
    </div>
  );
}
