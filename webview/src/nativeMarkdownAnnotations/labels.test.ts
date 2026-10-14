import { previewLabels } from './labels';

it('uses CC GUI language codes and falls back safely for unsupported locales', () => {
  expect(previewLabels('zh').edit).toBe('编辑');
  expect(previewLabels('zh-TW').remove).toBe('刪除');
  expect(previewLabels('ja').send).toBe('送信');
  expect(previewLabels('pt-BR').close).toBe('Fechar');
  expect(previewLabels('en-US').source).toBe('Show source');
  expect(previewLabels('unknown').title).toBe('Markdown review');
});
