const isPreviewWebview = (element: Element, runtimeTabId: string): boolean =>
  element.localName === "webview" && element.getAttribute("data-preview-tab") === runtimeTabId;

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
  const previous = document.activeElement;
  try {
    return await click();
  } finally {
    // Also runs when the click fails: a keystroke that reaches the page after
    // the press counts as human input and fails the click as interrupted.
    const current = document.activeElement;
    if (
      current instanceof HTMLElement &&
      current !== previous &&
      isPreviewWebview(current, runtimeTabId)
    ) {
      if (previous instanceof HTMLElement && previous.isConnected && previous !== document.body) {
        previous.focus({ preventScroll: true });
      } else {
        current.blur();
      }
    }
  }
}
