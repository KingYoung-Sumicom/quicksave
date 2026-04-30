// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState } from 'react';
import { FormattedMessage, useIntl, type IntlShape } from 'react-intl';
import { useNavigate } from 'react-router-dom';
import { Html5Qrcode } from 'html5-qrcode';
import { Modal } from './ui/Modal';
import { ErrorBox } from './ui/ErrorBox';
import { Spinner } from './ui/Spinner';
import { parsePairUrl } from '../lib/pairClient';

interface ScanToJoinModalProps {
  onClose: () => void;
}

type Phase = 'starting' | 'scanning' | 'matched' | 'error';

const SCANNER_ELEMENT_ID = 'pair-qr-scanner';

export function ScanToJoinModal({ onClose }: ScanToJoinModalProps) {
  const intl = useIntl();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>('starting');
  const [error, setError] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const qr = new Html5Qrcode(SCANNER_ELEMENT_ID, { verbose: false });
    scannerRef.current = qr;

    (async () => {
      try {
        await qr.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            // No qrbox — scan whole frame; we draw our own square overlay in CSS
            // because html5-qrcode's built-in overlay gets distorted when its
            // logical pixel basis (video track) differs from the rendered size.
          },
          (decodedText) => {
            if (handledRef.current) return;
            let kB64: string;
            try {
              const parsed = parsePairUrl(decodedText);
              kB64 = parsed.eA_pubB64;
            } catch {
              return;
            }
            handledRef.current = true;
            setPhase('matched');
            const urlSafe = kB64
              .replace(/\+/g, '-')
              .replace(/\//g, '_')
              .replace(/=+$/, '');
            void stopScanner().finally(() => {
              navigate(`/pair?k=${urlSafe}`);
            });
          },
          () => {
            // per-frame decode failures are noisy & expected — ignore
          },
        );
        // Capture a direct MediaStream reference so we can always release
        // tracks in cleanup even if html5-qrcode's internal teardown fails
        // or the DOM node is unmounted before we get to it.
        const videoEl = document
          .getElementById(SCANNER_ELEMENT_ID)
          ?.querySelector('video') as HTMLVideoElement | null;
        if (videoEl?.srcObject instanceof MediaStream) {
          streamRef.current = videoEl.srcObject;
        }
        if (cancelled) {
          await stopScanner();
          return;
        }
        setPhase('scanning');
      } catch (e) {
        if (!cancelled) {
          setError(friendlyCameraError(e, intl));
          setPhase('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      void stopScanner();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopScanner = async () => {
    // Step 1: release MediaStream tracks directly. This works even if the
    // scanner container has already been removed from the DOM by React.
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          // ignore
        }
      });
    }

    // Step 2: tear down html5-qrcode's internal state.
    const qr = scannerRef.current;
    scannerRef.current = null;
    if (qr) {
      try {
        if (qr.isScanning) await qr.stop();
        qr.clear();
      } catch {
        // ignore teardown errors
      }
    }

    // Step 3: safety net — any remaining <video> nodes still attached to a
    // stream get force-released.
    const el = document.getElementById(SCANNER_ELEMENT_ID);
    if (el) {
      el.querySelectorAll('video').forEach((v) => {
        const s = v.srcObject as MediaStream | null;
        if (s) {
          s.getTracks().forEach((t) => t.stop());
          v.srcObject = null;
        }
      });
    }
  };

  return (
    <Modal
      title={intl.formatMessage({ id: 'pair.scan.title' })}
      onClose={onClose}
      maxWidth="max-w-lg"
      backdropClose={false}
    >
      <style>{`
        #${SCANNER_ELEMENT_ID} { position: relative; }
        #${SCANNER_ELEMENT_ID} video {
          width: 100% !important;
          height: 100% !important;
          object-fit: cover !important;
          display: block;
        }
        #${SCANNER_ELEMENT_ID} > div {
          width: 100% !important;
          height: 100% !important;
        }
      `}</style>
      <div className="p-4 space-y-4">
        <p className="text-sm text-slate-400">
          <FormattedMessage id="pair.scan.instructions" />
        </p>

        <div className="relative w-full aspect-square max-w-sm mx-auto bg-slate-900 rounded-md overflow-hidden">
          <div
            id={SCANNER_ELEMENT_ID}
            className="absolute inset-0"
          />
          {/* Custom square reticle overlay — not dependent on video track dims */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="relative w-3/4 aspect-square">
              <div className="absolute top-0 left-0 w-8 h-8 border-t-[3px] border-l-[3px] border-white rounded-tl-sm" />
              <div className="absolute top-0 right-0 w-8 h-8 border-t-[3px] border-r-[3px] border-white rounded-tr-sm" />
              <div className="absolute bottom-0 left-0 w-8 h-8 border-b-[3px] border-l-[3px] border-white rounded-bl-sm" />
              <div className="absolute bottom-0 right-0 w-8 h-8 border-b-[3px] border-r-[3px] border-white rounded-br-sm" />
            </div>
          </div>
        </div>

        {phase === 'starting' && (
          <div className="flex items-center gap-2 text-slate-400 text-sm">
            <Spinner color="border-blue-500" /> <FormattedMessage id="pair.scan.starting" />
          </div>
        )}

        {phase === 'scanning' && (
          <div className="text-xs text-slate-500 text-center">
            <FormattedMessage id="pair.scan.scanning" />
          </div>
        )}

        {phase === 'matched' && (
          <div className="text-sm text-emerald-400 flex items-center gap-2">
            <Spinner color="border-emerald-500" /> <FormattedMessage id="pair.scan.matched" />
          </div>
        )}

        {phase === 'error' && error && <ErrorBox>{error}</ErrorBox>}

        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm bg-slate-700 hover:bg-slate-600 rounded-md"
          >
            <FormattedMessage id="pair.scan.cancel" />
          </button>
        </div>
      </div>
    </Modal>
  );
}

function friendlyCameraError(e: unknown, intl: IntlShape): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/permission|denied|NotAllowed/i.test(msg)) {
    return intl.formatMessage({ id: 'pair.scan.error.permission' });
  }
  if (/NotFound|no camera/i.test(msg)) {
    return intl.formatMessage({ id: 'pair.scan.error.notFound' });
  }
  if (/secure|https/i.test(msg)) {
    return intl.formatMessage({ id: 'pair.scan.error.https' });
  }
  return intl.formatMessage({ id: 'pair.scan.error.generic' }, { message: msg });
}
