import { memo } from 'react';
import loft from './vector/loft.svg?raw';
import cyberpunk from './vector/cyberpunk.svg?raw';
import cultivation from './vector/cultivation.svg?raw';
import space from './vector/space.svg?raw';
import forest from './vector/forest.svg?raw';
import library from './vector/library.svg?raw';
import ocean from './vector/ocean.svg?raw';
import zen from './vector/zen.svg?raw';
import retro from './vector/retro.svg?raw';
import type { OfficeThemeId } from './officeThemes';

const drawings: Record<OfficeThemeId, string> = { loft, cyberpunk, cultivation, space, forest, library, ocean, zen, retro };
// Draw the foreground once, above the Pet canvas, including drawings with transformed references.
const environments = Object.fromEntries(Object.entries(drawings).map(([theme, svg]) => [theme,
  svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>')).replace(new RegExp(`<use\\b[^>]*\\bhref="#office-${theme}-foreground"[^>]*/>`), ''),
])) as Record<OfficeThemeId, string>;

/** Only trusted, bundled drawings enter this component. User backgrounds remain raster-only. */
export const OfficeVectorScene = memo(function OfficeVectorScene({ theme, viewBox, foreground = false }: {
  theme: OfficeThemeId; viewBox: string; foreground?: boolean;
}) {
  return foreground
    ? <svg className="office-vector-scene office-vector-foreground" viewBox={viewBox} preserveAspectRatio="none" aria-hidden="true" focusable="false"><use href={`#office-${theme}-foreground`} /></svg>
    : <svg className="office-vector-scene office-vector-environment" viewBox={viewBox} preserveAspectRatio="none" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={{ __html: environments[theme] }} />;
});
