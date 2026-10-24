export const OFFICE_FLOOR_CAPACITY = 12;
export const OFFICE_MAX_SOURCES = 256;
export const OFFICE_MAX_FLOORS = Math.ceil(OFFICE_MAX_SOURCES / OFFICE_FLOOR_CAPACITY);
export const OFFICE_FIXTURE_COUNTS = [0, 10, 50] as const;
export type OfficeFixtureCount = typeof OFFICE_FIXTURE_COUNTS[number];
export type OfficeProduct = string;
export type OfficePhase = 'IDLE' | 'RUNNING' | 'THINKING' | 'WAITING_USER' | 'QUEUED' | 'STOPPING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';

export interface OfficeSource {
  sourceKey: string;
  product: OfficeProduct;
  projectLabel: string;
  tabLabel: string;
  provider: string;
  phase: OfficePhase;
  seat: number;
}

const PRODUCTS: readonly OfficeProduct[] = ['IDEA', 'PyCharm', 'WebStorm'];
const PHASES: readonly OfficePhase[] = ['RUNNING', 'THINKING', 'WAITING_USER', 'RUNNING', 'QUEUED', 'STOPPING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED'];
const PROJECTS = ['Backend', 'Data Lab', 'Web Console'] as const;

/** Stable fixture identities deliberately contain no provider transcript IDs. */
export function createOfficeFixtures(count: OfficeFixtureCount): OfficeSource[] {
  return Array.from({ length: count }, (_, index) => ({
    sourceKey: `prototype-${index}`,
    product: PRODUCTS[index % PRODUCTS.length],
    projectLabel: PROJECTS[index % PROJECTS.length],
    tabLabel: `AI ${Math.floor(index / 3) + 1}`,
    provider: index % 2 === 0 ? 'Codex' : 'Claude',
    phase: PHASES[index % PHASES.length],
    seat: index,
  }));
}

export function filterOfficeSources(sources: readonly OfficeSource[], product: OfficeProduct | 'all', search: string): OfficeSource[] {
  const query = search.trim().toLocaleLowerCase();
  return sources.filter(source => (product === 'all' || source.product === product)
    && (!query || `${source.product} ${source.projectLabel} ${source.tabLabel} ${source.provider}`.toLocaleLowerCase().includes(query)));
}

/** Filtering preserves source seat/page assignment instead of moving desks. */
export function officeFloorSources(sources: readonly OfficeSource[], floor: number): OfficeSource[] {
  return sources.filter(source => Math.floor(source.seat / OFFICE_FLOOR_CAPACITY) === floor);
}

export function phaseColor(phase: OfficePhase): string {
  switch (phase) {
    case 'WAITING_USER': return '#e8b866';
    case 'FAILED': return '#ef8a87';
    case 'UNKNOWN': return '#9ca8b3';
    case 'SUCCEEDED': return '#81cfa3';
    case 'CANCELLED': return '#b4a8be';
    case 'THINKING': return '#b3a0ed';
    default: return '#7bc3d4';
  }
}
