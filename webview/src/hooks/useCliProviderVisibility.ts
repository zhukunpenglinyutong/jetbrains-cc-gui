import { useEffect, useState } from 'react';
import {
  getHiddenCliProviderIds,
  subscribeCliProviderVisibility,
} from '../utils/cliProviderVisibility';

const readHiddenIds = (): ReadonlySet<string> => new Set(getHiddenCliProviderIds());

/**
 * Live set of CLI provider ids the user hid from the provider switcher
 * (toggled in Settings → Providers → CLI). Updates on same-tab and
 * cross-tab changes.
 */
export function useHiddenCliProviders(): ReadonlySet<string> {
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(readHiddenIds);

  useEffect(
    () => subscribeCliProviderVisibility(() => setHiddenIds(readHiddenIds())),
    [],
  );

  return hiddenIds;
}
