// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activateVoiceAudioContext } from './useVoiceStream';

function fakeContext(
  state: AudioContextState,
  resume: () => Promise<void>,
): AudioContext {
  return {
    state,
    resume,
    close: vi.fn(async () => undefined),
  } as unknown as AudioContext;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('activateVoiceAudioContext', () => {
  it('rebuilds the first AudioContext after an iOS-style background resume timeout', async () => {
    vi.useFakeTimers();
    const first = fakeContext('suspended', () => new Promise(() => undefined));
    const recovered = fakeContext('running', vi.fn(async () => undefined));
    const microphone = Promise.resolve({ getTracks: () => [] } as unknown as MediaStream);

    const activating = activateVoiceAudioContext(first, microphone, () => recovered);
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(activating).resolves.toEqual({
      context: recovered,
      recoveredAfterTimeout: true,
    });
    expect(first.close).toHaveBeenCalledOnce();
  });

  it('does not rebuild a context for non-timeout activation failures', async () => {
    const error = new DOMException('blocked', 'NotAllowedError');
    const first = fakeContext('suspended', vi.fn(async () => { throw error; }));
    const createContext = vi.fn();

    await expect(activateVoiceAudioContext(first, Promise.resolve({} as MediaStream), createContext))
      .rejects.toBe(error);
    expect(createContext).not.toHaveBeenCalled();
  });
});
