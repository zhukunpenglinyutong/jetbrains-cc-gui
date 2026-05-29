import { useCallback, useState } from 'react';
import { forceWebviewRepaint } from '../../../utils/forceWebviewRepaint.js';

const BANNER_DISMISSED_KEY = 'openSourceBannerDismissed';

export function useOpenSourceBannerState() {
  const [showOpenSourceBanner, setShowOpenSourceBanner] = useState(
    () => !window.localStorage.getItem(BANNER_DISMISSED_KEY)
  );

  const handleDismissOpenSourceBanner = useCallback(() => {
    window.localStorage.setItem(BANNER_DISMISSED_KEY, 'true');
    setShowOpenSourceBanner(false);
    // Removing the banner reflows the input header; clear any JCEF ghosting it leaves.
    forceWebviewRepaint('open-source-banner-dismiss');
  }, []);

  return {
    showOpenSourceBanner,
    handleDismissOpenSourceBanner,
  };
}
