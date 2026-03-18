import { useCallback, useState } from 'react';

const BANNER_DISMISSED_KEY = 'openSourceBannerDismissed';

export function useOpenSourceBannerState() {
  const [showOpenSourceBanner, setShowOpenSourceBanner] = useState(
    () => !window.localStorage.getItem(BANNER_DISMISSED_KEY)
  );

  const handleDismissOpenSourceBanner = useCallback(() => {
    window.localStorage.setItem(BANNER_DISMISSED_KEY, 'true');
    setShowOpenSourceBanner(false);
  }, []);

  return {
    showOpenSourceBanner,
    handleDismissOpenSourceBanner,
  };
}
