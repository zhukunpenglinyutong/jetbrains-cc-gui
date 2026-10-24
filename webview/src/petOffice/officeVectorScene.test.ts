import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render } from '@testing-library/react';
import { OFFICE_THEME_IDS } from './officeThemes';
import { OFFICE_ART_SEATS } from './officeArtGeometry';
import { OfficeVectorScene } from './OfficeVectorScene';

const drawings = import.meta.glob<string>('./vector/*.svg', { eager: true, query: '?raw', import: 'default' });

describe('bundled vector drawing contract', () => {
  it('retains depth-group identity across camera-only updates', () => {
    const view = render(createElement(OfficeVectorScene, { theme: 'loft', viewBox: '0 0 1160 1040' }));
    const backdrop = view.container.querySelector('[data-depth="backdrop"]');
    try {
      expect(backdrop).not.toBeNull();
      view.rerender(createElement(OfficeVectorScene, { theme: 'loft', viewBox: '100 280 960 760' }));
      expect(view.container.querySelector('[data-depth="backdrop"]')).toBe(backdrop);
    } finally { view.unmount(); }
  });
  it.each(OFFICE_THEME_IDS)('%s renders furniture only in the foreground layer', theme => {
    const viewBox = '0 0 1160 1040';
    const markup = renderToStaticMarkup(createElement(OfficeVectorScene, { theme, viewBox }));
    const environment = new DOMParser().parseFromString(markup, 'image/svg+xml');
    expect(environment.querySelector('parsererror')).toBeNull();
    expect(environment.querySelector('[data-layer="environment"]')).not.toBeNull();
    expect(environment.querySelector(`use[href="#office-${theme}-foreground"]`)).toBeNull();
    expect(environment.getElementById(`office-${theme}-foreground`)?.querySelectorAll('use')).toHaveLength(12);
    const front = renderToStaticMarkup(createElement(OfficeVectorScene, { theme, viewBox, foreground: true }));
    const foreground = new DOMParser().parseFromString(front, 'image/svg+xml');
    expect(foreground.querySelectorAll('use')).toHaveLength(1);
    expect(foreground.querySelector('use')?.getAttribute('href')).toBe(`#office-${theme}-foreground`);
  });

  it.each(OFFICE_THEME_IDS)('%s is a self-contained vector room with resolvable furniture and gradients', theme => {
    const drawing = drawings[`./vector/${theme}.svg`];
    const document = new DOMParser().parseFromString(drawing, 'image/svg+xml');
    expect(document.querySelector('parsererror, image, script, foreignObject, filter')).toBeNull();
    expect(document.documentElement.getAttribute('viewBox')).toBe('0 0 1160 1040');
    const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const use of document.querySelectorAll('use')) {
      const href = use.getAttribute('href') ?? '';
      expect(href).toMatch(/^#office-/);
      expect(document.getElementById(href.slice(1))?.tagName).toBe('g');
    }
    const desks = [...document.getElementById(`office-${theme}-foreground`)!.querySelectorAll('use')];
    expect(desks).toHaveLength(12);
    for (const [index, desk] of desks.entries()) {
      const seat = OFFICE_ART_SEATS[theme][index];
      expect(desk.getAttribute('href')).toBe(`#office-${theme}-desk`);
      expect(desk.getAttribute('transform')).toBe(`translate(${seat.x} ${seat.y}) scale(${seat.scale})`);
    }
    for (const element of document.querySelectorAll('*')) for (const attribute of element.attributes) {
      expect(attribute.name).not.toMatch(/^on/i);
      if (attribute.name !== 'xmlns') expect(attribute.value).not.toMatch(/https?:|data:|url\((?!#)/i);
      for (const match of attribute.value.matchAll(/url\(#([^)]+)\)/g)) {
        const tags = attribute.name === 'clip-path' ? ['clipPath'] : ['linearGradient', 'radialGradient', 'pattern'];
        expect(tags).toContain(document.getElementById(match[1])?.tagName);
      }
    }
    expect(drawing).not.toMatch(/data:|@import|<image[\s>]/i);
  });
});
