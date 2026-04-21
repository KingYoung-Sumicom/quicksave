import { useState } from 'react';
import { Spinner } from './ui/Spinner';
import { ErrorBox } from './ui/ErrorBox';
import { useIdentityStore } from '../stores/identityStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useMachineStore } from '../stores/machineStore';
import { SyncClient } from '../lib/syncClient';

export function DevicePairingSection() {
  const {
    publicKey,
    rotateIdentity,
  } = useIdentityStore();
  const { signalingServer } = useConnectionStore();

  // Rotate state
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotateSuccess, setRotateSuccess] = useState(false);
  const [copyLabel, setCopyLabel] = useState('Copy');

  if (!publicKey) return null;

  const truncatedKey = publicKey.length > 16
    ? `${publicKey.slice(0, 8)}...${publicKey.slice(-8)}`
    : publicKey;

  async function handleCopyKey() {
    try {
      await navigator.clipboard.writeText(publicKey!);
      setCopyLabel('Copied!');
      setTimeout(() => setCopyLabel('Copy'), 2000);
    } catch {
      setCopyLabel('Failed');
      setTimeout(() => setCopyLabel('Copy'), 2000);
    }
  }

  async function handleRotateIdentity() {
    setIsRotating(true);
    setRotateError(null);

    try {
      const result = await rotateIdentity();
      if (!result) {
        setRotateError('Failed to rotate identity');
        return;
      }

      // Post a signed tombstone to the old shared mailbox so any agent that
      // catches up discovers the rotation and self-destructs its pairing.
      try {
        const client = new SyncClient(signalingServer);
        await client.postTombstone(
          result.oldPublicKey,
          result.oldSigningSecretKey,
          result.oldSigningPublicKey,
        );
      } catch (err) {
        console.error('Failed to post tombstone:', err);
      }

      useMachineStore.getState().overwriteMachines([]);

      setShowRotateConfirm(false);
      setRotateSuccess(true);
      setTimeout(() => setRotateSuccess(false), 5000);
    } catch (err) {
      setRotateError(err instanceof Error ? err.message : 'Failed to rotate identity');
    } finally {
      setIsRotating(false);
    }
  }

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
        Group Identity
      </h3>
      <div className="space-y-4">

      {/* Shared Group Key */}
      <div className="space-y-2">
        <p className="text-sm text-slate-300">Group Public Key</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 px-3 py-2 bg-slate-700 rounded-md text-xs text-slate-300 font-mono truncate">
            {truncatedKey}
          </code>
          <button
            onClick={handleCopyKey}
            className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-md text-xs font-medium text-white transition-colors whitespace-nowrap"
          >
            {copyLabel}
          </button>
        </div>
        <p className="text-xs text-slate-500">
          Derived from your group&rsquo;s master secret. Every PWA paired into this group shares the same key.
        </p>
      </div>

      {/* Rotate Identity */}
      <div className="space-y-2 pt-2">
        {rotateSuccess && (
          <div className="p-2 bg-green-500/20 border border-green-500/50 rounded text-sm text-green-400">
            Identity rotated. Re-pair all other devices with the new QR.
          </div>
        )}
        {rotateError && (
          <ErrorBox>{rotateError}</ErrorBox>
        )}
        <button
          onClick={() => setShowRotateConfirm(true)}
          className="w-full py-2 px-3 bg-red-600/20 hover:bg-red-600/30 border border-red-600/50 rounded-md text-sm font-medium text-red-400 transition-colors"
        >
          Rotate Identity
        </button>
        <p className="text-xs text-slate-500">
          Generates a new master secret, seals the old mailbox with a tombstone, and wipes local machines. Every other PWA and every paired agent will need to re-pair.
        </p>
      </div>

      </div>

      {/* Rotate Confirmation Dialog */}
      {showRotateConfirm && (
        <>
          <div className="fixed inset-0 bg-black/50 z-[60]" onClick={() => setShowRotateConfirm(false)} />
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <div className="bg-slate-800 rounded-lg w-full max-w-sm shadow-xl border border-slate-700">
              <div className="p-4 space-y-4">
                <h3 className="text-lg font-semibold text-white">Rotate Identity?</h3>
                <p className="text-sm text-slate-400">
                  This generates a new master secret and permanently tombstones the current one.
                  All other PWAs in this group will stop syncing until you re-pair them, and every agent will auto-close its pairing.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowRotateConfirm(false)}
                    disabled={isRotating}
                    className="flex-1 py-2 px-4 bg-slate-700 hover:bg-slate-600 rounded-md font-medium text-white transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleRotateIdentity}
                    disabled={isRotating}
                    className="flex-1 py-2 px-4 bg-red-600 hover:bg-red-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors flex items-center justify-center gap-2"
                  >
                    {isRotating ? (
                      <>
                        <Spinner color="border-white" />
                        Rotating...
                      </>
                    ) : (
                      'Rotate'
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
