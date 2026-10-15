// Preference failure must not throw through a writing-state update.
let warning: string | null = null;
export const preferenceStorageWarning = () => warning;
function report(error: unknown) {
  const message = error ? "Settings couldn’t be saved on this computer. Your writing is still open." : null;
  if (message === warning) return;
  warning = message;
  queueMicrotask(() => window.dispatchEvent(new Event("ambertext:preference-storage")));
}
export const preferenceStorage = {
  getItem(key: string) {
    try { return localStorage.getItem(key); }
    catch (error) { report(error); return null; }
  },
  setItem(key: string, value: string) {
    try { localStorage.setItem(key, value); report(null); }
    catch (error) { report(error); }
  },
  removeItem(key: string) {
    try { localStorage.removeItem(key); }
    catch (error) { report(error); }
  },
};
