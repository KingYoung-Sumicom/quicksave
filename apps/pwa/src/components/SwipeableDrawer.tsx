import { useRef, useEffect } from 'react';
import { useEdgeSwipe } from '../hooks/useEdgeSwipe';
import { useMediaQuery } from '../hooks/useMediaQuery';

interface SwipeableDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called when a swipe-to-open gesture completes. If omitted, only swipe-to-close is enabled. */
  onOpen?: () => void;
  side?: 'left' | 'right';
  /** Width of the drawer in px — must match the CSS class (default 288 = w-72) */
  drawerWidth?: number;
  /** className applied to the drawer panel div */
  className?: string;
  children: React.ReactNode;
}

/**
 * Wraps an overlay drawer with swipe-to-open/close gesture support.
 * Handles backdrop, animation class, and rAF-based drag-follow.
 * Works for both left and right side drawers.
 */
export function SwipeableDrawer({
  isOpen,
  onClose,
  onOpen,
  side = 'left',
  drawerWidth = 288,
  className = '',
  children,
}: SwipeableDrawerProps) {
  const isDesktop = useMediaQuery('(min-width: 768px)');

  const { isDragging, dragOffsetRef } = useEdgeSwipe({
    isOpen,
    onOpen: onOpen ?? (() => {}),
    onClose,
    drawerWidth,
    edgeZone: 44,
    threshold: 0.35,
    // Enable swipe-to-open only if onOpen is provided; always enable swipe-to-close when open
    enabled: !isDesktop && (isOpen || !!onOpen),
    side,
  });

  const drawerRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Track previous isDragging to skip slide animation after drag-snap
  const prevIsDraggingRef = useRef(false);
  const wasDragging = prevIsDraggingRef.current;
  prevIsDraggingRef.current = isDragging;
  const skipSlideAnimation = wasDragging && !isDragging;

  // rAF loop: directly mutate DOM during drag to avoid per-frame React re-renders
  useEffect(() => {
    if (!isDragging) return;
    let rafId: number;
    const animate = () => {
      const offset = dragOffsetRef.current;
      if (offset !== null && offset !== undefined) {
        if (drawerRef.current) {
          const translate = side === 'left'
            ? offset - drawerWidth
            : drawerWidth - offset;
          drawerRef.current.style.transform = `translateX(${translate}px)`;
          drawerRef.current.style.transition = 'none';
        }
        if (backdropRef.current) {
          backdropRef.current.style.opacity = String((offset / drawerWidth) * 0.5);
        }
      }
      rafId = requestAnimationFrame(animate);
    };
    rafId = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(rafId);
      if (drawerRef.current) {
        drawerRef.current.style.transform = '';
        drawerRef.current.style.transition = '';
      }
    };
  }, [isDragging, dragOffsetRef, side, drawerWidth]);

  if (!isOpen && !isDragging) return null;

  const slideClass = side === 'left' ? 'animate-slide-in-left' : 'animate-slide-in-right';
  const hiddenStyle = side === 'left'
    ? { transform: `translateX(-${drawerWidth}px)` }
    : { transform: `translateX(${drawerWidth}px)` };

  return (
    <>
      {/* Backdrop */}
      <div
        ref={backdropRef}
        className="fixed inset-0 z-40 bg-black"
        style={{ opacity: isDragging ? 0 : 0.5 }}
        onClick={onClose}
        onTouchEnd={onClose}
      />

      {/* Drawer panel */}
      <div
        ref={drawerRef}
        className={`fixed inset-y-0 z-50 ${side === 'left' ? 'left-0' : 'right-0'}${isOpen && !isDragging && !skipSlideAnimation ? ` ${slideClass}` : ''} ${className}`}
        style={!isOpen && isDragging ? hiddenStyle : undefined}
      >
        {children}
      </div>
    </>
  );
}
