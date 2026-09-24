import { forwardRef, useRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSessionStore } from '@/stores/sessionStore';
import { useUIStore } from '@/stores/uiStore';
import { useAppSettingsStore } from '@/stores/appSettingsStore';
import { groupMessages, MessageDisplayItem, getItemRole } from './MessageBubble';
import { filterVisibleMessages } from './messageFilter';
import { getDisplayItemKey, getMessageIdentity } from '@/utils/messageIdentity';
import { ArrowDown, Loader2 } from 'lucide-react';

// Keep the follow zone small enough that scrolling up to read older content
// opts out, while absorbing normal wheel/touch settling and sub-pixel layout
// rounding near the end of the list.
export const SCROLL_BOTTOM_THRESHOLD = 48;

// ── Scroll memory across route round-trips ─────────────────────────────────
// Leaving Chat (Editor / Tasks / Manage / any route) unmounts ChatView, so
// coming back remounts ChatMessages with an unchanged sessionId. Every mount
// effect ran again, and the "new session" path pushed whoever was reading an
// older message back to the bottom. Remember one anchor row per session — the
// row the user was actually looking at, expressed in virtual-content
// coordinates — and restore it before the browser paints on the way back.
interface ScrollSnapshot {
  /** Guards the restore against a history that changed while away. */
  fingerprint: string;
  identity: string;
  /** Row top relative to the scroll container's top (px). */
  anchorOffset: number;
  /** Row top inside the virtual content (px). */
  contentOffset: number;
}

const scrollSnapshots = new Map<string, ScrollSnapshot>();
/** sessionId → measured row height by virtual item key, for the next mount. */
const measuredHeights = new Map<string, Map<string, number>>();
let activeSessionId: string | null = null;

function listFingerprint(items: DisplayItem[]): string {
  if (items.length === 0) return 'empty';
  const last = items.length - 1;
  return `${items.length}:${getDisplayItemKey(items[0], 0)}:${getDisplayItemKey(items[last], last)}`;
}

type DisplayItem = ReturnType<typeof groupMessages>[number];

export interface ChatMessagesHandle {
  /** Scroll to a currently loaded message and briefly highlight its row. */
  scrollToMessage: (message: import('@/types').Message, historyIndex?: number) => boolean;
}

