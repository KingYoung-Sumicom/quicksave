// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState } from 'react';

interface UseEdgeSwipeOptions {
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  drawerWidth: number;
  edgeZone: number;
  threshold: number;
  enabled: boolean;
  side?: 'left' | 'right';
}

export interface UseEdgeSwipeResult {
  isDragging: boolean;
  dragOffsetRef: React.MutableRefObject<number | null>;
}

type Phase = 'idle' | 'pending' | 'dragging' | 'rejected';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function useEdgeSwipe({
  isOpen,
  onOpen,
  onClose,
  drawerWidth,
  edgeZone,
  threshold,
  enabled,
  side = 'left',
}: UseEdgeSwipeOptions): UseEdgeSwipeResult {
  const [isDragging, setIsDragging] = useState(false);
  const dragOffsetRef = useRef<number | null>(null);

  // All mutable state as refs so handlers are stable
  const phase = useRef<Phase>('idle');
  const startX = useRef(0);
  const startY = useRef(0);
  const isOpenRef = useRef(isOpen);
  const callbackRefs = useRef({ onOpen, onClose });

  // Keep refs in sync with latest props without re-creating handlers
  useEffect(() => { isOpenRef.current = isOpen; }, [isOpen]);
  useEffect(() => { callbackRefs.current = { onOpen, onClose }; }, [onOpen, onClose]);

  useEffect(() => {
    if (!enabled) return;

    const handleStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      startX.current = touch.clientX;
      startY.current = touch.clientY;

      const inEdgeZone = side === 'left'
        ? touch.clientX <= edgeZone
        : touch.clientX >= window.innerWidth - edgeZone;

      if (!isOpenRef.current && !inEdgeZone) {
        phase.current = 'rejected';
        return;
      }

      // When drawer is open, only track swipe-to-close if starting outside drawer area
      // (i.e. on the backdrop). Touches inside the drawer should pass through to child elements.
      if (isOpenRef.current) {
        const insideDrawer = side === 'left'
          ? touch.clientX <= drawerWidth
          : touch.clientX >= window.innerWidth - drawerWidth;
        if (insideDrawer) {
          phase.current = 'rejected';
          return;
        }
      }

      phase.current = 'pending';
    };

    const handleMove = (e: TouchEvent) => {
      if (phase.current === 'rejected' || phase.current === 'idle') return;

      const touch = e.touches[0];
      const dx = touch.clientX - startX.current;
      const dy = touch.clientY - startY.current;

      if (phase.current === 'pending') {
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;

        // Vertical intent — hand off to scroll
        if (Math.abs(dy) > Math.abs(dx) * 1.5) {
          phase.current = 'rejected';
          return;
        }

        phase.current = 'dragging';
        setIsDragging(true);
      }

      // phase === 'dragging'
      e.preventDefault();

      // For right drawer: dx is negative when closing (dragging right→left),
      // offset represents how much of the drawer is visible (0=hidden, drawerWidth=fully open)
      const offset = side === 'left'
        ? clamp(isOpenRef.current ? drawerWidth + dx : dx, 0, drawerWidth)
        : clamp(isOpenRef.current ? drawerWidth - dx : -dx, 0, drawerWidth);

      dragOffsetRef.current = offset;
    };

    const handleEnd = () => {
      if (phase.current !== 'dragging') {
        phase.current = 'idle';
        return;
      }

      const offset = dragOffsetRef.current ?? 0;
      if (offset >= drawerWidth * threshold) {
        callbackRefs.current.onOpen();
      } else {
        callbackRefs.current.onClose();
      }

      dragOffsetRef.current = null;
      setIsDragging(false);
      phase.current = 'idle';
    };

    document.addEventListener('touchstart', handleStart, { passive: false });
    document.addEventListener('touchmove', handleMove, { passive: false });
    document.addEventListener('touchend', handleEnd);
    document.addEventListener('touchcancel', handleEnd);

    return () => {
      document.removeEventListener('touchstart', handleStart);
      document.removeEventListener('touchmove', handleMove);
      document.removeEventListener('touchend', handleEnd);
      document.removeEventListener('touchcancel', handleEnd);
    };
  }, [enabled, edgeZone, drawerWidth, threshold, side]);

  return { isDragging, dragOffsetRef };
}
