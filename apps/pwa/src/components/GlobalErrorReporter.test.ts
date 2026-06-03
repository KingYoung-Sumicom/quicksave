// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  createJavaScriptErrorReport,
  isIgnorableJavaScriptError,
  reportAsText,
  type JavaScriptErrorReport,
} from './GlobalErrorReporter';

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

  it('keeps DOMException-like rejection messages', () => {
    const error = new DOMException('media stopped', 'AbortError');

    const report = createJavaScriptErrorReport('unhandled-rejection', error);

    expect(report.message).toBe('media stopped');
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

describe('isIgnorableJavaScriptError', () => {
  it('ignores Firefox media abort promise rejections', () => {
    const reason = new DOMException(
      "The fetching process for the media resource was aborted by the user agent at the user's request.",
      'AbortError',
    );

    expect(isIgnorableJavaScriptError('unhandled-rejection', reason)).toBe(true);
  });

  it('does not ignore unrelated abort errors', () => {
    const reason = new DOMException('The operation was aborted.', 'AbortError');

    expect(isIgnorableJavaScriptError('unhandled-rejection', reason)).toBe(false);
  });

  it('does not ignore render errors with the same message', () => {
    const reason = "The fetching process for the media resource was aborted by the user agent at the user's request.";

    expect(isIgnorableJavaScriptError('react-render', reason)).toBe(false);
  });
});
