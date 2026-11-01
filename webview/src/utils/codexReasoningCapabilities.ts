/** Native catalog state shared by the picker and synchronous submission guards. */
interface CodexReasoningCapabilities {
  status: 'loading' | 'ready' | 'unavailable';
  effortsByModel: ReadonlyMap<string, readonly string[]>;
}

let snapshot: CodexReasoningCapabilities = { status: 'loading', effortsByModel: new Map() };
const listeners = new Set<() => void>();

export const getCodexReasoningCapabilities = (): CodexReasoningCapabilities => snapshot;

export function subscribeCodexReasoningCapabilities(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function replaceSnapshot(next: CodexReasoningCapabilities): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function updateCodexReasoningCapabilities(
  models: ReadonlyArray<{ id: string; supportedReasoningEfforts?: readonly string[] }>,
  pending = false,
): void {
  replaceSnapshot({ status: pending ? 'loading' : 'ready', effortsByModel: new Map(models.flatMap(model =>
    model.supportedReasoningEfforts ? [[model.id, [...model.supportedReasoningEfforts]] as const] : [])) });
}

/** Refreshes can retain confirmed capabilities; provider changes must clear them. */
export function beginCodexReasoningCapabilitiesLoad(): void {
  if (snapshot.status !== 'loading') replaceSnapshot({ ...snapshot, status: 'loading' });
}

/** Failure is not evidence that a user's requested effort is unsupported. */
export function failCodexReasoningCapabilities(clearModels = false): void {
  replaceSnapshot({ status: 'unavailable', effortsByModel: clearModels ? new Map() : snapshot.effortsByModel });
}

export function codexModelReasoningEfforts(modelId: string): readonly string[] | undefined {
  return snapshot.effortsByModel.get(modelId);
}

export function isCodexUltraCapabilityUnconfirmed(modelId: string, effort: string): boolean {
  return effort === 'ultra' && snapshot.status !== 'ready' && !codexModelReasoningEfforts(modelId)?.includes('ultra');
}
