/**
 * Shared types for the DSH host connection card (Settings → CLI).
 */

export interface DshStatusPayload {
  success?: boolean;
  installed?: boolean;
  version?: string;
  bin?: string;
  origin?: string;
  hostRunning?: boolean;
  ownership?: 'spawned' | 'adopted';
  error?: string;
  describe?: {
    version?: string;
    provider?: string;
    model?: string;
    attachedSessions?: number;
  };
  settings?: {
    bin?: string;
    host?: string;
    port?: number;
    autoStart?: boolean;
  };
}

export type DshStateKey = 'checking' | 'notInstalled' | 'notRunning' | 'connected';
