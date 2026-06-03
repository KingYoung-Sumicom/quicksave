// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { createJavaScriptErrorReport, reportAsText, type JavaScriptErrorReport } from './GlobalErrorReporter';

describe('createJavaScriptErrorReport', () => {
  it('keeps Error messages and stack traces', () => {
    const error = new Error('boom');
    error.stack = 'Error: boom\n    at test';

    const report = createJavaScriptErrorReport('window-error', error);

    expect(report.source).toBe('window-error');
    expect(report.message).toBe('boom');
    expect(report.stack).toBe(error.stack);
    expect(report.url).toBe(window.location.href);
    expect(report.userAgent).toBe(navigator.userAgent);
  });

  it('serializes non-Error promise rejection reasons', () => {
    const report = createJavaScriptErrorReport('unhandled-rejection', { code: 'E_FAIL' });

    expect(report.message).toContain('"code": "E_FAIL"');
  });
});

describe('reportAsText', () => {
  it('formats report metadata, stack, and component stack for copy/paste', () => {
    const report: JavaScriptErrorReport = {
      id: 'r1',
      source: 'react-render',
      message: 'render failed',
      stack: 'Error: render failed',
      componentStack: '\n    at BrokenComponent',
      timestamp: '2026-05-31T00:00:00.000Z',
      url: 'https://quicksave.dev/#/x',
      userAgent: 'TestAgent',
      appMode: 'test',
    };

    expect(reportAsText(report)).toBe([
      'Quicksave JavaScript error report',
      '',
      'Time: 2026-05-31T00:00:00.000Z',
      'Source: react-render',
      'URL: https://quicksave.dev/#/x',
      'App mode: test',
      'User agent: TestAgent',
      '',
      'Message:',
      'render failed',
      '',
      'Stack:',
      'Error: render failed',
      '',
      'React component stack:',
      'at BrokenComponent',
    ].join('\n'));
  });
});
