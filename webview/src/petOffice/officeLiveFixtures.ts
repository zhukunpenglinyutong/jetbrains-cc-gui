import type { OfficePhase } from './officeModel';

/** Protocol fixture for automated verification, never imported by the live entry point. */
export function liveSceneFixture(phases: readonly OfficePhase[] = ['RUNNING', 'WAITING_USER', 'IDLE']) {
  const sources = phases.map((phase, index) => ({
    sourceKey: { instanceId: 'instance-A', contentHandleId: `tab-${index}`, bindingEpoch: `binding-${index}` }, sourceRevision: 1,
    metadata: { contentHandleId: `tab-${index}`, productCode: 'IC', productName: 'IDEA', projectId: 'project-A', projectLabel: 'Project A', tabLabel: `AI ${index + 1}` }, provider: index % 2 === 0 ? 'codex' : 'claude', modelLabel: 'test-model',
    execution: { bindingEpoch: `binding-${index}`, turnId: phase === 'IDLE' ? '' : `turn-${index}`, phase, waitReason: phase === 'WAITING_USER' ? 'QUESTION' : 'NONE', pendingInteractionId: phase === 'WAITING_USER' ? `interaction-${index}` : '', pendingInteractionCount: phase === 'WAITING_USER' ? 1 : 0,
      outcome: ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(phase) ? phase : 'NONE', terminalEventId: ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(phase) ? `event-${index}` : '', startedAt: 1000, completedAt: ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(phase) ? 2000 : 0, revision: 1 },
    routeStatus: 'AVAILABLE', routeGeneration: '11111111-1111-4111-8111-111111111111', observationRevision: 1, observationAgeMillis: 0, terminalGraceRemainingMillis: ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(phase) ? 5000 : 0,
  }));
  const appearances = Object.fromEntries(sources.map(source => [`instance-A/${source.metadata.contentHandleId}/${source.execution.bindingEpoch}`, {
    revision: 'a'.repeat(64), scope: 'project', opacity: 1,
    actionMappings: { idle: ['idle'], running: ['running'], thinking: ['review'], success: ['jumping'], error: ['failed'] }, status: 'BUILTIN',
    manifest: { digest: '', kind: 'builtin', mime: '', width: 192, height: 208, byteLength: 0 },
  }]));
  return { snapshot: { schemaVersion: 1, instanceId: 'instance-A', connectionEpoch: 'connection-A', watermark: 1, sampledAt: 2000, sources, recentResults: [], capacityReached: false }, appearances };
}
