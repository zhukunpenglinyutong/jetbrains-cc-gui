import { OFFICE_ART_SEATS } from './officeArtGeometry';
import { OFFICE_FLOOR_CAPACITY } from './officeModel';
import type { OfficeSource } from './officeModel';
import type { OfficeThemeId } from './officeThemes';

export interface OfficeCamera { x: number; y: number; width: number; height: number }
export const OFFICE_FULL_CAMERA: OfficeCamera = { x: 0, y: 0, width: 1160, height: 1040 };

/** Gently frame the selected desk; keep enough room context even on very wide displays. */
export function officeArtCamera(sources: readonly OfficeSource[], theme: OfficeThemeId, aspect: number, focus: boolean, selected?: string | null): OfficeCamera {
  if (!focus || !sources.length || !Number.isFinite(aspect) || aspect <= 0) return OFFICE_FULL_CAMERA;
  const source = sources.find(source => source.sourceKey === selected) ?? sources[0];
  const seat = OFFICE_ART_SEATS[theme][source.seat % OFFICE_FLOOR_CAPACITY];
  const width = Math.min(1160, Math.max(960, 760 * aspect));
  const height = Math.min(1040, Math.max(760, width / aspect));
  const centerY = (seat.y - 165 * seat.scale + seat.label + 30) / 2;
  return {
    x: Math.max(0, Math.min(1160 - width, seat.x - width / 2)),
    y: Math.max(0, Math.min(1040 - height, centerY - height / 2)), width, height,
  };
}

export function officeCameraPoint(camera: OfficeCamera, x: number, y: number, width: number, height: number) {
  return { x: camera.x + x * camera.width / Math.max(1, width), y: camera.y + y * camera.height / Math.max(1, height) };
}
