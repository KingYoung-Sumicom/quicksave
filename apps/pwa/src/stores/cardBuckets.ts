// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { Card } from '@sumicom/quicksave-shared';

export interface CardBucket {
  /** Stable segment key; same turn may have multiple segments if history interleaves. */
  id: string;
  turnId: string | null;
  cards: Card[];
  /** Hot buckets are the small set that may still receive stream updates. */
  hot: boolean;
  completed: boolean;
}

export interface CardBucketIndex {
  byId: Map<string, CardBucket>;
  order: string[];
  cardToBucket: Map<string, string>;
  nextId: number;
  hotOrder: string[];
}

export const LEGACY_BUCKET_MAX_CARDS = 128;
const HOT_TURN_BUCKETS = 3;

/** Group contiguous cards by turn while preserving exact transcript order. */
export function indexCardBuckets(cards: Card[]): CardBucketIndex {
  const byId = new Map<string, CardBucket>();
  const order: string[] = [];
  const cardToBucket = new Map<string, string>();
  let previousTurnId: string | null | undefined;
  let previousBucket: CardBucket | undefined;
  let segment = 0;
  let legacySegment = 0;
  let nextId = 0;
  for (const card of cards) {
    const turnId = card.turnId ?? null;
    const startsNew = turnId !== previousTurnId || (turnId === null && (previousBucket?.cards.length ?? 0) >= LEGACY_BUCKET_MAX_CARDS);
    if (startsNew) segment++;
    if (turnId === null && startsNew) legacySegment++;
    previousTurnId = turnId;
    const id = turnId === null ? `legacy:${legacySegment}` : bucketId(turnId, segment);
    let bucket = byId.get(id);
    if (!bucket) {
      bucket = { id, turnId, cards: [], hot: false, completed: false };
      byId.set(id, bucket);
      order.push(id);
    }
    bucket.cards.push(card);
    previousBucket = bucket;
    cardToBucket.set(card.id, id);
  }
  for (const bucket of byId.values()) bucket.completed = bucket.turnId !== null && bucket.cards.some((card) => card.turnCompleted);
  const hotOrder = order.filter((id) => !byId.get(id)!.completed).slice(-HOT_TURN_BUCKETS);
  for (const id of hotOrder) {
    const bucket = byId.get(id)!;
    bucket.hot = true;
  }
  nextId = order.length;
  return { byId, order, cardToBucket, nextId, hotOrder };
}

function bucketId(turnId: string | null, segment: number): string {
  return `turn:${encodeURIComponent(turnId ?? '')}:${segment}`;
}

/** Replace a single bucket, retaining all other bucket/card identities. */
export function replaceCardBucket(index: CardBucketIndex, bucketId: string, cards: Card[]): CardBucketIndex {
  const old = index.byId.get(bucketId);
  if (!old) return index;
  if (cards.length === 0) {
    index.byId.delete(bucketId);
    for (const card of old.cards) index.cardToBucket.delete(card.id);
    index.hotOrder = index.hotOrder.filter((id) => id !== bucketId);
    return { ...index, order: index.order.filter((id) => id !== bucketId) };
  }
  for (const card of old.cards) index.cardToBucket.delete(card.id);
  for (const card of cards) index.cardToBucket.set(card.id, bucketId);
  const completed = old.turnId !== null && cards.some((card) => card.turnCompleted);
  index.byId.set(bucketId, { ...old, cards, hot: !completed, completed });
  if (completed) index.hotOrder = index.hotOrder.filter((id) => id !== bucketId);
  else promoteBucket(index, bucketId);
  return index;
}

function promoteBucket(index: CardBucketIndex, id: string): void {
  index.hotOrder = index.hotOrder.filter((hotId) => hotId !== id);
  index.hotOrder.push(id);
  while (index.hotOrder.length > HOT_TURN_BUCKETS) {
    const coldId = index.hotOrder.shift()!;
    const cold = index.byId.get(coldId);
    if (cold) index.byId.set(coldId, { ...cold, hot: false });
  }
}

export function flattenCardBuckets(index: CardBucketIndex): Card[] {
  return index.order.flatMap((id) => index.byId.get(id)?.cards ?? []);
}

/** Fast append path: retain every existing bucket and card-array identity. */
export function appendCardToBuckets(index: CardBucketIndex, card: Card): CardBucketIndex {
  const turnId = card.turnId ?? null;
  const lastId = index.order.at(-1);
  const last = lastId ? index.byId.get(lastId) : undefined;
  const sameTurn = last && last.turnId === turnId;
  const legacyFull = sameTurn && turnId === null && last.cards.length >= LEGACY_BUCKET_MAX_CARDS;
  if (sameTurn && !legacyFull) {
    const completed = last.completed || !!card.turnCompleted;
    index.byId.set(last.id, { ...last, cards: [...last.cards, card], completed, hot: !completed });
    if (completed) index.hotOrder = index.hotOrder.filter((id) => id !== last.id);
    else promoteBucket(index, last.id);
    index.cardToBucket.set(card.id, last.id);
    return index;
  }
  // Monotonic IDs avoid collisions when older/interleaved turn segments are
  // appended after history has been prepended or buckets have been removed.
  const id = turnId === null ? `legacy:${++index.nextId}` : `${bucketId(turnId, ++index.nextId)}:append`;
  // The hot window is bounded. Older buckets become cold without touching
  // their card arrays; explicitly completed turns are cold immediately.
  index.byId.set(id, { id, turnId, cards: [card], hot: !card.turnCompleted, completed: !!card.turnCompleted });
  if (card.turnCompleted) index.hotOrder = index.hotOrder.filter((hotId) => hotId !== id);
  else promoteBucket(index, id);
  if (card.turnCompleted) index.hotOrder = index.hotOrder.filter((hotId) => hotId !== id);
  index.cardToBucket.set(card.id, id);
  return { ...index, order: [...index.order, id] };
}
