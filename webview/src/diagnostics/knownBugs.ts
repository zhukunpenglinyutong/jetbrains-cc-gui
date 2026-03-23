/**
 * F-007: Known bug type definition.
 * Bug list is loaded dynamically from TRACKER.md via Java (DiagnosticHandler).
 */

export interface KnownBug {
  id: string;
  label: string;
  status?: 'open' | 'testing';
  statusChangedOn?: string; // ISO date: YYYY-MM-DD
}
