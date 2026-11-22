import { markdownReviewLocation } from './markdownReviewLocation';

it('shows a compact filename prefix and exact line pair', () => {
  expect(markdownReviewLocation('docs/柜机数据WSS接口文档.md', 30, 30)).toBe('柜机数据WSS接口文… 30:30');
  expect(markdownReviewLocation('C:\\docs\\a.md', 3, 9)).toBe('a.md 3:9');
});
