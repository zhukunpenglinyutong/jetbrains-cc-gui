import geometry from './vector/geometry.json' with { type: 'json' };
import type { OfficeThemeId } from './officeThemes';

export interface OfficeArtSeat { x: number; y: number; scale: number; label: number; front: number; bottom: number; half: number }
export const OFFICE_ART_SEATS: Record<OfficeThemeId, readonly OfficeArtSeat[]> = geometry;
