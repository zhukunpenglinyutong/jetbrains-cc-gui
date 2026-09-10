import { useEffect } from 'react';

interface UseProviderListBridgeOptions {
  addToast: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  importMenuRef: React.RefObject<HTMLDivElement | null>;
  mountedRef: React.RefObject<boolean>;
  setImportMenuOpen: (open: boolean) => void;
  setIsImporting: (importing: boolean) => void;
  setImportPreviewData: (providers: unknown[]) => void;
  setShowImportDialog: (show: boolean) => void;
  setCliLoginAccountEmail: (email: string | null) => void;
}

/**
 * Registers the click-outside handler for the import menu and the global
 * window callbacks used by the Java backend (CLI login account info,
 * cc-switch import preview results and backend notifications).
 */
export function useProviderListBridge({
  addToast,
  importMenuRef,
  mountedRef,
  setImportMenuOpen,
  setIsImporting,
  setImportPreviewData,
  setShowImportDialog,
  setCliLoginAccountEmail,
}: UseProviderListBridgeOptions) {
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (importMenuRef.current && !importMenuRef.current.contains(event.target as Node)) {
        setImportMenuOpen(false);
      }
    };

    // Register CLI login account info callback
    window.updateCliLoginAccountInfo = (email: string) => {
      if (mountedRef.current) {
        setCliLoginAccountEmail(email);
      }
    };

    // Register global callback functions for Java invocation
    window.import_preview_result = (dataOrStr) => {
        let data: unknown = dataOrStr;
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (e) {
                console.error('Failed to parse import_preview_result data:', e);
            }
        }
        const event = new CustomEvent('import_preview_result', { detail: data });
        window.dispatchEvent(event);
    };

    window.backend_notification = (...args: unknown[]) => {
        let data: any = {};
        
        // Support multi-argument invocation (type, title, message) to avoid JSON parsing issues
        if (args.length >= 3 && typeof args[0] === 'string' && typeof args[2] === 'string') {
            data = {
                type: args[0],
                title: args[1],
                message: args[2]
            };
        } else if (args.length > 0) {
            // Backward compatible with legacy single-argument JSON format
            let dataOrStr = args[0];
            data = dataOrStr;
            if (typeof data === 'string') {
                try {
                    data = JSON.parse(data);
                } catch (e) {
                    console.error('Failed to parse backend_notification data:', e);
                }
            }
        }
        
        const event = new CustomEvent('backend_notification', { detail: data });
        window.dispatchEvent(event);
    };

    const handleImportPreview = (event: CustomEvent) => {
      setIsImporting(false); // Received result, hide loading
      const data = event.detail;
      if (data && data.providers) {
        setImportPreviewData(data.providers);
        setShowImportDialog(true);
      }
    };

    const handleBackendNotification = (event: CustomEvent) => {
      setIsImporting(false); // Received notification (possibly an error), hide loading
      const data = event.detail;
      if (data && data.message) {
        addToast(data.message, data.type || 'info');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('import_preview_result', handleImportPreview as EventListener);
    window.addEventListener('backend_notification', handleBackendNotification as EventListener);
    
    return () => {
      mountedRef.current = false;
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('import_preview_result', handleImportPreview as EventListener);
      window.removeEventListener('backend_notification', handleBackendNotification as EventListener);
      
      // Clean up global functions
      delete window.updateCliLoginAccountInfo;
      delete window.import_preview_result;
      delete window.backend_notification;
    };
    // Setters are stable; only addToast can change identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addToast]);
}
