// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { ErrorBox } from './ui/ErrorBox';
import { ConfirmModal } from './ui/ConfirmModal';
import { useIdentityStore } from '../stores/identityStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useMachineStore } from '../stores/machineStore';
import { SyncClient } from '../lib/syncClient';

export function DevicePairingSection() {
  const intl = useIntl();
  const { publicKey, rotateIdentity } = useIdentityStore();
  const { signalingServer } = useConnectionStore();

  const [showConfirm, setShowConfirm] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotateSuccess, setRotateSuccess] = useState(false);

  if (!publicKey) return null;

  async function handleRotateIdentity() {
    setIsRotating(true);
    setRotateError(null);

    try {
      const result = await rotateIdentity();
      if (!result) {
        setRotateError(intl.formatMessage({ id: 'settings.dangerZone.rotate.genericError' }));
        return;
      }

      // Seal the old shared mailbox with a signed tombstone so any agent that
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

      setShowConfirm(false);
      setRotateSuccess(true);
      setTimeout(() => setRotateSuccess(false), 5000);
    } catch (err) {
      setRotateError(
        err instanceof Error
          ? err.message
          : intl.formatMessage({ id: 'settings.dangerZone.rotate.genericError' }),
      );
    } finally {
      setIsRotating(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-white">
        <FormattedMessage id="settings.dangerZone.rotate.label" />
      </p>
      <p className="text-xs text-slate-400">
        <FormattedMessage id="settings.dangerZone.rotate.description" />
      </p>
      <div className="space-y-2 pt-1">
        {rotateSuccess && (
          <div className="p-2 bg-green-500/20 border border-green-500/50 rounded text-sm text-green-400">
            <FormattedMessage id="settings.dangerZone.rotate.success" />
          </div>
        )}
        {rotateError && <ErrorBox>{rotateError}</ErrorBox>}

        <button
          onClick={() => setShowConfirm(true)}
          className="w-full py-2 px-3 bg-red-600/20 hover:bg-red-600/30 border border-red-600/50 rounded-md text-sm font-medium text-red-400 transition-colors"
        >
          <FormattedMessage id="settings.dangerZone.rotate.button" />
        </button>
      </div>

      {showConfirm && (
        <ConfirmModal
          title={<FormattedMessage id="settings.dangerZone.rotate.confirm.title" />}
          message={<FormattedMessage id="settings.dangerZone.rotate.confirm.message" />}
          confirmLabel={
            isRotating
              ? <FormattedMessage id="settings.dangerZone.rotate.confirm.busyLabel" />
              : <FormattedMessage id="settings.dangerZone.rotate.button" />
          }
          confirmText="rotate"
          variant="danger"
          busy={isRotating}
          onConfirm={handleRotateIdentity}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}
