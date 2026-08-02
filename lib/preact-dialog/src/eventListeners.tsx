import { Inputs, useCallback } from 'preact/hooks';

export function registerEvent(element: EventTarget, eventName: string, event: (e: Event) => void) {
  if (element) {
    element.addEventListener(eventName, event);
  }

  return () => {
    if (element) {
      element.removeEventListener(eventName, event);
    }
  };
}

export function useHtmlElementListeners(
  events: [eventName: string, event: (e: Event) => void][],
  inputs: Inputs = [],
) {
  return useCallback((node: HTMLElement | null) => {
    // Skip of no node is present
    if (!node) return;

    // Loop over each event provided and register it with the node
    const eventListeners = events.map(([name, eventFn]) => registerEvent(node, name, eventFn));

    // Register a cleanup method which unsubscribes from each
    // event during the unmounting process
    return () => {
      eventListeners.map((unsubscriber) => unsubscriber());
    };
  }, inputs);
}
