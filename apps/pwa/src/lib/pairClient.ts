import {
  encodeBase64,
  decodeBase64,
  generateKeyPair,
  encryptSyncBlob,
  decryptSyncBlob,
  sasBucket,
  sasCompute,
} from '@sumicom/quicksave-shared';

export interface PairSlot {
  id: string;
  data: string;
  kind?: string;
  createdAt: number;
}

export interface PairTransport {
  postSlot(
    addr: string,
    slot: { data: string; kind?: string },
  ): Promise<{ id: string }>;
  getSlots(addr: string): Promise<PairSlot[]>;
  deleteMailbox(addr: string): Promise<void>;
  subscribeToMailbox(
    addr: string,
    onSlot: (slot: PairSlot) => void,
  ): () => void;
}

export interface Candidate {
  slotId: string;
  eB_pub: Uint8Array;
  eB_pubB64: string;
  ts: number;
}

export type SubmitSasResult =
  | { status: 'sent'; matched: Candidate }
  | { status: 'no-match' }
  | { status: 'collision'; matches: Candidate[] };

export interface CreateInviteOptions {
  baseUrl: string;
  masterSecret: Uint8Array;
  ttlMs?: number;
  sasWindowMs?: number;
  sasChars?: number;
  now?: () => number;
}

export interface PairInviteHandle {
  readonly pairUrl: string;
  readonly qrData: string;
  readonly eA_pubB64: string;
  readonly addr: string;
  readonly expiresAt: number;
  onCandidate(listener: (c: Candidate) => void): () => void;
  submitSAS(typedSas: string): Promise<SubmitSasResult>;
  cancel(): Promise<void>;
}

export interface AcceptInviteOptions {
  pairUrl?: string;
  eA_pubB64?: string;
  sasWindowMs?: number;
  sasChars?: number;
  now?: () => number;
}

export interface PairJoinHandle {
  readonly eA_pubB64: string;
  readonly addr: string;
  readonly eB_pubB64: string;
  readonly sas: string;
  readonly bucket: number;
  readonly sasExpiresAt: number;
  onSecret(listener: (masterSecret: Uint8Array) => void): () => void;
  cancel(): Promise<void>;
}

const PAIR_URL_PATH = '/pair';
// PWA uses react-router HashRouter, so the route lives inside the fragment.
// Full URL format: https://host/#/pair?k=<base64url(eA_pub)>
// k= stays within the fragment, so the server never sees the pubkey.
const PAIR_URL_FRAGMENT_PREFIX = `/#${PAIR_URL_PATH}`;
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_SAS_WINDOW_MS = 60_000;
const DEFAULT_SAS_CHARS = 6;
const SLOT_KIND_JOIN = 'join';
const SLOT_KIND_SECRET = 'secret';
const MAX_SLOTS = 64;

