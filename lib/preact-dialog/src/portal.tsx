import { ContainerNode, VNode } from 'preact';
import compat from 'preact/compat';

/**
 * Helper method for using portals.  This will find or create a portal attached to
 * a specific parent container in the DOM.  If the parent cannot be found, it will attach
 * the portal to the document body and emit a warning
 * @param selector CSS Selector for the parent component
 * @returns A pre-wrapped createPortal helper function
 */
export function usePortal(selector: string) {
  const parentElement = compat.useMemo(() => {
    const parent = document.querySelector(selector);

    if (!parent) {
      console.warn(
        `Could not find portal container: "${selector}" - Falling back to document body`,
      );
      return document.body;
    }

    return parent;
  }, [selector]);

  return (component: VNode) => {
    return compat.createPortal(component, parentElement);
  };
}
