import { renderHook } from '@testing-library/react';
import { makeQuoteToken, pruneQuoteRegistry, registerQuote } from '../utils/quoteRegistry';
import { useSubmitHandler } from './useSubmitHandler';
import type { UseSubmitHandlerOptions } from './useSubmitHandler';

function options(): UseSubmitHandlerOptions {
  const close = vi.fn();
  return {
    getTextContent: () => '', attachments: [], sdkStatusLoading: false, sdkInstalled: true,
    currentProvider: 'claude', clearInput: vi.fn(), invalidateCache: vi.fn(), externalAttachments: undefined,
    setInternalAttachments: vi.fn(), fileCompletion: { close }, commandCompletion: { close },
    agentCompletion: { close }, promptCompletion: { close }, dollarCommandCompletion: { close },
    recordInputHistory: vi.fn(), onSubmit: vi.fn(), t: key => key, addToast: vi.fn(),
  };
}

describe('review submission snapshot', () => {
  afterEach(() => { vi.useRealTimers(); pruneQuoteRegistry(new Set()); });

  it('submits review-only messages, freezes quotes before input clearing, and acknowledges after handoff', () => {
    vi.useFakeTimers();
    const config = options();
    const token = makeQuoteToken(registerQuote('quoted source'));
    config.getTextContent = () => token;
    config.clearInput = () => pruneQuoteRegistry(new Set());
    const onSubmitted = vi.fn();
    config.captureReviewSubmission = () => ({ text: 'Markdown review: plan.md\n> /clear', onSubmitted });
    const { result } = renderHook(() => useSubmitHandler(config));
    result.current();
    expect(onSubmitted).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(config.onSubmit).toHaveBeenCalledWith(expect.stringContaining('quoted source'), undefined);
    expect(config.onSubmit).toHaveBeenCalledWith(expect.stringMatching(/^Markdown review:/), undefined);
    expect(onSubmitted).toHaveBeenCalledOnce();
  });

  it('retains review drafts when the SDK is unavailable or context exceeds the limit', () => {
    const config = options();
    const onSubmitted = vi.fn();
    config.captureReviewSubmission = () => ({ text: 'review', onSubmitted });
    config.sdkInstalled = false;
    const { result, rerender } = renderHook(() => useSubmitHandler(config));
    result.current();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(config.clearInput).not.toHaveBeenCalled();
    config.sdkInstalled = true;
    config.captureReviewSubmission = () => ({ text: 'x'.repeat(256_001), onSubmitted });
    rerender(); result.current();
    expect(config.addToast).toHaveBeenLastCalledWith('markdownReview.tooLarge', 'warning');
    expect(config.clearInput).not.toHaveBeenCalled();
  });

  it('keeps the typed input when the chat target changes during submission', () => {
    vi.useFakeTimers();
    const config = options();
    config.getTextContent = () => 'typed draft';
    const onSubmitted = vi.fn();
    config.captureReviewSubmission = () => ({ text: 'review', onSubmitted, isCurrent: () => false });
    const { result } = renderHook(() => useSubmitHandler(config));
    result.current();
    vi.advanceTimersByTime(20);
    expect(config.onSubmit).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(config.clearInput).not.toHaveBeenCalled();
    expect(config.setInternalAttachments).not.toHaveBeenCalled();
  });

  it('clears the input only after the target check passes', () => {
    vi.useFakeTimers();
    const config = options();
    const onSubmitted = vi.fn();
    config.captureReviewSubmission = () => ({ text: 'review', onSubmitted, isCurrent: () => true });
    const { result } = renderHook(() => useSubmitHandler(config));
    result.current();
    expect(config.clearInput).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(config.clearInput).toHaveBeenCalled();
    expect(config.setInternalAttachments).toHaveBeenCalled();
  });

  it('ignores a second press while the deferred handoff is still in flight', () => {
    vi.useFakeTimers();
    const config = options();
    const onSubmitted = vi.fn();
    config.captureReviewSubmission = () => ({ text: 'review', onSubmitted, isCurrent: () => true });
    const { result } = renderHook(() => useSubmitHandler(config));
    result.current();
    result.current();
    vi.advanceTimersByTime(20);
    expect(config.onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    // The guard lifts once the deferred handoff fires; a later press works again.
    result.current();
    vi.advanceTimersByTime(20);
    expect(config.onSubmit).toHaveBeenCalledTimes(2);
  });
});
