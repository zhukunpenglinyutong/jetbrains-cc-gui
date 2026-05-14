import { useEffect, useRef, useState } from 'react';
import { resolveFilePathWithCallback } from '../utils/bridge';

/**
 * Hook to asynchronously resolve a file path to its full relative path.
 * Multiple components asking for the same path share a single backend request.
 */
export function useResolvedFilePath(filePath: string | undefined): string | undefined {
  const [resolvedPath, setResolvedPath] = useState<string | undefined>(undefined);
  const lastRequestedPathRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!filePath) {
      lastRequestedPathRef.current = undefined;
      setResolvedPath(undefined);
      return;
    }

    // Avoid re-requesting if the path hasn't changed
    if (lastRequestedPathRef.current === filePath) {
      return;
    }
    lastRequestedPathRef.current = filePath;
    setResolvedPath(undefined);

    // Guard against setState after unmount: JCEF bridge can deliver the
    // resolved path arbitrarily late (or never), and the host frame may
    // unmount the component (tool block re-render, message removal) while
    // the callback is still pending in resolveFilePathCallbacks.
    let cancelled = false;

    resolveFilePathWithCallback(filePath, (result) => {
      if (cancelled) return;
      setResolvedPath(result ?? undefined);
    });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return resolvedPath;
}
