import { useEffect } from "preact/hooks";

function setPageTitle(title: string) {
  document.title = title.slice(0, 1).toUpperCase() + title.slice(1);
}

/**
 * Utility hook for setting the page title
 * @param title Optionally sets the title on page load
 * @returns Utility methods related to the page title
 */
export function useTitle(title?: string) {
  useEffect(() => {
    if (title) {
      setPageTitle(title)
    }
  }, []);

  return {
    setPageTitle,
    resetPageTitle: () => document.title = 'Amazing Hashbrown'
  }
}