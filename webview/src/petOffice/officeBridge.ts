export type OfficeCommand = 'ready' | 'hide' | 'exit' | 'metrics' | 'sceneAck' | 'resync' | 'navigate' | 'asset' | 'setTopmost' | 'storage';

declare global {
  interface Window {
    __PET_OFFICE_BOOTSTRAP__?: { pageGeneration: string; language: string; mode?: 'live' | 'prototype'; protocolVersion?: number; alwaysOnTop?: boolean; sharedPreferences?: unknown; preferencesRecovered?: boolean };
    petOfficeStorageResult?: (packet: unknown) => void;
    petOfficePreferencesChanged?: (state: unknown) => void;
    petOfficeSetTopmost?: (topmost: boolean) => void;
    petOfficeNativeBridge?: (message: string) => void;
    petOfficeSetVisible?: (visible: boolean) => void;
    petOfficeReceive?: (packet: unknown) => void;
    petOfficeDiagnostics?: () => Record<string, number | string | boolean>;
  }
}

export function sendOfficeRequest(command: OfficeCommand, fields: Record<string, unknown> = {}): void {
  window.petOfficeNativeBridge?.(JSON.stringify({ command, pageGeneration: window.__PET_OFFICE_BOOTSTRAP__?.pageGeneration, ...fields }));
}

export function sendOfficeCommand(command: 'ready' | 'hide' | 'exit' | 'metrics', metrics?: Record<string, number | string | boolean>): void {
  sendOfficeRequest(command, command === 'metrics' ? { metrics } : command === 'ready' ? { protocolVersion: 1 } : {});
}
