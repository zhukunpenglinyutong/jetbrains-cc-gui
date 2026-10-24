import { describe, expect, it } from 'vitest';
import { createOfficeFixtures, filterOfficeSources, officeFloorSources, OFFICE_MAX_FLOORS, OFFICE_MAX_SOURCES } from './officeModel';

describe('Office prototype source visibility', () => {
  it('keeps all 50 identities reachable while limiting each floor to 12 larger actors', () => {
    const all = createOfficeFixtures(50);
    expect(new Set(all.map(source => source.sourceKey)).size).toBe(50);
    const floors = Array.from({ length: 5 }, (_, floor) => officeFloorSources(all, floor));
    expect(floors.map(floor => floor.length)).toEqual([12, 12, 12, 12, 2]);
    expect(floors.flat().map(source => source.sourceKey)).toEqual(all.map(source => source.sourceKey));
    expect(createOfficeFixtures(0)).toEqual([]);
  });

  it('filtering preserves desk and floor assignments and handles no matches', () => {
    const all = createOfficeFixtures(50);
    const filtered = filterOfficeSources(all, 'PyCharm', ' DATA LAB ');
    expect(filtered).toHaveLength(17);
    expect(filtered.every(source => all[source.seat] === source)).toBe(true);
    expect(officeFloorSources(filtered, 0)).toHaveLength(4);
    expect(officeFloorSources(filtered, 1)).toHaveLength(4);
    expect(filterOfficeSources(all, 'all', 'unknown project')).toEqual([]);
  });

  it('moves the thirteenth session to the next floor and retains all 256 accepted sessions', () => {
    const sample = createOfficeFixtures(10)[0];
    const all = Array.from({ length: OFFICE_MAX_SOURCES }, (_, seat) => ({ ...sample, seat, sourceKey: `source-${seat}` }));
    expect(officeFloorSources(all, 0).at(-1)?.sourceKey).toBe('source-11');
    expect(officeFloorSources(all, 1)[0].sourceKey).toBe('source-12');
    const floors = Array.from({ length: OFFICE_MAX_FLOORS }, (_, floor) => officeFloorSources(all, floor));
    expect(floors).toHaveLength(22);
    expect(floors.at(-1)).toHaveLength(4);
    expect(floors.flat()).toEqual(all);
  });
});
