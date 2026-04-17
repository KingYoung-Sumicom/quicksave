import { useState, useMemo } from 'react';
import { Spinner } from './ui/Spinner';
import { ErrorBox } from './ui/ErrorBox';
import { useIdentityStore } from '../stores/identityStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useMachineStore } from '../stores/machineStore';
import { SyncClient } from '../lib/syncClient';
import { exportMasterSecret, getApiKey } from '../lib/secureStorage';

export function DevicePairingSection() {
  const {
    publicKey,
    isSource,
    pairedDevices,
    addPairedDevice,
    removePairedDevice,
    setIsSource,
    rotateIdentity,
    getSigningSecretKey,
  } = useIdentityStore();
  const { signalingServer } = useConnectionStore();
  const machines = useMachineStore((s) => s.machines);

  const syncClient = useMemo(() => new SyncClient(signalingServer), [signalingServer]);

  // Pairing state
  const [pairInput, setPairInput] = useState('');
  const [isPairing, setIsPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairSuccess, setPairSuccess] = useState(false);

  // Copy state
  const [copyLabel, setCopyLabel] = useState('Copy');

  // Rotate state
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotateSuccess, setRotateSuccess] = useState(false);

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

  async function handlePair() {
    const targetKey = pairInput.trim();
    if (!targetKey) {
      setPairError('Please enter a device public key');
      return;
    }
    if (targetKey === publicKey) {
      setPairError('Cannot pair with yourself');
      return;
    }
    if (pairedDevices.some(d => d.publicKey === targetKey)) {
      setPairError('This device is already paired');
      return;
    }

    setIsPairing(true);
    setPairError(null);
    setPairSuccess(false);

    try {
      // Add the target device as a paired device
      addPairedDevice({
        publicKey: targetKey,
        label: `Device ${pairedDevices.length + 1}`,
        pairedAt: Date.now(),
      });

      // Mark this device as source
      setIsSource(true);

      // Push initial sync to the new device
      const masterSecret = await exportMasterSecret();
      const apiKey = await getApiKey();
      const payload = {
        version: 2 as const,
        masterSecret,
        apiKey: apiKey || undefined,
        machines,
        exportedAt: new Date().toISOString(),
      };

      const result = await syncClient.pushToDevice(payload, targetKey);
      if (result === 'tombstone') {
        removePairedDevice(targetKey);
        setPairError('Target device has rotated its key. Ask them for their new key.');
        return;
      }

      setPairSuccess(true);
      setPairInput('');
      setTimeout(() => setPairSuccess(false), 3000);
    } catch (err) {
      setPairError(err instanceof Error ? err.message : 'Failed to pair');
    } finally {
      setIsPairing(false);
    }
  }

  async function handleRotateIdentity() {
    setIsRotating(true);
    setRotateError(null);

    try {
      // Get signing key before rotation
      const signingSecretKey = await getSigningSecretKey();

      // Rotate identity (generates new keys, wipes paired devices)
      const result = await rotateIdentity();
      if (!result) {
        setRotateError('Failed to rotate identity');
        return;
      }

      // Post tombstone to old mailbox so paired devices know
      if (signingSecretKey) {
        try {
          await syncClient.postTombstone(result.oldPublicKey, result.oldSigningSecretKey);
        } catch (err) {
          console.error('Failed to post tombstone:', err);
          // Not critical - identity is already rotated
        }
      }

      // Wipe machines
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
        Device Sync
      </h3>
      <div className="space-y-4">

      {/* My Identity */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-300">My Device Key</p>
          {isSource ? (
            <span className="text-xs text-blue-400 flex items-center gap-1">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              Source
            </span>
          ) : pairedDevices.length > 0 ? (
            <span className="text-xs text-green-400">Synced</span>
          ) : null}
        </div>

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
          Share this key with another device to receive synced data.
        </p>
      </div>

      {/* Pair with Device */}
      <div className="space-y-2">
        <label className="block text-sm text-slate-300">Pair with another device</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={pairInput}
            onChange={(e) => setPairInput(e.target.value)}
            placeholder="Paste device key..."
            className="flex-1 px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm font-mono"
            disabled={isPairing}
          />
          <button
            onClick={handlePair}
            disabled={isPairing || !pairInput.trim()}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md text-sm font-medium text-white transition-colors"
          >
            {isPairing ? 'Pairing...' : 'Pair'}
          </button>
        </div>
        <p className="text-xs text-slate-500">
          Paste the device key from the target device. This device will become the sync source.
        </p>

        {pairError && (
          <ErrorBox>{pairError}</ErrorBox>
        )}
        {pairSuccess && (
          <div className="p-2 bg-green-500/20 border border-green-500/50 rounded text-sm text-green-400">
            Device paired and synced successfully!
          </div>
        )}
      </div>

      {/* Paired Devices */}
      {pairedDevices.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-slate-300">Paired Devices</p>
          <div className="space-y-1">
            {pairedDevices.map((device) => (
              <div
                key={device.publicKey}
                className="flex items-center justify-between p-2 bg-slate-700/50 rounded-md"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-slate-300 font-mono truncate">
                    {device.publicKey.slice(0, 8)}...{device.publicKey.slice(-8)}
                  </p>
                  <p className="text-xs text-slate-500">
                    Paired {new Date(device.pairedAt).toLocaleDateString()}
                  </p>
                </div>
                <button
                  onClick={() => removePairedDevice(device.publicKey)}
                  className="ml-2 p-1 text-slate-400 hover:text-red-400 transition-colors"
                  title="Remove paired device"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Rotate Identity */}
      <div className="space-y-2 pt-2">
        {rotateSuccess && (
          <div className="p-2 bg-green-500/20 border border-green-500/50 rounded text-sm text-green-400">
            Identity rotated. Scan a trusted device to restore your data.
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
          Generates a new identity key. All paired devices and saved machines will be wiped.
        </p>
      </div>

      </div>{/* end scroll container */}

      {/* Rotate Confirmation Dialog */}
      {showRotateConfirm && (
        <>
          <div className="fixed inset-0 bg-black/50 z-[60]" onClick={() => setShowRotateConfirm(false)} />
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <div className="bg-slate-800 rounded-lg w-full max-w-sm shadow-xl border border-slate-700">
              <div className="p-4 space-y-4">
                <h3 className="text-lg font-semibold text-white">Rotate Identity?</h3>
                <p className="text-sm text-slate-400">
                  This will generate a new identity key and permanently invalidate the current one.
                  All paired devices and saved machines will be wiped.
                  You'll need to re-pair with a trusted device to restore your data.
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
