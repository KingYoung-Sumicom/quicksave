// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Modal } from '../ui/Modal';
import { Spinner } from '../ui/Spinner';
import { useCodexLogin } from '../../hooks/useCodexLogin';

/**
 * Inline banner that invites the user to connect their Codex account when
 * the daemon has no credentials. Clicking the button opens the device-auth
 * modal which walks the user through the OAuth flow on whatever device
 * they have at hand.
 */
export function CodexLoginBanner() {
  const [open, setOpen] = useState(false);
  const { loginState } = useCodexLogin();

  // Once login completes we dismiss the modal automatically (the effect
  // inside CodexLoginModal closes itself; we keep the banner hidden too).
  if (loginState?.loggedIn) return null;

  return (
    <>
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100 flex items-start gap-2">
        <svg className="w-4 h-4 shrink-0 text-amber-300 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <div className="flex-1 min-w-0 space-y-1.5">
          <p className="font-medium text-amber-100">
            <FormattedMessage id="codexLogin.banner.title" />
          </p>
          <p className="text-amber-200/80">
            <FormattedMessage id="codexLogin.banner.body" />
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 px-2.5 py-1 text-xs font-medium text-amber-50 transition-colors"
          >
            <FormattedMessage id="codexLogin.banner.button" />
          </button>
        </div>
      </div>
      {open && <CodexLoginModal onClose={() => setOpen(false)} />}
    </>
  );
}

function CodexLoginModal({ onClose }: { onClose: () => void }) {
  const intl = useIntl();
  const { loginState, start, cancel, refreshModels } = useCodexLogin();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Kick off the device-auth spawn as soon as the modal opens — unless the
  // daemon already has an in-progress attempt we can reuse.
  useEffect(() => {
    if (loginState?.inProgress && loginState.userCode) return;
    if (loginState?.loggedIn) return;
    let cancelled = false;
    (async () => {
      setStarting(true);
      setStartError(null);
      try {
        const res = await start();
        if (cancelled) return;
        if (!res) setStartError('Not connected to agent');
        else if (!res.userCode && !res.loggedIn) {
          setStartError(res.error || 'Failed to obtain a device code');
        }
      } catch (err) {
        if (!cancelled) setStartError(err instanceof Error ? err.message : 'Login failed');
      } finally {
        if (!cancelled) setStarting(false);
      }
    })();
    return () => { cancelled = true; };
    // Only on mount — subsequent state arrives via the bus subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When login completes, pull the fresh model list and close.
  useEffect(() => {
    if (loginState?.loggedIn) {
      refreshModels().catch(() => {});
      const t = setTimeout(onClose, 600);
      return () => clearTimeout(t);
    }
  }, [loginState?.loggedIn, refreshModels, onClose]);

  const handleClose = () => {
    // If the user dismisses mid-flow, tell the daemon to stop waiting.
    if (loginState?.inProgress && !loginState.loggedIn) {
      cancel().catch(() => {});
    }
    onClose();
  };

  const handleCopyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked in some contexts — swallow, user can long-press.
    }
  };

  const code = loginState?.userCode;
  const url = loginState?.verificationUrl;
  const expiresAt = loginState?.expiresAt;

  return (
    <Modal
      title={intl.formatMessage({ id: 'codexLogin.modal.title' })}
      onClose={handleClose}
      backdropClose={false}
    >
      <div className="p-4 space-y-4 text-sm">
        {loginState?.loggedIn ? (
          <div className="text-emerald-300 flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <FormattedMessage id="codexLogin.modal.success" />
          </div>
        ) : startError ? (
          <div className="space-y-3">
            <div className="text-rose-300">{startError}</div>
            <button
              type="button"
              onClick={() => { setStartError(null); start().catch((e) => setStartError(e.message)); }}
              className="rounded-md border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-700"
            >
              <FormattedMessage id="codexLogin.modal.retry" />
            </button>
          </div>
        ) : starting && !code ? (
          <div className="flex items-center gap-2 text-slate-300">
            <Spinner size="w-4 h-4" />
            <FormattedMessage id="codexLogin.modal.starting" />
          </div>
        ) : url && code ? (
          <>
            <p className="text-slate-300">
              <FormattedMessage id="codexLogin.modal.instructions" />
            </p>

            <ol className="space-y-3 pl-4 list-decimal text-slate-200">
              <li className="space-y-1.5">
                <div>
                  <FormattedMessage id="codexLogin.modal.step1" />
                </div>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block break-all rounded-md border border-slate-600 bg-slate-900 px-2.5 py-1.5 font-mono text-xs text-blue-300 hover:text-blue-200 hover:border-blue-500/60"
                >
                  {url}
                </a>
              </li>
              <li className="space-y-1.5">
                <div>
                  <FormattedMessage id="codexLogin.modal.step2" />
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-lg font-mono tracking-wider text-slate-100 text-center">
                    {code}
                  </code>
                  <button
                    type="button"
                    onClick={() => handleCopyCode(code)}
                    className="rounded-md border border-slate-600 px-2.5 py-2 text-xs hover:bg-slate-700 min-w-[56px]"
                  >
                    {copied
                      ? intl.formatMessage({ id: 'codexLogin.modal.copied' })
                      : intl.formatMessage({ id: 'codexLogin.modal.copy' })}
                  </button>
                </div>
                {expiresAt && (
                  <CountdownText expiresAt={expiresAt} />
                )}
              </li>
            </ol>

            <div className="flex items-center gap-2 pt-1 text-xs text-slate-400">
              <Spinner size="w-4 h-4" />
              <FormattedMessage id="codexLogin.modal.waiting" />
            </div>
          </>
        ) : (
          <div className="text-slate-400">
            <FormattedMessage id="codexLogin.modal.preparing" />
          </div>
        )}

        <div className="flex justify-end pt-2 border-t border-slate-700">
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
          >
            {loginState?.loggedIn
              ? intl.formatMessage({ id: 'codexLogin.modal.close' })
              : intl.formatMessage({ id: 'codexLogin.modal.cancel' })}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CountdownText({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const msLeft = Math.max(0, expiresAt - now);
  const mins = Math.floor(msLeft / 60_000);
  const secs = Math.floor((msLeft % 60_000) / 1000);
  return (
    <p className="text-[11px] text-slate-500">
      <FormattedMessage
        id="codexLogin.modal.expiresIn"
        values={{ mins, secs: String(secs).padStart(2, '0') }}
      />
    </p>
  );
}
