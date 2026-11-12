// A new deploy replaces the build's files (their names carry a hash). A tab opened before the
// deploy still runs the old code, which asks for old file names the server no longer has, so a
// lazily loaded page or component fails to load ("Failed to fetch dynamically imported module").
// The cure is loading the new build: reload once. A short guard stops a reload loop if the
// files are missing for some other reason (the server down, a broken deploy).

const KEY = 'aj-stale-reload-at';
const GUARD_MS = 30_000;

const STALE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|ChunkLoadError|Loading chunk \S+ failed/i;

export const isStaleBuildError = (err) => STALE.test(String(err?.message || err || ''));

/** Reloads to the new build unless that was just tried. Returns true when a reload is on its way. */
export function reloadForNewBuild() {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < GUARD_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // storage blocked: reload anyway, the browser's own history guards against a tight loop
  }
  window.location.reload();
  return true;
}

// Vite fires this when a lazily imported file (or its CSS) fails to load.
export function watchForNewBuild() {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadForNewBuild()) event.preventDefault();
  });
  window.addEventListener('unhandledrejection', (event) => {
    if (isStaleBuildError(event.reason) && reloadForNewBuild()) event.preventDefault();
  });
}
