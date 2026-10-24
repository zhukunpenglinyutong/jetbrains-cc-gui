import type { OfficePhase, OfficeSource } from './officeModel';
import { OFFICE_MAX_SOURCES } from './officeModel';

export const OFFICE_ACTIONS = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'] as const;
export const OFFICE_STATES = ['idle', 'running', 'thinking', 'success', 'error'] as const;
export type PetState = typeof OFFICE_STATES[number];
export type PetAction = typeof OFFICE_ACTIONS[number];
export interface OfficeManifest { digest: string; kind: 'builtin' | 'sheet' | 'image'; mime: string; width: number; height: number; byteLength: number }
export interface OfficeAppearance { revision: string; scope: string; opacity: number; actionMappings: Record<PetState, PetAction[]>; status: string; manifest: OfficeManifest }
export interface LiveSource extends OfficeSource {
  sourceRevision: number; observationRevision: number; observationAgeMillis: number; terminalGraceRemainingMillis: number;
  projectId: string; modelLabel: string; turnId: string; outcome: string; terminalEventId: string;
  waitReason: string; pendingInteractionId: string; pendingInteractionCount: number;
  routeStatus: string; routeGeneration: string; appearance: OfficeAppearance;
}
export interface RecentOfficeResult { sourceKey: string; product: string; projectLabel: string; tabLabel: string; provider: string; modelLabel: string; outcome: string; terminalEventId: string; completedAt: number }
export interface LiveScene { instanceId: string; connectionEpoch: string; watermark: number; sampledAt: number; capacityReached: boolean; sources: LiveSource[]; recentResults: RecentOfficeResult[] }

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalidScene');
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).length !== allowed.length || allowed.some(key => !Object.hasOwn(value, key))) throw new Error('invalidScene');
}
export function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('invalidScene');
  return value;
}
export function text(value: unknown, max = 160): string {
  if (typeof value !== 'string' || [...value].length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('invalidScene');
  return value;
}
export function identifier(value: unknown, optional = false): string {
  const id = text(value, 128);
  if (!(optional && id === '') && (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || id === '.' || id === '..')) throw new Error('invalidScene');
  return id;
}
export function digest(value: unknown, optional = false): string {
  const id = text(value, 64);
  if (!(optional && id === '') && !/^[a-f0-9]{64}$/.test(id)) throw new Error('invalidScene');
  return id;
}
function enumeration<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error('invalidScene');
  return value as T;
}
function sourceKey(value: unknown, participants: ReadonlySet<string>): string {
  const source = object(value); keys(source, ['instanceId', 'contentHandleId', 'bindingEpoch']);
  const instanceId = identifier(source.instanceId);
  if (!participants.has(instanceId)) throw new Error('invalidScene');
  return `${instanceId}/${identifier(source.contentHandleId)}/${identifier(source.bindingEpoch)}`;
}
function metadata(value: unknown) {
  const item = object(value); keys(item, ['contentHandleId', 'productCode', 'productName', 'projectId', 'projectLabel', 'tabLabel']);
  const productCode = text(item.productCode);
  return { contentHandleId: identifier(item.contentHandleId), product: text(item.productName) || productCode, projectId: identifier(item.projectId), projectLabel: text(item.projectLabel), tabLabel: text(item.tabLabel) };
}
export function parseManifest(value: unknown): OfficeManifest {
  const item = object(value); keys(item, ['digest', 'kind', 'mime', 'width', 'height', 'byteLength']);
  const kind = enumeration(item.kind, ['builtin', 'sheet', 'image']);
  const result = { digest: digest(item.digest, kind === 'builtin'), kind, mime: text(item.mime), width: integer(item.width, 4096), height: integer(item.height, 4096), byteLength: integer(item.byteLength, 4 * 1024 * 1024) };
  if (!result.width || !result.height || result.width * result.height > 6_500_000) throw new Error('invalidScene');
  if (kind === 'builtin') {
    if (result.digest || result.mime || result.byteLength) throw new Error('invalidScene');
  } else if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(result.mime) || !result.byteLength) throw new Error('invalidScene');
  if (kind === 'sheet' && (result.width !== 1536 || result.height < 1872 || result.height % 208 !== 0)) throw new Error('invalidScene');
  return result;
}
function appearance(value: unknown): OfficeAppearance {
  const item = object(value); keys(item, ['revision', 'scope', 'opacity', 'actionMappings', 'status', 'manifest']);
  const mappings = object(item.actionMappings); keys(mappings, OFFICE_STATES);
  const actions = {} as Record<PetState, PetAction[]>;
  for (const state of OFFICE_STATES) {
    const list = mappings[state];
    if (!Array.isArray(list) || list.length < 1 || list.length > OFFICE_ACTIONS.length) throw new Error('invalidScene');
    actions[state] = list.map(action => enumeration(action, OFFICE_ACTIONS));
  }
  if (typeof item.opacity !== 'number' || !Number.isFinite(item.opacity) || item.opacity < 0.3 || item.opacity > 1) throw new Error('invalidScene');
  return { revision: digest(item.revision), scope: enumeration(item.scope, ['project', 'global', 'session']), opacity: item.opacity, actionMappings: actions, status: enumeration(item.status, ['BUILTIN', 'READY', 'ASSET_BUSY', 'ASSET_CAPACITY', 'ASSET_UNAVAILABLE', 'REMOTE_PENDING']), manifest: parseManifest(item.manifest) };
}
const PHASES: readonly OfficePhase[] = ['IDLE', 'QUEUED', 'RUNNING', 'THINKING', 'WAITING_USER', 'STOPPING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'];
const OUTCOMES = ['NONE', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;

/** Strict, metadata-only snapshot. Foreign identities require an explicit admitted participant set. */
export function parseLiveScene(value: unknown): LiveScene {
  const scene = object(value); keys(scene, Object.hasOwn(scene, 'participants') ? ['snapshot', 'appearances', 'participants'] : ['snapshot', 'appearances']);
  const snapshot = object(scene.snapshot); keys(snapshot, ['schemaVersion', 'instanceId', 'connectionEpoch', 'watermark', 'sampledAt', 'sources', 'recentResults', 'capacityReached']);
  if (snapshot.schemaVersion !== 1 || typeof snapshot.capacityReached !== 'boolean') throw new Error('invalidScene');
  const instanceId = identifier(snapshot.instanceId), appearances = object(scene.appearances);
  const participants = new Set([instanceId]);
  if (Object.hasOwn(scene, 'participants')) {
    const owners = scene.participants;
    if (!Array.isArray(owners) || owners.length < 1 || owners.length > 16) throw new Error('invalidScene');
    const admitted = owners.map(owner => identifier(owner));
    if (!admitted.includes(instanceId) || new Set(admitted).size !== admitted.length) throw new Error('invalidScene');
    admitted.forEach(owner => participants.add(owner));
  }
  if (!Array.isArray(snapshot.sources) || snapshot.sources.length > OFFICE_MAX_SOURCES || !Array.isArray(snapshot.recentResults) || snapshot.recentResults.length > 50) throw new Error('invalidScene');
  const seen = new Set<string>();
  const sources = snapshot.sources.map((value): LiveSource => {
    const item = object(value); keys(item, ['sourceKey', 'sourceRevision', 'metadata', 'provider', 'modelLabel', 'execution', 'routeStatus', 'routeGeneration', 'observationRevision', 'observationAgeMillis', 'terminalGraceRemainingMillis']);
    const key = sourceKey(item.sourceKey, participants), meta = metadata(item.metadata), execution = object(item.execution);
    keys(execution, ['bindingEpoch', 'turnId', 'phase', 'waitReason', 'pendingInteractionId', 'pendingInteractionCount', 'outcome', 'terminalEventId', 'startedAt', 'completedAt', 'revision']);
    if (seen.has(key) || key !== `${key.split('/')[0]}/${meta.contentHandleId}/${identifier(execution.bindingEpoch)}`) throw new Error('invalidScene');
    seen.add(key); integer(execution.startedAt); integer(execution.completedAt); integer(execution.revision);
    const phase = enumeration(execution.phase, PHASES), waitReason = enumeration(execution.waitReason, ['NONE', 'QUESTION', 'PERMISSION', 'PLAN']);
    const pendingInteractionId = identifier(execution.pendingInteractionId, true), pendingInteractionCount = integer(execution.pendingInteractionCount, 16);
    if (phase === 'WAITING_USER' ? waitReason === 'NONE' || pendingInteractionId === '' || pendingInteractionCount === 0
      : waitReason !== 'NONE' || pendingInteractionId !== '' || pendingInteractionCount !== 0) throw new Error('invalidScene');
    return { sourceKey: key, ...meta, seat: -1, provider: text(item.provider), modelLabel: text(item.modelLabel), phase,
      sourceRevision: integer(item.sourceRevision), observationRevision: integer(item.observationRevision), observationAgeMillis: integer(item.observationAgeMillis), terminalGraceRemainingMillis: integer(item.terminalGraceRemainingMillis, 5000),
      turnId: identifier(execution.turnId, true), outcome: enumeration(execution.outcome, OUTCOMES), terminalEventId: identifier(execution.terminalEventId, true), waitReason, pendingInteractionId, pendingInteractionCount,
      routeStatus: enumeration(item.routeStatus, ['AVAILABLE', 'DETACHED', 'CLOSED']), routeGeneration: identifier(item.routeGeneration), appearance: appearance(appearances[key]) };
  });
  if (Object.keys(appearances).length !== seen.size) throw new Error('invalidScene');
  const recentResults = snapshot.recentResults.map((value): RecentOfficeResult => {
    const item = object(value); keys(item, ['sourceKey', 'metadata', 'provider', 'modelLabel', 'turnId', 'outcome', 'terminalEventId', 'completedAt']);
    const key = sourceKey(item.sourceKey, participants), meta = metadata(item.metadata);
    if (key.split('/')[1] !== meta.contentHandleId) throw new Error('invalidScene');
    identifier(item.turnId);
    return { sourceKey: key, product: meta.product, projectLabel: meta.projectLabel, tabLabel: meta.tabLabel, provider: text(item.provider), modelLabel: text(item.modelLabel), outcome: enumeration(item.outcome, ['SUCCEEDED', 'FAILED', 'CANCELLED']), terminalEventId: identifier(item.terminalEventId), completedAt: integer(item.completedAt) };
  });
  if (new Set(recentResults.map(item => item.terminalEventId)).size !== recentResults.length) throw new Error('invalidScene');
  return { instanceId, connectionEpoch: identifier(snapshot.connectionEpoch), watermark: integer(snapshot.watermark), sampledAt: integer(snapshot.sampledAt), capacityReached: snapshot.capacityReached, sources, recentResults };
}

export function presentSource(source: LiveSource, elapsed: number, connectionStale = false): LiveSource {
  const stale = connectionStale || source.phase === 'UNKNOWN'
    || (source.outcome === 'NONE' && source.phase !== 'IDLE' && source.observationAgeMillis + elapsed >= 15_000);
  const phase = stale ? 'UNKNOWN' : source.outcome !== 'NONE' && elapsed >= source.terminalGraceRemainingMillis ? 'IDLE' : source.phase;
  return { ...source, phase, waitReason: phase === 'WAITING_USER' ? source.waitReason : 'NONE', pendingInteractionId: phase === 'WAITING_USER' ? source.pendingInteractionId : '', pendingInteractionCount: phase === 'WAITING_USER' ? source.pendingInteractionCount : 0 };
}

/** Stable seats survive filters and floor changes; terminal grace ends without moving live desks. */
export class OfficeSeatAllocator {
  private seats = new Map<string, number>();
  assign(sources: readonly LiveSource[], showIdle: boolean): LiveSource[] {
    const eligible = sources.filter(source => showIdle || source.phase !== 'IDLE');
    const keys = new Set(eligible.map(source => source.sourceKey));
    for (const key of this.seats.keys()) if (!keys.has(key)) this.seats.delete(key);
    const occupied = new Set(this.seats.values());
    for (const source of [...eligible].sort((a, b) => Number(a.phase === 'IDLE') - Number(b.phase === 'IDLE'))) {
      if (!this.seats.has(source.sourceKey)) {
        let seat = 0; while (occupied.has(seat)) seat++;
        this.seats.set(source.sourceKey, seat); occupied.add(seat);
      }
    }
    return eligible.map(source => ({ ...source, seat: this.seats.get(source.sourceKey)! }));
  }
}
