import { Toast } from "@base-ui/react/toast";

// Single app-wide toast manager. `showToast(...)` works from anywhere (event
// handlers, plain functions) because the manager is a module singleton wired to
// the Provider in Toast.jsx. Replaces the hand-rolled toast div with the
// @base-ui headless Toast primitive (timeout, swipe-to-dismiss, enter/exit
// handled for us).
export const toastManager = Toast.createToastManager();

export function showToast(options) {
  return toastManager.add(options);
}
