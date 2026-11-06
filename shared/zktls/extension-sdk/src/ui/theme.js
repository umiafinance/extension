const STORAGE_KEY = "umiaTheme";

/**
 * Keeps `element.dataset.umiaTheme` at "light" or "dark". The Umia app mirrors its light/dark/system
 * choice into extension storage, since extension pages and provider pages cannot read its origin;
 * absent or "system" follows the OS. `ready` settles once the saved choice has been read.
 */
export function followTheme(element, { storage = globalThis.chrome?.storage, media } = {}) {
  const scheme = media ?? globalThis.matchMedia?.("(prefers-color-scheme: dark)");
  let saved;
  let changedSinceRead = false;

  const apply = () => {
    element.dataset.umiaTheme =
      saved === "light" || saved === "dark" ? saved : scheme?.matches ? "dark" : "light";
  };
  const onStorage = (changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    changedSinceRead = true;
    saved = changes[STORAGE_KEY].newValue;
    apply();
  };

  apply();
  scheme?.addEventListener?.("change", apply);
  storage?.onChanged?.addListener(onStorage);
  let read;
  try {
    read = Promise.resolve(storage?.local?.get(STORAGE_KEY));
  } catch (error) {
    read = Promise.reject(error);
  }
  const ready = read
    .then((stored) => {
      if (!changedSinceRead) saved = stored?.[STORAGE_KEY];
    })
    .catch(() => {})
    .then(apply);

  return {
    ready,
    dispose: () => {
      scheme?.removeEventListener?.("change", apply);
      storage?.onChanged?.removeListener(onStorage);
    },
  };
}