export const ChatMessages = forwardRef<ChatMessagesHandle>(function ChatMessages(_, ref) {
  const parentRef = useRef<HTMLDivElement>(null);
  const currentMessages = useSessionStore((s) => s.currentMessages);
  const hasMoreMessages = useSessionStore((s) => s.hasMoreMessages);
  const historyLoading = useSessionStore((s) => s.historyLoading);
  const initialLoading = useSessionStore((s) => s.initialLoading);
  const loadOlderMessages = useSessionStore((s) => s.loadOlderMessages);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  // The old Bubble/TUI names were reversed. Keep the deprecated Bubble branch
  // wired for a possible future re-enable; TUI is the default branch here.
  const tuiViewEnabled = useUIStore((s) => s.tuiViewEnabled);
  const showMetaAgent = useAppSettingsStore((s) => s.showMetaAgent);
  const showTaskAgent = useAppSettingsStore((s) => s.showTaskAgent);
  const showQQ = useAppSettingsStore((s) => s.showQQ);

  // Frontend-only display filter — currentMessages in the store is never
  // mutated; hidden messages reappear when their toggle is switched back on.
  const visibleMessages = useMemo(
    () =>
      filterVisibleMessages(currentMessages, {
        showMetaAgent,
        showTaskAgent,
        showQQ,
      }),
    [currentMessages, showMetaAgent, showTaskAgent, showQQ],
  );

  // Group messages: consecutive tool messages become ToolGroup
  const grouped = groupMessages(visibleMessages);

  const [highlightedTarget, setHighlightedTarget] = useState<{ identity: string; historyIndex?: number } | null>(null);

  // Latest render value the module-level helper below needs. It must hold a
  // stable identity because the scroll effects depend on that helper.
  const groupedRef = useRef(grouped);
  groupedRef.current = grouped;

  // Route round-trip: adopt the position this session was left at, but only for
  // a remount of the *same* session whose message list did not change.
  const restoreRef = useRef<ScrollSnapshot | null | undefined>(undefined);
  const restoreSessionRef = useRef<string | null | undefined>(undefined);
  if (restoreRef.current === undefined) {
    restoreSessionRef.current = currentSessionId;
    // A session can keep loading/prepending while it is off-screen (for
    // example, the user leaves immediately after a navigation jump). In that
    // case the list fingerprint is expected to change; the stable message
    // identity is the useful part of the snapshot.
    restoreRef.current = currentSessionId
      ? scrollSnapshots.get(currentSessionId) ?? null
      : null;
    // Consume once: the next mount/visit of this session is a fresh restore.
    if (currentSessionId) scrollSnapshots.delete(currentSessionId);
  }
  const isRestoringRef = useRef(restoreRef.current !== null);

  const virtualizer = useVirtualizer({
    count: grouped.length,
    getScrollElement: () => parentRef.current,
    // Rows measured during the previous visit. Without them the remounted
    // virtualizer starts from the flat estimate, whose total size differs from
    // the one the remembered content offset was taken against.
    estimateSize: (index) =>
      measuredHeights
        .get(currentSessionId ?? '')
        ?.get(getDisplayItemKey(grouped[index], index)) ?? 100,
    overscan: 5,
    // The default key is the array index. Streaming replaces message objects,
    // prepending history shifts indexes, and tool grouping changes row shapes;
    // an index key lets Virtualizer reuse another row's height/DOM node.
    getItemKey: (index) => getDisplayItemKey(grouped[index], index),
  });
  // Virtualized content height. Changes when messages are added/removed or
  // when items get measured after layout. Re-scrolling on this (while the user
  // is pinned to the bottom) is what lands the view at the *true* bottom once
  // the virtualizer's measurements settle, instead of the initial estimate.
  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  // Remember where the reader is, for the route round-trip above. Rows are
  // virtualized, so keep the visible anchor row's offset inside the virtual
  // content: it is independent of the virtualization window and survives a
  // re-measurement of everything above it. No layout (jsdom) yields no anchor —
  // and therefore no snapshot — which keeps this inert under unit tests.
  const rememberScrollPosition = useCallback((el: HTMLElement) => {
    // Use the render's session id rather than a module-level value updated by
    // a passive effect. Route unmounts can run before that effect has painted,
    // which otherwise loses the only round-trip snapshot.
    const sid = currentSessionId;
    if (!sid) return;
    const viewport = el.getBoundingClientRect();
    const anchor = [...el.querySelectorAll<HTMLElement>('[data-message-identity]')].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    const identity = anchor?.dataset.messageIdentity;
    const debugSnapshot = (globalThis as { __panSnapshotDebug?: unknown[] }).__panSnapshotDebug ??= [];
    debugSnapshot.push({ sid, st: el.scrollTop, sh: el.scrollHeight, nodes: el.querySelectorAll('[data-message-identity]').length, identity: identity ?? null });
    if (!anchor || !identity) return;
    const rect = anchor.getBoundingClientRect();
    const snap = {
      fingerprint: listFingerprint(groupedRef.current),
      identity,
      anchorOffset: rect.top - viewport.top,
      contentOffset: rect.top - viewport.top + el.scrollTop,
    };
    scrollSnapshots.set(sid, snap);
  }, [currentSessionId]);

  const scrollToMessage = useCallback((message: import('@/types').Message, historyIndex?: number): boolean => {
    const identity = getMessageIdentity(message);
    const itemIndex = grouped.findIndex((item) => {
      if ('type' in item && item.type === 'tool_group') return false;
      return getMessageIdentity(item as import('@/types').Message) === identity;
    });
    if (itemIndex < 0) return false;
    virtualizer.scrollToIndex(itemIndex, { align: 'center', behavior: 'auto' });
    setHighlightedTarget({ identity, historyIndex });
    // A jump moves the viewport without touching the scroll listener (and may
    // not even change totalSize), so refresh the round-trip anchor once the
    // targeted row has landed. Otherwise leaving right after a jump would
    // remember the position from before it.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = parentRef.current;
        if (el) rememberScrollPosition(el);
      });
    });
    return true;
  }, [grouped, virtualizer, rememberScrollPosition]);

  useImperativeHandle(ref, () => ({ scrollToMessage }), [scrollToMessage]);

  useEffect(() => {
    if (!highlightedTarget) return;
    const timer = window.setTimeout(() => setHighlightedTarget(null), 1400);
    return () => window.clearTimeout(timer);
  }, [highlightedTarget]);

  // Whether the user wants the view to follow the bottom. This is deliberately
  // state held outside React rendering: a streaming delta can arrive between
  // renders, and a render must not infer "follow" from a transient scrollTop.
  // Starts true so the first message load of a session scrolls down; a user
  // scroll away from the follow zone opts out until they return to it (or
  // explicitly press the scroll-to-bottom button). A restore must NOT start in
  // follow mode: that was what dragged a reader back to the bottom.
  const shouldFollowBottomRef = useRef(!isRestoringRef.current);
  // Scroll events happen outside React rendering. Keep a renderable copy so
  // the button appears/disappears immediately when the user crosses the
  // follow boundary.
  const [isNearBottom, setIsNearBottom] = useState(true);
  // A newly selected session starts with an empty/unlaid-out container. Allow
  // its first history render to establish the initial bottom position even
  // though scrollTop is 0 before the content is mounted. On a restore the
  // position is already known, so nothing may override it.
  const initialScrollPendingRef = useRef(!isRestoringRef.current);

  // Unlike a route round-trip, selecting another session reuses this mounted
  // component. Pick up that session's saved anchor during render so the
  // layout restore runs before the auto-scroll effect can pin it to the end.
  if (restoreSessionRef.current !== currentSessionId) {
    restoreSessionRef.current = currentSessionId;
    restoreRef.current = currentSessionId
      ? scrollSnapshots.get(currentSessionId) ?? null
      : null;
    if (currentSessionId) scrollSnapshots.delete(currentSessionId);
    isRestoringRef.current = restoreRef.current !== null;
    shouldFollowBottomRef.current = !isRestoringRef.current;
    initialScrollPendingRef.current = !isRestoringRef.current;
  }

  const lastScrollMetricsRef = useRef<{
    height: number;
    top: number;
    clientHeight: number;
  } | null>(null);
  const paginationAnchorRef = useRef<{
    top: number;
    scrollTop: number;
    height: number;
    element: HTMLElement | null;
    measurable: boolean;
    // Route restores must follow the logical row, not a DOM node that the
    // virtualizer may recycle after history is prepended.
    identity?: string;
  } | null>(null);
  const paginationRestoreRafRef = useRef<number | null>(null);
  const historyLoadingRef = useRef(historyLoading);
  historyLoadingRef.current = historyLoading;

  // Clamp only negative browser rounding artefacts to zero, then use the
  // small follow zone below instead of requiring exact geometry equality.
  const getDistanceFromBottom = useCallback((): number => {
    const el = parentRef.current;
    if (!el) return 0;
    return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
  }, []);

  const isNearBottomPosition = useCallback((): boolean => {
    return getDistanceFromBottom() <= SCROLL_BOTTOM_THRESHOLD;
  }, [getDistanceFromBottom]);

  const captureScrollMetrics = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    lastScrollMetricsRef.current = {
      height: el.scrollHeight,
      top: el.scrollTop,
      clientHeight: el.clientHeight,
    };
    rememberScrollPosition(el);
  }, [rememberScrollPosition]);

  const scrollToBottom = useCallback(() => {
    const el = parentRef.current;
    if (el) {
      shouldFollowBottomRef.current = true;
      el.scrollTop = el.scrollHeight;
      setIsNearBottom(true);
      captureScrollMetrics();
    }
  }, [captureScrollMetrics]);

  const restorePaginationAnchor = useCallback(() => {
    const el = parentRef.current;
    const anchor = paginationAnchorRef.current;
    if (!el || !anchor) return;

    // A virtualized row can stay connected while React has recycled it for a
    // different message. Resolve route anchors by stable message identity on
    // every correction instead of trusting the old DOM reference.
    if (anchor.identity) {
      const current = [...el.querySelectorAll<HTMLElement>('[data-message-identity]')].find(
        (node) => node.dataset.messageIdentity === anchor.identity,
      );
      if (current) {
        anchor.element = current;
        anchor.measurable = current.getBoundingClientRect().height > 0;
      } else {
        anchor.element = null;
        anchor.measurable = false;
        const anchorIndex = groupedRef.current.findIndex((item) => {
          if ('type' in item && item.type === 'tool_group') return false;
          return getMessageIdentity(item as import('@/types').Message) === anchor.identity;
        });
        if (anchorIndex >= 0) {
          virtualizerRef.current.scrollToIndex(anchorIndex, { align: 'center', behavior: 'auto' });
          return;
        }
      }
    }

    if (anchor.element?.isConnected && anchor.measurable) {
      // The identity check above makes this safe even when the virtualizer
      // reuses a connected element for another index.
      const delta = anchor.element.getBoundingClientRect().top - anchor.top;
      if (Math.abs(delta) > 0.5) {
        el.scrollTop += delta;
      }
      return;
    }

    // jsdom and a detached non-route virtual row have no usable geometry. Keep
    // the existing height-delta fallback for that case and for the test seam.
    if (!anchor.identity) el.scrollTop = anchor.scrollTop + el.scrollHeight - anchor.height;
  }, []);


  const schedulePaginationRestore = useCallback(() => {
    if (paginationRestoreRafRef.current !== null) return;

    let stableFrames = 0;
    let frameCount = 0;
    let previousSignature = '';
    const tick = () => {
      paginationRestoreRafRef.current = null;
      const el = parentRef.current;
      const anchor = paginationAnchorRef.current;
      if (!el || !anchor) return;

      restorePaginationAnchor();
      const anchorTop = anchor.element?.isConnected
        ? anchor.element.getBoundingClientRect().top
        : null;
      const signature = `${el.scrollHeight}:${el.scrollTop}:${anchorTop}`;
      stableFrames = signature === previousSignature ? stableFrames + 1 : 0;
      previousSignature = signature;
      frameCount += 1;

      // A route can be re-entered while the jump is still fetching several
      // pages. Keep the same logical anchor pinned for the whole in-flight
      // load; otherwise the short settle window can end between pages and
      // each prepend visibly moves the reader before the next render. A few
      // quiet frames are retained after a request completes because
      // ensureMessageLoaded starts the next page immediately after the prior
      // response, while React may render the intermediate state first.
      const routeRestore = Boolean(restoreRef.current);
      const quietLimit = routeRestore ? 12 : 2;
      if (!historyLoadingRef.current && stableFrames >= quietLimit) {
        paginationAnchorRef.current = null;
        if (routeRestore) restoreRef.current = null;
        return;
      }
      if (!routeRestore && frameCount >= 30) {
        paginationAnchorRef.current = null;
        return;
      }
      paginationRestoreRafRef.current = requestAnimationFrame(tick);
    };

    paginationRestoreRafRef.current = requestAnimationFrame(tick);
  }, [historyLoading, restorePaginationAnchor]);

  // Auto-scroll on new messages / measurement-driven size changes — but only
  // when the user hasn't scrolled away from the bottom. This is ALSO what
  // lands the view at the bottom after entering a session: the session-change
  // effect below sets the initial-scroll flag, so when the asynchronously-
  // loaded history arrives (currentMessages changes) — and again once the
  // virtualizer measures the real heights (totalSize changes) — we scroll only
  // when the container is truly at the bottom, except for that initial history
  // render.
  useEffect(() => {
    const el = parentRef.current;
    const previous = lastScrollMetricsRef.current;
    const grewWhilePinned = Boolean(
      el &&
        previous &&
        el.scrollHeight !== previous.height &&
        el.scrollTop === previous.top &&
        Math.max(0, previous.height - previous.top - previous.clientHeight) <=
          SCROLL_BOTTOM_THRESHOLD,
    );
    const nearBottom = isNearBottomPosition();
    let followedBottom = false;
    if (
      shouldFollowBottomRef.current &&
      (initialScrollPendingRef.current || nearBottom || grewWhilePinned)
    ) {
      initialScrollPendingRef.current = false;
      scrollToBottom();
      followedBottom = true;
    }
    setIsNearBottom(followedBottom || nearBottom || grewWhilePinned);
    captureScrollMetrics();
  }, [currentMessages, totalSize, captureScrollMetrics, isNearBottomPosition, scrollToBottom]);

  // Coming back from another route: put the remembered row back under the
  // reader's eyes before the first paint, then hand the anchor to the shared
  // restore loop so the virtualizer's re-measurement cannot move it either.
  const restoreAttemptsRef = useRef(0);
  useLayoutEffect(() => {
    const memory = restoreRef.current;
    const el = parentRef.current;
    const debugRestore = (globalThis as { __panRestoreDebug?: unknown[] }).__panRestoreDebug ??= [];
    debugRestore.push({ phase: 'layout', memory: memory?.identity ?? null, grouped: grouped.length, st: el?.scrollTop ?? null, sh: el?.scrollHeight ?? null, loading: historyLoading, more: hasMoreMessages });
    if (!memory || !el || grouped.length === 0) return;
    if (restoreAttemptsRef.current > 8) {
      restoreRef.current = null;
      return;
    }
    restoreAttemptsRef.current += 1;
    const fingerprintMatches = memory.fingerprint === listFingerprint(grouped);

    const desiredTop = el.getBoundingClientRect().top + memory.anchorOffset;
    const anchorRow = [...el.querySelectorAll<HTMLElement>('[data-message-identity]')].find(
      (node) => node.dataset.messageIdentity === memory.identity,
    ) ?? null;
    debugRestore.push({ phase: 'anchor', memory: memory.identity, found: Boolean(anchorRow), index: grouped.findIndex((item) => {
      if ('type' in item && item.type === 'tool_group') return false;
      return getMessageIdentity(item as import('@/types').Message) === memory.identity;
    }), st: el.scrollTop, sh: el.scrollHeight });
    if (!anchorRow) {
      // The virtualizer has not rendered that window yet. If history changed
      // while away, the old content offset is no longer meaningful; use the
      // stable message identity to bring the row into the render window.
      const anchorIndex = fingerprintMatches
        ? -1
        : grouped.findIndex((item) => {
            if ('type' in item && item.type === 'tool_group') return false;
            return getMessageIdentity(item as import('@/types').Message) === memory.identity;
          });
      if (anchorIndex >= 0) {
        virtualizer.scrollToIndex(anchorIndex, { align: 'center', behavior: 'auto' });
        paginationAnchorRef.current = {
          top: desiredTop,
          scrollTop: el.scrollTop,
          height: el.scrollHeight,
          element: null,
          measurable: false,
          identity: memory.identity,
        };
        schedulePaginationRestore();
      } else {
        el.scrollTop = Math.max(0, memory.contentOffset - memory.anchorOffset);
      }
      return;
    }

    const delta = anchorRow.getBoundingClientRect().top - desiredTop;
    if (Math.abs(delta) > 0.5) el.scrollTop += delta;
    // Keep correcting the same identity while an off-screen history jump is
    // still loading pages. Clearing this after the first stable frame would
    // allow the next prepend to move the reader before the next render.
    const keepRouteRestore = hasMoreMessages || historyLoading || memory.fingerprint !== listFingerprint(grouped);
    if (!keepRouteRestore) restoreRef.current = null;
    paginationAnchorRef.current = {
      top: desiredTop,
      scrollTop: el.scrollTop,
      height: el.scrollHeight,
      element: anchorRow,
      measurable: true,
      identity: memory.identity,
    };
    schedulePaginationRestore();

    const nearBottom = isNearBottomPosition();
    shouldFollowBottomRef.current = nearBottom;
    setIsNearBottom(nearBottom);
    captureScrollMetrics();
  }, [
    grouped,
    captureScrollMetrics,
    hasMoreMessages,
    historyLoading,
    isNearBottomPosition,
    schedulePaginationRestore,
    virtualizer,
  ]);

  // Prepending first commits estimated rows, then the virtualizer measures
  // them. Restore before paint and keep correcting for the short measurement
  // window so neither phase can visibly move the user's anchor.
  useLayoutEffect(() => {
    if (!paginationAnchorRef.current) return;
    restorePaginationAnchor();
    schedulePaginationRestore();
  }, [currentMessages, totalSize, restorePaginationAnchor, schedulePaginationRestore]);

  // Keep this session's measured row heights for the next mount, and track which
  // session this mounted instance belongs to.
  useEffect(() => {
    return () => {
      // The user can leave in the same tick as a navigation jump. Capture at
      // unmount as a final safety net instead of relying only on scroll events
      // or the jump's delayed rAF callback.
      const sid = activeSessionId;
      if (parentRef.current && (!sid || !scrollSnapshots.has(sid))) {
        rememberScrollPosition(parentRef.current);
      }
      const cache = virtualizerRef.current.measurementsCache;
      if (!sid || !Array.isArray(cache)) return;
      const heights = new Map<string, number>();
      for (const measurement of cache) heights.set(String(measurement.key), measurement.size);
      if (heights.size > 0) measuredHeights.set(sid, heights);
    };
  }, [rememberScrollPosition]);

  useEffect(() => {
    activeSessionId = currentSessionId;
  }, [currentSessionId]);

  // Lazy load older messages on scroll to top
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const handler = () => {
      // Scrolling beyond the follow zone opts out. Programmatic scrolls
      // (scrollToBottom) also fire scroll events and re-pin at the bottom.
      initialScrollPendingRef.current = false;
      const nearBottom = isNearBottomPosition();
      shouldFollowBottomRef.current = nearBottom;
      setIsNearBottom(nearBottom);
      captureScrollMetrics();

      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (el.scrollTop <= 200 && hasMoreMessages && !historyLoading) {
          // Keep a real rendered row under the user's eyes. Its geometry is
          // more reliable than a virtualizer estimate while prepended rows
          // are being measured.
          const viewport = el.getBoundingClientRect();
          const anchorElement = [...el.querySelectorAll<HTMLElement>('[data-index]')].find(
            (node) => {
              const rect = node.getBoundingClientRect();
              return rect.bottom > viewport.top && rect.top < viewport.bottom;
            },
          );
          const anchorRect = anchorElement?.getBoundingClientRect();
          paginationAnchorRef.current = {
            top: anchorRect?.top ?? 0,
            scrollTop: el.scrollTop,
            height: el.scrollHeight,
            element: anchorElement ?? null,
            measurable: Boolean(anchorRect && anchorRect.height > 0),
          };
          loadOlderMessages().then(() => {
            restorePaginationAnchor();
            schedulePaginationRestore();
          });
        }
      }, 150);
    };

    el.addEventListener('scroll', handler);
    return () => {
      el.removeEventListener('scroll', handler);
      if (timer) clearTimeout(timer);
    };
  }, [
    captureScrollMetrics,
    hasMoreMessages,
    historyLoading,
    isNearBottomPosition,
    loadOlderMessages,
    restorePaginationAnchor,
    schedulePaginationRestore,
  ]);

  // Scroll to bottom when the session changes. Reset the pinned anchor first
  // so the auto-scroll effect above forces us down once this session's history
  // loads (async) and again after the virtualizer measures the real heights.
  // The rAF re-scroll covers the same-frame layout of the freshly swapped DOM.
  const handledSessionRef = useRef<string | null>(isRestoringRef.current ? currentSessionId : null);
  useEffect(() => {
    // Same session and no session switch: this run is the mount of a route
    // re-entry, whose restored position must not be reset to the newest message.
    if (handledSessionRef.current === currentSessionId) return;
    handledSessionRef.current = currentSessionId;
    // A session selected from the sidebar may have a saved anchor. The layout
    // restore already handled it; do not let this effect undo that restore.
    if (isRestoringRef.current) {
      isRestoringRef.current = false;
      return;
    }
    // A genuine session switch without a saved anchor starts at the newest
    // message. Do not discard snapshots belonging to other sessions.
    if (currentSessionId) measuredHeights.delete(currentSessionId);
    shouldFollowBottomRef.current = true;
    setIsNearBottom(true);
    initialScrollPendingRef.current = true;
    lastScrollMetricsRef.current = null;
    paginationAnchorRef.current = null;
    if (paginationRestoreRafRef.current !== null) {
      cancelAnimationFrame(paginationRestoreRafRef.current);
      paginationRestoreRafRef.current = null;
    }
    scrollToBottom();
    // If this session already has a mounted message container, the session
    // switch itself performed the initial positioning. Keep later updates
    // subject to the strict bottom check; leave the flag pending only when
    // history is still empty and its container has not mounted yet.
    if (parentRef.current) {
      initialScrollPendingRef.current = false;
    }
    const raf = requestAnimationFrame(scrollToBottom);
    return () => cancelAnimationFrame(raf);
  }, [currentSessionId, scrollToBottom]);

  // Empty state — but ONLY after the initial history fetch has settled. While
  // it is in flight (currentMessages empty + initialLoading) show a spinner so
  // a session that actually has content never flashes "No messages yet".
  if (currentMessages.length === 0) {
    if (initialLoading) {
      return (
        <div className="flex-1 flex items-center justify-center gap-2 text-text-tertiary text-sm">
          <Loader2 size={16} className="animate-spin" />
          Loading...
        </div>
      );
    }
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
        {currentSessionId
          ? 'No messages yet. Start a conversation.'
          : 'Select a session to start'}
      </div>
    );
  }

  return (
    // `min-w-0` is load-bearing. As a flex item this column defaults to
    // `min-width: auto`, so a row holding a long unbreakable token (URL, path,
    // inline code) can stretch the column to its min-content width. The bubble's
    // `max-width: 75%/85%` then resolves against that inflated row instead of
    // the real viewport, painting the bubble past the right screen edge.
    <div className="flex-1 flex flex-col min-h-0 min-w-0 relative">
      <div
        ref={parentRef}
        className={`flex-1 min-h-0 overflow-auto ${!tuiViewEnabled ? 'bubble-mode' : ''}`}
        style={{ overflowAnchor: 'none' }}
      >
        <div
          style={{
            minHeight: `${totalSize}px`,
            width: '100%',
            // Keep the virtual spacer and its rows in one formatting context
            // so top spacing is measured as part of the scroll content.
            display: 'flow-root',
          }}
        >
          {virtualItems.map((vItem, virtualIndex) => {
            const item = grouped[vItem.index];
            if (!item) return null;
            const prevItem = grouped[vItem.index - 1];
            const prevRole = prevItem ? getItemRole(prevItem) : null;
            const previousVirtualItem = virtualItems[virtualIndex - 1];
            // The first rendered row reserves the omitted prefix. Subsequent
            // rows use only a non-negative gap: if a streamed/collapsible row
            // is taller than its last measurement, normal flow pushes the next
            // row down instead of allowing stale absolute coordinates to
            // overlap it. TanStack will measure the new height and settle the
            // spacer on the next update.
            const flowOffset = previousVirtualItem
              ? Math.max(0, vItem.start - previousVirtualItem.start - previousVirtualItem.size)
              : Math.max(0, vItem.start);
            return (
              <div
                key={vItem.key}
                data-index={vItem.index}
                data-message-identity={
                  'type' in item && item.type === 'tool_group'
                    ? undefined
                    : getMessageIdentity(item as import('@/types').Message)
                }
                ref={virtualizer.measureElement}
                style={{
                  width: '100%',
                  marginTop: `${flowOffset}px`,
                  // Keep child margins and collapsible content inside the
                  // measured row's formatting context. The viewport may move
                  // because of auto-scroll, but it must not alter row order.
                  display: 'flow-root',
                }}
              >
                {!('type' in item && item.type === 'tool_group') &&
                highlightedTarget?.identity === getMessageIdentity(item as import('@/types').Message) ? (
                  <div
                    className="chat-message-jump-highlight"
                    data-index={highlightedTarget.historyIndex ?? vItem.index}
                  >
                    <MessageDisplayItem item={item} prevRole={prevRole} />
                  </div>
                ) : (
                  <MessageDisplayItem item={item} prevRole={prevRole} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Scroll-to-bottom button */}
      {!isNearBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-2 right-4 rounded-full bg-accent text-white p-2 shadow-lg hover:bg-accent-hover transition-colors z-10"
          title="Scroll to bottom"
        >
          <ArrowDown size={16} />
        </button>
      )}

      {/* Loading indicator */}
      {historyLoading && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-bg-tertiary px-3 py-1 rounded text-xs text-text-secondary">
          Loading older messages...
        </div>
      )}
    </div>
  );
});
