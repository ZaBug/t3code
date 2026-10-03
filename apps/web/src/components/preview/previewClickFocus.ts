interface PendingClicks {
  readonly previous: Element | null;
  readonly runtimeTabIds: Set<string>;
  count: number;
}

// Agent clicks can overlap across tabs and threads. A click that starts while
// another is in flight could see the page that click focused as "what had
// focus", so overlapping clicks share one window: the first remembers the host
// focus and the last to finish restores it.
let pendingClicks: PendingClicks | null = null;

const restoreHostFocus = ({ previous, runtimeTabIds }: PendingClicks): void => {
  const current = document.activeElement;
  if (
    !(current instanceof HTMLElement) ||
    current === previous ||
    current.localName !== "webview" ||
    !runtimeTabIds.has(current.getAttribute("data-preview-tab") ?? "")
  ) {
    return;
  }
  if (previous instanceof HTMLElement && previous.isConnected && previous !== document.body) {
    previous.focus({ preventScroll: true });
  } else {
    current.blur();
  }
};

/**
 * Runs an agent click in a preview tab and hands keyboard focus back to the
 * host page afterwards.
 *
 * The desktop dispatches the click as a CDP mouse press, which focuses the
 * guest page, and nothing gives that focus back. The user's next keystrokes
 * then go into the page, even when its tab is hidden or belongs to another
 * thread. Only the host document knows what had focus before the click, so
 * the restore happens here and not in the desktop main process.
 */
export async function runPreviewClickKeepingHostFocus<A>(
  runtimeTabId: string,
  click: () => Promise<A>,
): Promise<A> {
  const pending = (pendingClicks ??= {
    previous: document.activeElement,
    runtimeTabIds: new Set(),
    count: 0,
  });
  pending.count += 1;
  pending.runtimeTabIds.add(runtimeTabId);
  try {
    return await click();
  } finally {
    // Also runs when the click fails: a keystroke that reaches the page after
    // the press counts as human input and fails the click as interrupted.
    pending.count -= 1;
    if (pending.count === 0) {
      pendingClicks = null;
      restoreHostFocus(pending);
    }
  }
}
