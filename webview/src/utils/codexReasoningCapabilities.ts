/** Native catalog state shared by the picker and synchronous submission guards. */
interface CodexReasoningCapabilities {
  pending: boolean;
  effortsByModel: ReadonlyMap<string, readonly string[]>;
}

let snapshot: CodexReasoningCapabilities = { pending: true, effortsByModel: new Map() };
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
  replaceSnapshot({ pending, effortsByModel: new Map(models.flatMap(model =>
    model.supportedReasoningEfforts ? [[model.id, [...model.supportedReasoningEfforts]] as const] : [])) });
}

/** Refreshes can retain confirmed capabilities; provider changes must clear them. */
export function setCodexReasoningCapabilitiesPending(pending: boolean): void {
  if (snapshot.pending !== pending) replaceSnapshot({ ...snapshot, pending });
}

export function codexModelReasoningEfforts(modelId: string): readonly string[] | undefined {
  return snapshot.effortsByModel.get(modelId);
}

export function isCodexUltraCapabilityPending(modelId: string, effort: string): boolean {
  return effort === 'ultra' && snapshot.pending && !codexModelReasoningEfforts(modelId)?.includes('ultra');
}
