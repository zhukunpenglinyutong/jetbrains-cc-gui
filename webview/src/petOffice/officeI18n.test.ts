import { describe, expect, it } from 'vitest';
import i18n from './officeI18n';
import { OFFICE_MARGIN_MODES } from './officeMarginEffects';

describe('Office Chinese appearance and preview translations', () => {
  it('provides readable Chinese rather than question marks or untranslated keys', () => {
    const t = i18n.getFixedT('zh', 'petOffice');
    for (const key of ['sessionAppearance', 'inheritAppearance', 'builtinAppearance', 'refreshAppearances', 'sessionAppearanceHint',
      'unavailableAppearance', 'appearanceChoicesError', 'deskPreview', 'deskPreviewHint', 'studioSettings', 'marginEffects', 'enableMarginEffects',
      'marginEffectStyle', 'marginEffectsOff', 'marginModes.aurora', 'marginModes.matrix', 'marginModes.rain', 'marginModes.stars', 'marginModes.snow', 'marginEffectsHint',
      'officeName', 'applyOfficeName', 'officeNameHint', 'officeNameInvalid', 'officeNameStorageError']) {
      const label = t(key, { id: 'duck/spritesheet.png' });
      expect(label).not.toBe(key); expect(label).toMatch(/[\u4e00-\u9fff]/); expect(label).not.toMatch(/\?{2,}|\uFFFD/);
    }
  });
  it('uses one Chinese workstation term consistently', () => {
    const t = i18n.getFixedT('zh', 'petOffice');
    for (const key of ['notice', 'selectHint', 'visible', 'selected', 'sessionGesture', 'deskPreview', 'deskPreviewHint', 'sessionAppearance']) {
      expect(t(key)).toContain('工位'); expect(t(key)).not.toMatch(/桌位|座位/);
    }
  });
  it.each(['zh', 'en'])('labels every effect and its description in %s', language => {
    const t = i18n.getFixedT(language, 'petOffice');
    for (const mode of OFFICE_MARGIN_MODES) {
      expect(t(`marginModes.${mode}`)).not.toContain('marginModes.');
      expect(t(`marginDescriptions.${mode}`)).not.toContain('marginDescriptions.');
    }
  });
});
