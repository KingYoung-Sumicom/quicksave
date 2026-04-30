// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { encodeBase64 } from '@sumicom/quicksave-shared';
import { ErrorBox } from '../components/ui/ErrorBox';
import { Spinner } from '../components/ui/Spinner';
import {
  PairClient,
  type PairJoinHandle,
} from '../lib/pairClient';
import { getDefaultPairTransport } from '../lib/pairTransport';
import { applyMasterSecret } from '../lib/secureStorage';

type Phase = 'parsing' | 'waiting' | 'received' | 'error';

export function JoinGroupPage() {
  const intl = useIntl();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [phase, setPhase] = useState<Phase>('parsing');
  const [error, setError] = useState<string | null>(null);
  const [sas, setSas] = useState('');
  const [sasRemainingMs, setSasRemainingMs] = useState(0);

  const joinRef = useRef<PairJoinHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const k = params.get('k');
        if (!k) throw new Error(intl.formatMessage({ id: 'join.error.missingK' }));
        const transport = getDefaultPairTransport();
        const client = new PairClient(transport);
        const join = await client.acceptInvite({ eA_pubB64: fromUrlSafe(k) });
        if (cancelled) {
          await join.cancel();
          return;
        }
        joinRef.current = join;
        setSas(join.sas);

        join.onSecret(async (masterSecret) => {
          try {
            const value = encodeBase64(masterSecret);
            await applyMasterSecret(value, Date.now());
            setPhase('received');
          } catch (e) {
            setError((e as Error).message);
            setPhase('error');
          }
        });

        setPhase('waiting');
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
      const j = joinRef.current;
      joinRef.current = null;
      if (j) void j.cancel();
    };
  }, [params]);

  useEffect(() => {
    const j = joinRef.current;
    if (!j || phase !== 'waiting') return;
    const tick = () =>
      setSasRemainingMs(Math.max(0, j.sasExpiresAt - Date.now()));
    tick();
    const h = setInterval(tick, 500);
    return () => clearInterval(h);
  }, [phase]);

  return (
    <div className="min-h-full flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-slate-800 rounded-lg border border-slate-700 p-6 space-y-4">
        <h1 className="text-lg font-semibold">
          <FormattedMessage id="join.title" />
        </h1>

        {phase === 'parsing' && (
          <div className="flex items-center gap-2 text-slate-400">
            <Spinner color="border-blue-500" /> <FormattedMessage id="join.parsing" />
          </div>
        )}

        {phase === 'waiting' && (
          <>
            <p className="text-sm text-slate-400">
              <FormattedMessage id="join.waiting.prompt" />
            </p>
            <div className="bg-slate-900 border border-slate-700 rounded-md py-6 text-center font-mono text-5xl tracking-[0.35em]">
              {sas}
            </div>
            <div className="text-xs text-slate-500 text-right">
              <FormattedMessage
                id="join.waiting.sasRemaining"
                values={{ seconds: Math.ceil(sasRemainingMs / 1000) }}
              />
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Spinner /> <FormattedMessage id="join.waiting.waitingConfirmation" />
            </div>
            <button
              type="button"
              onClick={async () => {
                const j = joinRef.current;
                joinRef.current = null;
                if (j) await j.cancel();
                navigate('/', { replace: true });
              }}
              className="w-full py-2 px-4 text-sm bg-slate-700 hover:bg-slate-600 rounded-md"
            >
              <FormattedMessage id="join.waiting.cancel" />
            </button>
          </>
        )}

        {phase === 'received' && (
          <div className="space-y-3">
            <div className="p-3 bg-emerald-500/20 border border-emerald-500/50 rounded text-emerald-300 text-sm">
              <FormattedMessage id="join.received.success" />
            </div>
            <button
              type="button"
              onClick={() => navigate('/', { replace: true })}
              className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 rounded-md font-medium"
            >
              <FormattedMessage id="join.received.goHome" />
            </button>
          </div>
        )}

        {phase === 'error' && error && (
          <div className="space-y-3">
            <ErrorBox>{error}</ErrorBox>
            <button
              type="button"
              onClick={() => navigate('/', { replace: true })}
              className="w-full py-2 px-4 bg-slate-700 hover:bg-slate-600 rounded-md text-sm"
            >
              <FormattedMessage id="join.error.goHome" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function fromUrlSafe(b64url: string): string {
  const pad = b64url.length % 4 === 0 ? '' : '='.repeat(4 - (b64url.length % 4));
  return b64url.replace(/-/g, '+').replace(/_/g, '/') + pad;
}
