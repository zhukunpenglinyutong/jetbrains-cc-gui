import type { TFunction } from 'i18next';

export function formatClawBotError(rawError: string, t: TFunction): string {
  const error = rawError.trim();
  const match = /^([A-Z][A-Z0-9_]*)(?:\s+\(([^()\r\n]*)\))?$/.exec(error);
  const code = match?.[1];
  const description = code
    ? t(`settings.clawBot.errors.${code}`, { defaultValue: t('settings.clawBot.errors.unknown') })
    : t('settings.clawBot.errors.unknown');
  const details = match?.[2] ? `${code}; ${match[2]}` : error;
  return `${description} (${details})`;
}
