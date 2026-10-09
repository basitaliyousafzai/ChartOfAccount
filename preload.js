'use strict';

/**
 * Apex ERP — preload bridge.
 *
 * Exposes a single, minimal API to the renderer:
 *   window.erp.invoke(method, args) -> Promise<any>
 *
 * The main process rejects with an Error whose message is the JSON envelope
 * `{ code, message, details }` (Electron cannot ship custom properties over
 * ipc), so this bridge revives it into a real Error carrying `.code` and
 * `.details` for the UI. Runs with contextIsolation: true, nodeIntegration:
 * false — the renderer never sees a raw ipcRenderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Rebuild a `{ code, message, details }` error from a main-process rejection.
 * @param {any} err rejection value coming back from ipcRenderer.invoke
 * @returns {Error & { code?: string, details?: any }}
 */
function revive(err) {
  const raw =
    err && typeof err === 'object' && typeof err.message === 'string'
      ? err.message
      : String(err || '');

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const envelope = JSON.parse(raw.slice(start, end + 1));
      if (envelope && typeof envelope.message === 'string') {
        const code =
          typeof envelope.code === 'string' && envelope.code
            ? envelope.code
            : 'INTERNAL_ERROR';
        // The contextBridge clone of a thrown Error preserves ONLY `stack`
        // and `message` — custom properties (`.code`, `.details`, even `.name`)
        // are dropped before the renderer sees them. So the code is carried in
        // the message as a `CODE :: human text` envelope, and app.js
        // `asError()` strips it back off and restores `.code`.
        const revived = new Error(`${code} :: ${envelope.message}`);
        revived.name = 'KernelError';
        revived.code = code;
        revived.details = envelope.details;
        return revived;
      }
    } catch (_parseErr) {
      // not an envelope — fall through to the raw error below
    }
  }

  if (err instanceof Error) return err;
  const fallback = new Error(raw || 'IPC call failed');
  fallback.code = 'INTERNAL_ERROR';
  return fallback;
}

contextBridge.exposeInMainWorld('erp', {
  /**
   * Invoke a kernel method (docs/API_CONTRACT.md).
   * @param {string} method e.g. 'coa.tree'
   * @param {any} [args]
   * @returns {Promise<any>} resolves with the kernel's return value
   */
  invoke: (method, args) =>
    ipcRenderer.invoke('erp:invoke', method, args).catch((err) => {
      throw revive(err);
    }),
});
