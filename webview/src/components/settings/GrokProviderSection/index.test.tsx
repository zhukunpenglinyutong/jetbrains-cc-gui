import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GrokProviderSection from './index';

const translations: Record<string, string> = {
  'settings.grok.title': 'Grok JSON Configuration',
  'settings.grok.desc': 'Configure Grok settings using JSON format.',
  'settings.grok.editorHint': 'Edit your configuration below.',
  'settings.grok.save': 'Save Configuration',
  'settings.grok.saving': 'Saving...',
  'settings.grok.invalidJson': 'Invalid JSON format',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

const sendToJava = vi.fn();

describe('GrokProviderSection', () => {
  beforeEach(() => {
    sendToJava.mockReset();
    window.sendToJava = sendToJava;
  });

  afterEach(() => {
    delete window.sendToJava;
    delete window.updateGrokAuthConfig;
  });

  const editor = () => screen.getByRole('textbox') as HTMLTextAreaElement;

  const typeJson = (value: string) => {
    fireEvent.change(editor(), { target: { value } });
  };

  it('requests the current config on mount and unregisters on unmount', () => {
    const { unmount } = render(<GrokProviderSection />);
    expect(sendToJava).toHaveBeenCalledWith('get_grok_auth_config:');
    expect(typeof window.updateGrokAuthConfig).toBe('function');

    unmount();
    expect(window.updateGrokAuthConfig).toBeUndefined();
  });

  it('hydrates a flat apiKey payload into both XAI and GROK env aliases', async () => {
    render(<GrokProviderSection />);
    await act(async () => {
      window.updateGrokAuthConfig?.(JSON.stringify({
        authMethod: 'api_key',
        apiKey: 'sk-flat-key',
        apiBaseUrl: 'https://api.example.com',
        oauthBaseUrl: 'https://oauth.example.com',
      }));
    });

    const parsed = JSON.parse(editor().value);
    expect(parsed.authMethod).toBe('api_key');
    expect(parsed.env.XAI_API_KEY).toBe('sk-flat-key');
    expect(parsed.env.GROK_API_KEY).toBe('sk-flat-key');
    expect(parsed.env.GROK_MODELS_BASE_URL).toBe('https://api.example.com');
    expect(parsed.env.GROK_CLI_CHAT_PROXY_BASE_URL).toBe('https://oauth.example.com');
  });

  it('keeps an explicit env object untouched when the payload carries one', async () => {
    render(<GrokProviderSection />);
    const env = { XAI_API_KEY: 'sk-explicit', GROK_MODELS_BASE_URL: 'https://kept.example.com' };
    await act(async () => {
      window.updateGrokAuthConfig?.(JSON.stringify({ authMethod: 'oauth', env }));
    });

    const parsed = JSON.parse(editor().value);
    expect(parsed.env).toEqual(env);
    expect(parsed.env.GROK_API_KEY).toBeUndefined();
  });

  it('maps the edited JSON onto the backend payload on save', () => {
    render(<GrokProviderSection />);
    typeJson(JSON.stringify({
      env: {
        XAI_API_KEY: 'sk-123',
        GROK_MODELS_BASE_URL: 'https://models.example.com',
        GROK_CLI_CHAT_PROXY_BASE_URL: 'https://proxy.example.com',
      },
      authMethod: 'api_key',
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

    expect(sendToJava).toHaveBeenCalledWith(
      `set_grok_auth_config:${JSON.stringify({
        authMethod: 'api_key',
        apiKey: 'sk-123',
        apiBaseUrl: 'https://models.example.com',
        oauthBaseUrl: 'https://proxy.example.com',
        env: {
          XAI_API_KEY: 'sk-123',
          GROK_MODELS_BASE_URL: 'https://models.example.com',
          GROK_CLI_CHAT_PROXY_BASE_URL: 'https://proxy.example.com',
        },
      })}`
    );
  });

  it('shows an error and sends nothing when the JSON is invalid', () => {
    render(<GrokProviderSection />);
    typeJson('{ not json');
    fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

    expect(screen.getByText('Invalid JSON format')).toBeTruthy();
    expect(sendToJava).toHaveBeenCalledTimes(1); // only the mount-time get_grok_auth_config
  });
});
