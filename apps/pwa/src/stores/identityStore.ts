import { create } from 'zustand';
import {
  generateKeyPair,
  generateSigningKeyPair,
  encodeKeyPair,
  decodeKeyPair,
  encodeBase64,
} from '@sumicom/quicksave-shared';
import type { PairedDevice } from '@sumicom/quicksave-shared';
import {
  getIdentityKeyPair,
  saveIdentityKeyPair,
  getSigningKeyPair,
  saveSigningKeyPair,
  clearIdentityKeys,
} from '../lib/secureStorage';

interface IdentityState {
  publicKey: string | null;
  isSource: boolean;
  pairedDevices: PairedDevice[];
  initialized: boolean;

  initialize: () => Promise<void>;
  addPairedDevice: (device: PairedDevice) => void;
  removePairedDevice: (publicKey: string) => void;
  setIsSource: (isSource: boolean) => void;
  getSecretKey: () => Promise<Uint8Array | null>;
  getSigningSecretKey: () => Promise<Uint8Array | null>;
  getSigningPublicKey: () => Promise<Uint8Array | null>;
  rotateIdentity: () => Promise<{ oldPublicKey: string; oldSigningSecretKey: Uint8Array } | null>;
  clearAll: () => Promise<void>;
}

export const useIdentityStore = create<IdentityState>((set) => ({
  publicKey: null,
  isSource: false,
  pairedDevices: [],
  initialized: false,

  initialize: async () => {
    let stored = await getIdentityKeyPair();
    if (!stored) {
      const keyPair = generateKeyPair();
      const encoded = encodeKeyPair(keyPair);
      await saveIdentityKeyPair(encoded);
      stored = encoded;

      const signingKeyPair = generateSigningKeyPair();
      const encodedSigning = encodeKeyPair(signingKeyPair);
      await saveSigningKeyPair(encodedSigning);
    }

    const savedDevices = localStorage.getItem('quicksave-paired-devices');
    const savedIsSource = localStorage.getItem('quicksave-is-source');

    set({
      publicKey: stored.publicKey,
      pairedDevices: savedDevices ? JSON.parse(savedDevices) : [],
      isSource: savedIsSource === 'true',
      initialized: true,
    });
  },

  addPairedDevice: (device) => {
    set((state) => {
      const updated = [...state.pairedDevices.filter(d => d.publicKey !== device.publicKey), device];
      localStorage.setItem('quicksave-paired-devices', JSON.stringify(updated));
      return { pairedDevices: updated };
    });
  },

  removePairedDevice: (publicKey) => {
    set((state) => {
      const updated = state.pairedDevices.filter(d => d.publicKey !== publicKey);
      localStorage.setItem('quicksave-paired-devices', JSON.stringify(updated));
      return { pairedDevices: updated };
    });
  },

  setIsSource: (isSource) => {
    localStorage.setItem('quicksave-is-source', String(isSource));
    set({ isSource });
  },

  getSecretKey: async () => {
    const stored = await getIdentityKeyPair();
    if (!stored) return null;
    const decoded = decodeKeyPair(stored);
    return decoded.secretKey;
  },

  getSigningSecretKey: async () => {
    const stored = await getSigningKeyPair();
    if (!stored) return null;
    const decoded = decodeKeyPair(stored);
    return decoded.secretKey;
  },

  getSigningPublicKey: async () => {
    const stored = await getSigningKeyPair();
    if (!stored) return null;
    const decoded = decodeKeyPair(stored);
    return decoded.publicKey;
  },

  rotateIdentity: async () => {
    const oldIdentity = await getIdentityKeyPair();
    const oldSigning = await getSigningKeyPair();
    if (!oldIdentity || !oldSigning) return null;

    const oldSigningDecoded = decodeKeyPair(oldSigning);

    const newKeyPair = generateKeyPair();
    const newSigning = generateSigningKeyPair();
    await saveIdentityKeyPair(encodeKeyPair(newKeyPair));
    await saveSigningKeyPair(encodeKeyPair(newSigning));

    set({
      publicKey: encodeBase64(newKeyPair.publicKey),
      pairedDevices: [],
      isSource: false,
    });
    localStorage.removeItem('quicksave-paired-devices');
    localStorage.removeItem('quicksave-is-source');

    return {
      oldPublicKey: oldIdentity.publicKey,
      oldSigningSecretKey: oldSigningDecoded.secretKey,
    };
  },

  clearAll: async () => {
    await clearIdentityKeys();
    localStorage.removeItem('quicksave-paired-devices');
    localStorage.removeItem('quicksave-is-source');
    set({
      publicKey: null,
      pairedDevices: [],
      isSource: false,
      initialized: false,
    });
  },
}));
