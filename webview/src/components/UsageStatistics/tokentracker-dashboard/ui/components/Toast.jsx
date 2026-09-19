import React from "react";
import { Toast } from "@base-ui/react/toast";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";
import { copy } from "../../lib/copy";
import { toastManager } from "./toastManager.js";

export function ToastProvider({ children }) {
  return (
    <Toast.Provider toastManager={toastManager}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="fixed inset-x-0 top-6 z-[100] mx-auto flex w-full max-w-sm flex-col items-center gap-2 px-4 outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => {
    const onUndo = toast.data?.onUndo;
    return (
      <Toast.Root
        key={toast.id}
        toast={toast}
        className={cn(
          "pointer-events-auto flex w-full items-center gap-3 rounded-xl border border-oai-gray-200 bg-oai-white px-4 py-3 shadow-xl transition-[transform,opacity] duration-200 ease-out",
          "data-[starting-style]:-translate-y-3 data-[starting-style]:opacity-0",
          "data-[ending-style]:-translate-y-3 data-[ending-style]:opacity-0",
          "dark:border-oai-gray-800 dark:bg-oai-gray-900",
        )}
      >
        <Toast.Title className="min-w-0 flex-1 text-sm font-medium text-oai-black dark:text-white" />
        {onUndo ? (
          <button
            type="button"
            onClick={() => {
              onUndo();
              toastManager.close(toast.id);
            }}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-oai-gray-600 transition-colors hover:bg-oai-gray-100 hover:text-oai-black focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800 dark:hover:text-white"
          >
            {copy("shared.action.undo")}
          </button>
        ) : null}
        <Toast.Close
          aria-label={copy("shared.action.dismiss")}
          className="-mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-oai-gray-400 transition-colors hover:bg-oai-gray-100 hover:text-oai-black focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 dark:hover:bg-oai-gray-800 dark:hover:text-white"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </Toast.Close>
      </Toast.Root>
    );
  });
}
