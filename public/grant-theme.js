// Extension pages cannot read Hub's origin storage. The authenticated Hub channel
// copies its light/dark/system choice into extension-local storage; absent means system.
const themeKey = "umiaTheme";
let changedSinceRead = false;

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.umiaTheme = theme;
  else delete document.documentElement.dataset.umiaTheme;
  document.documentElement.dataset.umiaThemeReady = "true";
}

try {
  chrome.storage.local.get(themeKey).then((stored) => {
    if (!changedSinceRead) applyTheme(stored[themeKey]);
  }).catch(() => applyTheme("system"));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[themeKey]) {
      changedSinceRead = true;
      applyTheme(changes[themeKey].newValue);
    }
  });
} catch {
  applyTheme("system");
}
