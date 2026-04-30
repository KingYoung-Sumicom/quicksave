// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { parseDeviceAuthOutput } from './codexLogin.js';

describe('parseDeviceAuthOutput', () => {
  it('returns null when no URL or code seen yet', () => {
    expect(parseDeviceAuthOutput('')).toBeNull();
    expect(parseDeviceAuthOutput('Welcome to Codex\n')).toBeNull();
    expect(parseDeviceAuthOutput('https://auth.openai.com/codex/device')).toBeNull();
  });

  it('extracts URL + code from the CLI intro banner', () => {
    const raw = [
      'Welcome to Codex [v0.118.0]',
      "OpenAI's command-line coding agent",
      '',
      'Follow these steps to sign in with ChatGPT using device code authorization:',
      '',
      '1. Open this link in your browser and sign in to your account',
      '   https://auth.openai.com/codex/device',
      '',
      '2. Enter this one-time code (expires in 15 minutes)',
      '   YKFF-30JQC',
      '',
    ].join('\n');

    expect(parseDeviceAuthOutput(raw)).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'YKFF-30JQC',
    });
  });

  it('strips ANSI colour escapes before matching', () => {
    // ESC sequences wrap the URL + code in the real CLI output (blue colour).
    const ESC = '\x1b';
    const raw = `   ${ESC}[94mhttps://auth.openai.com/codex/device${ESC}[0m\n   ${ESC}[94mABCD-1234${ESC}[0m\n`;
    expect(parseDeviceAuthOutput(raw)).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    });
  });

  it('ignores partial chunks and succeeds once both tokens are present', () => {
    // Simulate a streamed read where the URL arrives first, then the code.
    const part1 = '1. Open this link:\n   https://auth.openai.com/codex/device\n';
    const part2 = '2. Enter this code:\n   WXYZ-9876\n';
    expect(parseDeviceAuthOutput(part1)).toBeNull();
    expect(parseDeviceAuthOutput(part1 + part2)).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'WXYZ-9876',
    });
  });

  it('picks the first URL and first XXXX-XXXX token', () => {
    const raw = 'url1: https://example.com/a\nurl2: https://example.com/b\nAAAA-1111\nBBBB-2222\n';
    expect(parseDeviceAuthOutput(raw)).toEqual({
      verificationUrl: 'https://example.com/a',
      userCode: 'AAAA-1111',
    });
  });

  it('does not mistake arbitrary 4-alnum-dash-4-alnum tokens in prose', () => {
    // The URL must still be present; absent it, we return null regardless of
    // how many code-shaped tokens appear. Prevents a lone match in a
    // marketing string from fooling the modal into showing garbage.
    expect(parseDeviceAuthOutput('Our code scheme is FOO1-BAR2 in docs')).toBeNull();
  });
});
