import '@testing-library/jest-dom';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
  });
}

// jsdom has no PointerEvent constructor at all — needed by anything using
// raw pointerdown/pointermove/pointerup (the dashboard widget resize
// handle's own pointer-delta logic; dnd-kit's PointerSensor polyfills its
// own handling and doesn't need this). A minimal MouseEvent-based stand-in
// is enough: clientX/clientY/pointerId are all either flags are needed for.
if (typeof globalThis.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, params: MouseEventInit & { pointerId?: number } = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
    }
  }
  globalThis.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

// Radix popover-style primitives (DropdownMenu, Select, ...) call these
// during open/close in the browser; jsdom doesn't implement them.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom doesn't implement scrollTo either — chat-message-scroll-wrapper.tsx
// calls it directly on the scroll container (its mount-scroll and
// forceScrollTrigger effects) to follow new messages.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (typeof globalThis.IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = class IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
}

// react-resizable-panels (ResizablePanelGroup) constructs a DOMRect directly
// when computing hit regions; jsdom in this project doesn't define the
// constructor globally.
if (typeof globalThis.DOMRect === 'undefined') {
  globalThis.DOMRect = class DOMRect {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    left: number;
    right: number;
    bottom: number;

    constructor(x = 0, y = 0, width = 0, height = 0) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
      this.top = y;
      this.left = x;
      this.right = x + width;
      this.bottom = y + height;
    }

    toJSON() {
      return { ...this };
    }
  } as unknown as typeof DOMRect;
}

// jsdom 20 doesn't implement <dialog>'s imperative API at all — needed by
// @tkottke90/preact-dialog's Dialog/Drawer/Modal, which call showModal()/
// close() directly on the underlying <dialog> element.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
}
if (!HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
}

// jsdom doesn't implement the Blob URL registry — chat-input.tsx's stageFile
// uses these for an attachment's local instant preview (see
// attachment-tile.tsx's blur-up swap). Individual tests may still override
// createObjectURL with their own jest.fn() to assert on it.
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:mock';
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => {};
}

// jsdom doesn't implement innerText at all (it's layout-dependent, which
// jsdom doesn't compute) — markdown.tsx's CodeBlock reads it to copy a code
// block's rendered text. This approximates it with textContent, which is
// sufficient for plain-text code block content (no hidden/collapsed
// elements to differ on) and is what makes that Copy behavior testable here.
if (!('innerText' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'innerText', {
    configurable: true,
    get(this: Element) {
      return this.textContent;
    },
  });
}

if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
}
