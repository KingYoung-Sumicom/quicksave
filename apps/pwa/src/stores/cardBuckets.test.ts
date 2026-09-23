// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import type { Card } from '@sumicom/quicksave-shared';
import { appendCardToBuckets, flattenCardBuckets, indexCardBuckets, LEGACY_BUCKET_MAX_CARDS, replaceCardBucket } from './cardBuckets';

const card = (id: string, turnId?: string): Card => ({
  id, type: 'assistant_text', text: id, timestamp: 1, ...(turnId ? { turnId } : {}),
}) as Card;

describe('cardBuckets', () => {
  it('keeps contiguous turn/legacy segments ordered and ids stable on append', () => {
    const initial = indexCardBuckets([
      card('a', 'turn-a'), card('b', 'turn-a'), card('legacy'), card('c', 'turn-c'),
    ]);
    const ids = [...initial.order];
    const historicalBucket = initial.byId.get(ids[0]);
    const next = appendCardToBuckets(initial, card('d', 'turn-c'));

    expect(next.order).toEqual(ids);
    expect(next.byId.get(ids[0])).toBe(historicalBucket);
    expect(flattenCardBuckets(next).map((item) => item.id)).toEqual(['a', 'b', 'legacy', 'c', 'd']);
  });

  it('starts another segment if an older/missing-turn segment resumes later', () => {
    const index = indexCardBuckets([card('a', 'turn-a'), card('x', 'turn-x')]);
    const next = appendCardToBuckets(index, card('a2', 'turn-a'));
    expect(next.order).toHaveLength(3);
    expect(flattenCardBuckets(next).map((item) => item.id)).toEqual(['a', 'x', 'a2']);
  });

  it('bounds legacy chunks and avoids collisions with turn ids named legacy', () => {
    const many = Array.from({ length: LEGACY_BUCKET_MAX_CARDS + 1 }, (_, i) => card(`l${i}`));
    const indexed = indexCardBuckets([...many, card('literal', '__legacy__')]);
    expect(indexed.order.filter((id) => id.startsWith('legacy:'))).toHaveLength(2);
    expect(flattenCardBuckets(indexed).map((item) => item.id)).toHaveLength(many.length + 1);
    const appended = appendCardToBuckets(indexed, card('later'));
    expect(appended.cardToBucket.get('later')).not.toBe(appended.cardToBucket.get('literal'));
    expect(flattenCardBuckets(appended).map((item) => item.id)).toEqual([...many.map((item) => item.id), 'literal', 'later']);
  });

  it('promotes a late cold-bucket update and demotes completed turns', () => {
    const indexed = indexCardBuckets([card('a', 'a'), card('b', 'b'), card('c', 'c'), card('d', 'd')]);
    const coldId = indexed.cardToBucket.get('a')!;
    expect(indexed.byId.get(coldId)?.hot).toBe(false);
    replaceCardBucket(indexed, coldId, [{ ...indexed.byId.get(coldId)!.cards[0], text: 'late' } as Card]);
    expect(indexed.byId.get(coldId)?.hot).toBe(true);
    expect(indexed.hotOrder).toContain(coldId);
    replaceCardBucket(indexed, coldId, [{ ...indexed.byId.get(coldId)!.cards[0], turnCompleted: true } as Card]);
    expect(indexed.byId.get(coldId)?.hot).toBe(false);
  });

  it('applies late updates to explicitly completed buckets without making them active again', () => {
    const completedCard = { ...card('done', 'turn-done'), turnCompleted: true } as Card;
    const indexed = indexCardBuckets([completedCard]);
    const bucketId = indexed.cardToBucket.get('done')!;
    expect(indexed.byId.get(bucketId)).toMatchObject({ hot: false, completed: true });

    replaceCardBucket(indexed, bucketId, [{ ...completedCard, text: 'late update' } as Card]);

    expect(indexed.byId.get(bucketId)).toMatchObject({ hot: false, completed: true });
    expect(indexed.byId.get(bucketId)?.cards[0].text).toBe('late update');
  });
});
