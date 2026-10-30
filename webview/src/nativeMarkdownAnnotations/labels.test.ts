import { labelTranslations, previewLabels } from './labels';

it('uses CC GUI language codes and falls back safely for unsupported locales', () => {
  expect(previewLabels('zh').edit).toBe('编辑');
  expect(previewLabels('zh-TW').remove).toBe('刪除');
  expect(previewLabels('ja').send).toBe('送信');
  expect(previewLabels('pt-BR').close).toBe('Fechar');
  expect(previewLabels('en-US').source).toBe('Open in editor');
  expect(previewLabels('unknown').title).toBe('Markdown review');
});

it('translates every label in all ten languages, including every error key', () => {
  const english = labelTranslations.en;
  const gaps: string[] = [];
  for (const [language, dictionary] of Object.entries(labelTranslations)) {
    if (language === 'en') continue;
    for (const key of Object.keys(english) as (keyof typeof english)[]) {
      if (!dictionary[key]) gaps.push(`${language}.${key} (empty)`);
      else if (dictionary[key] === english[key]) gaps.push(`${language}.${key} (English fallback)`);
    }
  }
  expect(gaps).toEqual([]);
});
