// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { Component, type ErrorInfo, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Modal } from './ui/Modal';

type CopyState = 'idle' | 'copied' | 'failed';

export interface JavaScriptErrorReport {
  id: string;
  source: 'window-error' | 'unhandled-rejection' | 'react-render';
  message: string;
  stack?: string;
  componentStack?: string;
  timestamp: string;
  url: string;
  userAgent: string;
  appMode: string;
}

interface GlobalErrorReporterProps {
  children: ReactNode;
}

interface ErrorBoundaryProps {
  onError: (error: unknown, componentStack?: string) => void;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError(error, info.componentStack ?? undefined);
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

export function createJavaScriptErrorReport(
  source: JavaScriptErrorReport['source'],
  error: unknown,
  componentStack?: string,
): JavaScriptErrorReport {
  const errorLike = normalizeError(error);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    source,
    message: errorLike.message,
    stack: errorLike.stack,
    componentStack,
    timestamp: new Date().toISOString(),
    url: window.location.href,
    userAgent: navigator.userAgent,
    appMode: import.meta.env.MODE,
  };
}

export function isIgnorableJavaScriptError(
  source: JavaScriptErrorReport['source'],
  error: unknown,
): boolean {
  if (source !== 'unhandled-rejection') return false;

  const { message } = normalizeError(error);
  const normalizedMessage = message.toLowerCase();

  return normalizedMessage.includes('fetching process for the media resource')
    && normalizedMessage.includes('aborted by the user agent');
}

export function reportAsText(report: JavaScriptErrorReport): string {
  const lines = [
    'Quicksave JavaScript error report',
    '',
    `Time: ${report.timestamp}`,
    `Source: ${report.source}`,
    `URL: ${report.url}`,
    `App mode: ${report.appMode}`,
    `User agent: ${report.userAgent}`,
    '',
    'Message:',
    report.message,
  ];

  if (report.stack) {
    lines.push('', 'Stack:', report.stack);
  }

  if (report.componentStack) {
    lines.push('', 'React component stack:', report.componentStack.trim());
  }

  return lines.join('\n');
}

export function GlobalErrorReporter({ children }: GlobalErrorReporterProps) {
  const [report, setReport] = useState<JavaScriptErrorReport | null>(null);

  const showReport = useCallback((
    source: JavaScriptErrorReport['source'],
    error: unknown,
    componentStack?: string,
  ) => {
    if (isIgnorableJavaScriptError(source, error)) return;

    const next = createJavaScriptErrorReport(source, error, componentStack);
    setReport(next);
  }, []);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      showReport('window-error', event.error ?? event.message);
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isIgnorableJavaScriptError('unhandled-rejection', event.reason)) {
        event.preventDefault();
        return;
      }
      showReport('unhandled-rejection', event.reason);
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, [showReport]);

  return (
    <>
      <ErrorBoundary onError={(error, componentStack) => showReport('react-render', error, componentStack)}>
        {children}
      </ErrorBoundary>
      {report && (
        <ErrorReportModal
          report={report}
          onClose={() => setReport(null)}
        />
      )}
    </>
  );
}

function ErrorReportModal({ report, onClose }: { report: JavaScriptErrorReport; onClose: () => void }) {
  const intl = useIntl();
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const reportText = useMemo(() => reportAsText(report), [report]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(reportText);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }, [reportText]);

  const copyLabelId =
    copyState === 'copied'
      ? 'errorReport.copy.copied'
      : copyState === 'failed'
        ? 'errorReport.copy.failed'
        : 'errorReport.copy';

  return (
    <Modal
      title={intl.formatMessage({ id: 'errorReport.title' })}
      onClose={onClose}
      maxWidth="max-w-2xl"
      backdropClose={false}
    >
      <div className="space-y-4 p-4">
        <p className="text-sm text-slate-300">
          <FormattedMessage id="errorReport.description" />
        </p>

        <div className="rounded-md border border-rose-500/30 bg-rose-950/30 p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-rose-300">
            <FormattedMessage id="errorReport.messageLabel" />
          </div>
          <div className="mt-1 break-words font-mono text-sm text-rose-100">
            {report.message}
          </div>
        </div>

        <textarea
          readOnly
          value={reportText}
          className="h-64 w-full resize-none rounded-md border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-200"
          onFocus={(event) => event.currentTarget.select()}
          aria-label={intl.formatMessage({ id: 'errorReport.textAreaLabel' })}
        />

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-700 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700"
          >
            <FormattedMessage id="errorReport.close" />
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500"
          >
            <FormattedMessage id={copyLabelId} />
          </button>
        </div>
      </div>
    </Modal>
  );
}

function normalizeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message || error.name,
      stack: error.stack,
    };
  }

  if (typeof error === 'string') {
    return { message: error };
  }

  if (error && typeof error === 'object') {
    const errorLike = error as { message?: unknown; name?: unknown; stack?: unknown };
    const message = typeof errorLike.message === 'string'
      ? errorLike.message
      : typeof errorLike.name === 'string'
        ? errorLike.name
        : null;

    if (message) {
      return {
        message,
        stack: typeof errorLike.stack === 'string' ? errorLike.stack : undefined,
      };
    }
  }

  try {
    return { message: JSON.stringify(error, null, 2) ?? String(error) };
  } catch {
    return { message: String(error) };
  }
}
