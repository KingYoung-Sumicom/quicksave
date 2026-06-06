// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { classifyIceCandidate } from './voiceStreamClient';

describe('classifyIceCandidate', () => {
  it('classifies host / srflx / relay / prflx from the typ field', () => {
    expect(classifyIceCandidate('candidate:1 1 udp 2113937151 192.168.1.5 54321 typ host')).toBe('host');
    expect(classifyIceCandidate('candidate:2 1 udp 1677729535 203.0.113.1 54321 typ srflx raddr 192.168.1.5 rport 54321')).toBe('srflx');
    expect(classifyIceCandidate('candidate:3 1 udp 41885439 198.51.100.7 3478 typ relay raddr 203.0.113.1 rport 54321')).toBe('relay');
    expect(classifyIceCandidate('candidate:4 1 udp 1 1.2.3.4 5 typ prflx')).toBe('prflx');
  });

  it('flags mDNS host candidates (*.local) — the Safari/iOS same-LAN signature', () => {
    // Even though typ is host, the .local hostname means it is mDNS-obscured.
    expect(classifyIceCandidate('candidate:1 1 udp 2113937151 9b36e1f2-0000.local 54321 typ host')).toBe('mdns');
  });

  it('returns unknown for empty/garbage', () => {
    expect(classifyIceCandidate('')).toBe('unknown');
    expect(classifyIceCandidate('not a candidate line')).toBe('unknown');
  });
});
