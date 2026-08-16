import '@testing-library/jest-dom';

// jsdom (bundled with jest-environment-jsdom) does not implement
// HTMLDialogElement's modal behavior — showModal/close/show are undefined.
// Polyfill just enough of the real browser contract (toggle the `open`
// attribute, set returnValue, fire the `close` event) for components that
// drive a native <dialog> to be testable.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
}

if (!HTMLDialogElement.prototype.show) {
  HTMLDialogElement.prototype.show = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
}

if (!HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement, returnValue?: string) {
    if (returnValue !== undefined) {
      this.returnValue = returnValue;
    }
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}
