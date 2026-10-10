import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { ImageBlock } from './ImageBlock';

const t = ((key: string) => key) as TFunction;

it('previews the original image and returns focus to its thumbnail after Escape', () => {
  render(<ImageBlock block={{ type: 'image', src: 'data:image/png;base64,fixture', alt: 'Screenshot' }} messageType="user" t={t} />);
  const thumbnail = screen.getByRole('button', { name: 'chat.clickToPreview' });
  fireEvent.click(thumbnail);
  expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,fixture');
  expect(screen.getByRole('button', { name: 'common.close' })).toBe(document.activeElement);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(thumbnail).toBe(document.activeElement);
});

it('does not create an empty preview button for an unavailable image', () => {
  const { container } = render(<ImageBlock block={{ type: 'image', src: '' }} messageType="user" t={t} />);
  expect(container.querySelector('button')).toBeNull();
  expect(container.querySelector('img')).toBeNull();
});