function toUrlSafe(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromUrlSafe(b64url: string): string {
  const pad = b64url.length % 4 === 0 ? '' : '='.repeat(4 - (b64url.length % 4));
  return b64url.replace(/-/g, '+').replace(/_/g, '/') + pad;
}

/**
 * Address of a pair mailbox — base64url of the ephemeral pubkey.
 * The 256-bit entropy of the pubkey doubles as unguessable routing.
 */
export function pairAddrFromPubkey(pubkeyB64: string): string {
  return toUrlSafe(pubkeyB64);
}

export function buildPairUrl(baseUrl: string, eA_pubB64: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}${PAIR_URL_FRAGMENT_PREFIX}?k=${toUrlSafe(eA_pubB64)}`;
}

export function parsePairUrl(pairUrl: string): { eA_pubB64: string } {
  const hashIdx = pairUrl.indexOf('#');
  if (hashIdx < 0) throw new Error('pair URL missing fragment');
  const frag = pairUrl.slice(hashIdx + 1);
  if (frag.length === 0) throw new Error('pair URL fragment is empty');
  // Accept either "k=..." (raw) or "/pair?k=..." (HashRouter) forms.
  const queryIdx = frag.indexOf('?');
  const queryStr = queryIdx >= 0 ? frag.slice(queryIdx + 1) : frag;
  const params = new URLSearchParams(queryStr);
  const k = params.get('k');
  if (!k) throw new Error('pair URL fragment missing k=');
  return { eA_pubB64: fromUrlSafe(k) };
}

export class PairClient {
  constructor(private readonly transport: PairTransport) {}

  async createInvite(options: CreateInviteOptions): Promise<PairInviteHandle> {
    const now = options.now ?? Date.now;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const windowMs = options.sasWindowMs ?? DEFAULT_SAS_WINDOW_MS;
    const chars = options.sasChars ?? DEFAULT_SAS_CHARS;
    const masterSecret = options.masterSecret;
    if (masterSecret.length !== 32) {
      throw new Error('masterSecret must be 32 bytes');
    }

    const ephemeral = generateKeyPair();
    const eA_pubB64 = encodeBase64(ephemeral.publicKey);
    const addr = pairAddrFromPubkey(eA_pubB64);
    const pairUrl = buildPairUrl(options.baseUrl, eA_pubB64);
    const expiresAt = now() + ttlMs;

    const seenSlotIds = new Set<string>();
    const candidates: Candidate[] = [];
    const candidateListeners = new Set<(c: Candidate) => void>();
    const ingestSlot = (slot: PairSlot) => {
      if (seenSlotIds.has(slot.id)) return;
      if (slot.kind !== SLOT_KIND_JOIN) return;
      seenSlotIds.add(slot.id);
      let eB_pubB64: string;
      let ts: number;
      try {
        const plaintext = decryptSyncBlob(slot.data, ephemeral.secretKey);
        const parsed = JSON.parse(plaintext) as { eB_pub?: string; ts?: number };
        if (!parsed.eB_pub || typeof parsed.eB_pub !== 'string') return;
        eB_pubB64 = parsed.eB_pub;
        ts = typeof parsed.ts === 'number' ? parsed.ts : 0;
      } catch {
        return;
      }
      let eB_pub: Uint8Array;
      try {
        eB_pub = decodeBase64(eB_pubB64);
      } catch {
        return;
      }
      if (eB_pub.length !== 32) return;
      const candidate: Candidate = {
        slotId: slot.id,
        eB_pub,
        eB_pubB64,
        ts,
      };
      candidates.push(candidate);
      for (const fn of candidateListeners) fn(candidate);
    };

    const unsubscribe = this.transport.subscribeToMailbox(addr, ingestSlot);

    const existing = await this.transport.getSlots(addr);
    for (const slot of existing) ingestSlot(slot);

    let cancelled = false;
    const cancel = async () => {
      if (cancelled) return;
      cancelled = true;
      unsubscribe();
      try {
        await this.transport.deleteMailbox(addr);
      } catch {
        // best-effort
      }
    };

    const submitSAS = async (typedSas: string): Promise<SubmitSasResult> => {
      const normalized = typedSas.trim().toUpperCase();
      if (normalized.length !== chars) {
        return { status: 'no-match' };
      }
      const t = now();
      const buckets = [
        sasBucket(t - windowMs, windowMs),
        sasBucket(t, windowMs),
        sasBucket(t + windowMs, windowMs),
      ];
      const matches: Candidate[] = [];
      for (const c of candidates) {
        const expected = buckets.map((b) =>
          sasCompute(c.eB_pub, b, chars),
        );
        if (expected.includes(normalized)) matches.push(c);
      }
      if (matches.length === 0) return { status: 'no-match' };
      if (matches.length > 1) return { status: 'collision', matches };

      const matched = matches[0];
      const payload = JSON.stringify({
        masterSecret: encodeBase64(masterSecret),
      });
      const sealed = encryptSyncBlob(payload, matched.eB_pub);
      await this.transport.postSlot(addr, {
        data: sealed,
        kind: SLOT_KIND_SECRET,
      });
      return { status: 'sent', matched };
    };

    return {
      pairUrl,
      qrData: pairUrl,
      eA_pubB64,
      addr,
      expiresAt,
      onCandidate(listener) {
        candidateListeners.add(listener);
        return () => candidateListeners.delete(listener);
      },
      submitSAS,
      cancel,
    };
  }

  async acceptInvite(options: AcceptInviteOptions): Promise<PairJoinHandle> {
    const now = options.now ?? Date.now;
    const windowMs = options.sasWindowMs ?? DEFAULT_SAS_WINDOW_MS;
    const chars = options.sasChars ?? DEFAULT_SAS_CHARS;
    let eA_pubB64 = options.eA_pubB64;
    if (!eA_pubB64 && options.pairUrl) {
      eA_pubB64 = parsePairUrl(options.pairUrl).eA_pubB64;
    }
    if (!eA_pubB64) {
      throw new Error('acceptInvite requires pairUrl or eA_pubB64');
    }
    const eA_pub = decodeBase64(eA_pubB64);
    if (eA_pub.length !== 32) {
      throw new Error('eA_pub must decode to 32 bytes');
    }
    const addr = pairAddrFromPubkey(eA_pubB64);

    const ephemeral = generateKeyPair();
    const eB_pubB64 = encodeBase64(ephemeral.publicKey);

    const bucket = sasBucket(now(), windowMs);
    const sas = sasCompute(ephemeral.publicKey, bucket, chars);
    const sasExpiresAt = (bucket + 1) * windowMs;

    const secretListeners = new Set<(s: Uint8Array) => void>();
    const seenSlotIds = new Set<string>();
    const tryIngestSecret = (slot: PairSlot) => {
      if (seenSlotIds.has(slot.id)) return;
      if (slot.kind !== SLOT_KIND_SECRET) return;
      seenSlotIds.add(slot.id);
      try {
        const plaintext = decryptSyncBlob(slot.data, ephemeral.secretKey);
        const parsed = JSON.parse(plaintext) as { masterSecret?: string };
        if (!parsed.masterSecret) return;
        const masterSecret = decodeBase64(parsed.masterSecret);
        if (masterSecret.length !== 32) return;
        for (const fn of secretListeners) fn(masterSecret);
      } catch {
        // not for us — either from a competing join or noise
      }
    };

    const unsubscribe = this.transport.subscribeToMailbox(addr, tryIngestSecret);

    const joinPayload = JSON.stringify({
      eB_pub: eB_pubB64,
      ts: now(),
    });
    const sealed = encryptSyncBlob(joinPayload, eA_pub);
    await this.transport.postSlot(addr, {
      data: sealed,
      kind: SLOT_KIND_JOIN,
    });

    const existing = await this.transport.getSlots(addr);
    for (const slot of existing) tryIngestSecret(slot);

    let cancelled = false;
    const cancel = async () => {
      if (cancelled) return;
      cancelled = true;
      unsubscribe();
    };

    return {
      eA_pubB64,
      addr,
      eB_pubB64,
      sas,
      bucket,
      sasExpiresAt,
      onSecret(listener) {
        secretListeners.add(listener);
        return () => secretListeners.delete(listener);
      },
      cancel,
    };
  }
}

// ============================================================================
// MockRelay — singleton in-memory transport, optional BroadcastChannel sync.
// ============================================================================

interface MockMailbox {
  slots: PairSlot[];
  expiresAt: number;
  listeners: Set<(slot: PairSlot) => void>;
}

type BcastMsg =
  | { kind: 'slot'; addr: string; slot: PairSlot; expiresAt: number }
  | { kind: 'delete'; addr: string };

const BCAST_NAME = 'quicksave-mock-pair-relay';

export class MockRelay implements PairTransport {
  private mailboxes = new Map<string, MockMailbox>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private bc: BroadcastChannel | null;
  private nextId = 1;
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: {
    ttlMs?: number;
    now?: () => number;
    useBroadcastChannel?: boolean;
  } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.bc = null;
    const wantBc = options.useBroadcastChannel ?? true;
    if (wantBc && typeof BroadcastChannel !== 'undefined') {
      try {
        this.bc = new BroadcastChannel(BCAST_NAME);
        this.bc.onmessage = (ev) => this.onBcast(ev.data as BcastMsg);
      } catch {
        this.bc = null;
      }
    }
  }

  private onBcast(msg: BcastMsg) {
    if (msg.kind === 'slot') {
      const mb = this.ensureMailbox(msg.addr, msg.expiresAt);
      if (mb.slots.some((s) => s.id === msg.slot.id)) return;
      mb.slots.push(msg.slot);
      for (const fn of mb.listeners) fn(msg.slot);
    } else if (msg.kind === 'delete') {
      const mb = this.mailboxes.get(msg.addr);
      if (!mb) return;
      mb.slots = [];
      this.mailboxes.delete(msg.addr);
    }
  }

  private ensureMailbox(addr: string, expiresAt: number): MockMailbox {
    let mb = this.mailboxes.get(addr);
    if (!mb) {
      mb = { slots: [], expiresAt, listeners: new Set() };
      this.mailboxes.set(addr, mb);
    }
    return mb;
  }

  private gc() {
    const t = this.now();
    for (const [addr, mb] of this.mailboxes) {
      if (mb.expiresAt <= t) {
        this.mailboxes.delete(addr);
      }
    }
  }

  startGc(intervalMs = 30_000) {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => this.gc(), intervalMs);
  }

  stopGc() {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  close() {
    this.stopGc();
    if (this.bc) {
      this.bc.close();
      this.bc = null;
    }
    this.mailboxes.clear();
  }

  async postSlot(
    addr: string,
    slot: { data: string; kind?: string },
  ): Promise<{ id: string }> {
    this.gc();
    const t = this.now();
    const expiresAt = t + this.ttlMs;
    const mb = this.ensureMailbox(addr, expiresAt);
    if (mb.slots.length >= MAX_SLOTS) {
      throw new Error('mailbox full');
    }
    const id = `m-${this.nextId++}-${t}`;
    const newSlot: PairSlot = {
      id,
      data: slot.data,
      kind: slot.kind,
      createdAt: t,
    };
    mb.slots.push(newSlot);
    for (const fn of mb.listeners) fn(newSlot);
    if (this.bc) {
      try {
        this.bc.postMessage({
          kind: 'slot',
          addr,
          slot: newSlot,
          expiresAt: mb.expiresAt,
        } satisfies BcastMsg);
      } catch {
        // postMessage may throw on clone errors; slot is already local
      }
    }
    return { id };
  }

  async getSlots(addr: string): Promise<PairSlot[]> {
    this.gc();
    const mb = this.mailboxes.get(addr);
    if (!mb) return [];
    return mb.slots.slice();
  }

  async deleteMailbox(addr: string): Promise<void> {
    const mb = this.mailboxes.get(addr);
    if (mb) {
      mb.slots = [];
      mb.listeners.clear();
    }
    this.mailboxes.delete(addr);
    if (this.bc) {
      try {
        this.bc.postMessage({ kind: 'delete', addr } satisfies BcastMsg);
      } catch {
        // ignore
      }
    }
  }

  subscribeToMailbox(
    addr: string,
    onSlot: (slot: PairSlot) => void,
  ): () => void {
    const t = this.now();
    const mb = this.ensureMailbox(addr, t + this.ttlMs);
    mb.listeners.add(onSlot);
    return () => {
      const current = this.mailboxes.get(addr);
      if (current) current.listeners.delete(onSlot);
    };
  }
}

/**
 * Process-local singleton. Distinct MockRelay instances within the same
 * page share state via BroadcastChannel; separate pages/tabs of the same
 * origin also sync via BroadcastChannel.
 */
let sharedMockRelay: MockRelay | null = null;
export function getSharedMockRelay(): MockRelay {
  if (!sharedMockRelay) sharedMockRelay = new MockRelay();
  return sharedMockRelay;
}

export function resetSharedMockRelayForTests() {
  if (sharedMockRelay) sharedMockRelay.close();
  sharedMockRelay = null;
}

