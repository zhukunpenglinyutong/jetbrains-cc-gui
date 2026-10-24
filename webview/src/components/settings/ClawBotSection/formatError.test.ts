import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';
import zh from '../../../i18n/locales/zh.json';
import en from '../../../i18n/locales/en.json';
import { formatClawBotError } from './formatError';

async function translator(language: string) {
  const instance = createInstance();
  await instance.init({ lng: language, fallbackLng: 'en', resources: { zh: { translation: zh }, en: { translation: en } } });
  return instance.t.bind(instance);
}

describe('formatClawBotError', () => {
  it('localizes the reported authentication error without losing the service code', async () => {
    const translate = await translator('zh');
    expect(formatClawBotError('ILINK_AUTH_REJECTED (errcode=-14)', translate))
      .toBe('微信身份验证失败，请重新绑定并授权发送者 (ILINK_AUTH_REJECTED; errcode=-14)');
    expect(formatClawBotError('ILINK_HTTP_STATUS (HTTP 503)', translate))
      .toBe('微信服务返回异常状态 (ILINK_HTTP_STATUS; HTTP 503)');
  });

  it('retains unknown codes and details without exposing an untranslated key', async () => {
    const translate = await translator('zh');
    expect(formatClawBotError('ILINK_NEW_ERROR (errcode=99)', translate))
      .toBe('微信通道发生错误，请查看错误码 (ILINK_NEW_ERROR; errcode=99)');
    expect(formatClawBotError('unexpected response', translate))
      .toBe('微信通道发生错误，请查看错误码 (unexpected response)');
  });

  it('uses the selected language and keeps ambiguous delivery distinct from failure', async () => {
    const translate = await translator('en');
    expect(formatClawBotError('ILINK_SEND_RESULT_UNKNOWN', translate))
      .toBe('Delivery is unconfirmed; check Weixin before sending again (ILINK_SEND_RESULT_UNKNOWN)');
  });
});
