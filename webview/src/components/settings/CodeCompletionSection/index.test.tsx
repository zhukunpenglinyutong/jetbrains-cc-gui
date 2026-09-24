import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import CodeCompletionSection from './index';

vi.mock('react-i18next', () => ({
  // Interpolate params so assertions can see values like the error text.
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${Object.values(params).join(' ')}` : key,
  }),
}));

const persisted = {
  enabled: true,
  preset: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  path: '/beta/completions',
  apiKey: 'sk-ab****cdef',
  model: 'deepseek-flash',
  maxTokens: 1024,
  temperature: 1,
  topP: 1,
  stop: ['\n\n'],
  ignoreEos: false,
  debounceMs: 300,
};

/** The draft the section sent with its last test request. */
const lastTestPayload = () => {
  const sendToJava = window.sendToJava as unknown as { mock: { calls: unknown[][] } };
  const call = sendToJava.mock.calls
    .filter(([arg]) => String(arg).startsWith('test_code_completion:'))
    .pop();
  expect(call).toBeTruthy();
  return JSON.parse(String(call?.[0]).slice('test_code_completion:'.length));
};

describe('CodeCompletionSection', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
    window.updateCodeCompletionSettings = undefined;
    window.onCodeCompletionTestResult = undefined;
  });

  it('requests the persisted config on mount', () => {
    render(<CodeCompletionSection />);
    expect(window.sendToJava).toHaveBeenCalledWith('get_code_completion_settings:');
  });

  it('fills baseUrl and path from the selected preset', () => {
    render(<CodeCompletionSection />);
    act(() => window.updateCodeCompletionSettings?.(JSON.stringify(persisted)));

    fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'siliconflow' } });
    expect((screen.getByLabelText('Base URL') as HTMLInputElement).value).toBe('https://api.siliconflow.cn');
    expect((screen.getByLabelText('Endpoint path') as HTMLInputElement).value).toBe('/v1/completions');
  });

  // Regression: SiliconFlow advertises models it will not run FIM on, so the
  // preset used to auto-fill `deepseek-ai/DeepSeek-V4-Flash` and every probe
  // (and every editor completion) came back `400 20031 FIM is not supported`.
  it('fills a model the gateway actually accepts for FIM', () => {
    render(<CodeCompletionSection />);
    act(() => window.updateCodeCompletionSettings?.(JSON.stringify(persisted)));

    fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'siliconflow' } });
    const model = (screen.getByLabelText('Model') as HTMLInputElement).value;
    expect(model).toBe('deepseek-ai/DeepSeek-V3');
    expect(model).not.toContain('V4-Flash');
  });

  it('shows the returned snippet on a successful test', () => {
    render(<CodeCompletionSection />);
    act(() => window.updateCodeCompletionSettings?.(JSON.stringify(persisted)));

    fireEvent.click(screen.getByTestId('code-completion-test'));
    // The probe must measure the form's values, not the last saved config.
    expect(lastTestPayload().baseUrl).toBe('https://api.deepseek.com');
    expect(lastTestPayload().path).toBe('/beta/completions');

    act(() =>
      window.onCodeCompletionTestResult?.(
        JSON.stringify({
          ok: true,
          httpStatus: 200,
          snippet: '    return a + b;',
          endpoint: 'https://api.deepseek.com/beta/completions',
        })
      )
    );
    expect(screen.getByTestId('code-completion-test-result').textContent).toContain('return a + b;');
  });

  // Regression: testing the persisted config answered with the previously saved
  // endpoint, so switching platform and testing reported another platform's
  // result — while this button is the only way to diagnose a silent failure.
  it('tests the platform selected on screen, not the saved one', () => {
    render(<CodeCompletionSection />);
    act(() => window.updateCodeCompletionSettings?.(JSON.stringify(persisted)));

    fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'siliconflow' } });
    fireEvent.click(screen.getByTestId('code-completion-test'));

    expect(lastTestPayload().baseUrl).toBe('https://api.siliconflow.cn');
    expect(lastTestPayload().path).toBe('/v1/completions');
  });

  it('keeps the "reused from" hint in step with the tested config', () => {
    render(<CodeCompletionSection />);
    act(() => window.updateCodeCompletionSettings?.(JSON.stringify(persisted)));

    fireEvent.click(screen.getByTestId('code-completion-test'));
    act(() =>
      window.onCodeCompletionTestResult?.(
        JSON.stringify({
          ok: true,
          httpStatus: 200,
          snippet: 'x',
          endpoint: 'https://api.deepseek.com/beta/completions',
          apiKeyResolvedFrom: 'DouBaoSeed',
        })
      )
    );

    expect(screen.getByText(/settings\.codeCompletion\.reusedFrom/).textContent).toContain('DouBaoSeed');
  });

  it('shows the error on a failed test', () => {
    render(<CodeCompletionSection />);
    act(() => window.updateCodeCompletionSettings?.(JSON.stringify(persisted)));

    act(() =>
      window.onCodeCompletionTestResult?.(
        JSON.stringify({
          ok: false,
          httpStatus: 404,
          error: 'HTTP 404: not found',
          endpoint: 'https://x/v1/completions',
        })
      )
    );
    expect(screen.getByTestId('code-completion-test-result').textContent).toContain('HTTP 404');
    expect(screen.queryByTestId('code-completion-fim-hint')).toBeNull();
  });

  // The raw body ("code":20031) is the only thing the gateway returns, and it
  // reads like a config error; the hint is what turns it into a fix.
  it('explains a "model does not support FIM" failure with usable models', () => {
    render(<CodeCompletionSection />);
    act(() => window.updateCodeCompletionSettings?.(JSON.stringify(persisted)));

    fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'siliconflow' } });
    act(() =>
      window.onCodeCompletionTestResult?.(
        JSON.stringify({
          ok: false,
          httpStatus: 400,
          error: 'HTTP 400: {"code":20031,"message":"FIM is not supported for this model.","data":null}',
          endpoint: 'https://api.siliconflow.cn/v1/completions',
        })
      )
    );

    const hint = screen.getByTestId('code-completion-fim-hint').textContent ?? '';
    expect(hint).toContain('settings.codeCompletion.fimUnsupported');
    expect(hint).toContain('deepseek-ai/DeepSeek-V3');
    expect(hint).not.toContain('V4-Flash');
  });

  it('saves preset and path in the payload', () => {
    render(<CodeCompletionSection />);
    act(() => window.updateCodeCompletionSettings?.(JSON.stringify(persisted)));

    const sendToJava = window.sendToJava as ReturnType<typeof vi.fn>;
    sendToJava.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'settings.codeCompletion.save' }));

    const sent = sendToJava.mock.calls[0][0] as string;
    const payload = JSON.parse(sent.slice('set_code_completion_settings:'.length));
    expect(payload.preset).toBe('deepseek');
    expect(payload.path).toBe('/beta/completions');
  });
});
