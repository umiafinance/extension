import "@umia/zktls-extension-sdk/ui/tokens.css";
import "@umia/zktls-extension-sdk/ui/base.css";
import "./approval.css";
import "./page.css";
import { installFonts } from "@umia/zktls-extension-sdk/ui/fonts.js";
import { followTheme } from "@umia/zktls-extension-sdk/ui/theme.js";
import { renderPreservingMarks } from "@umia/zktls-extension-sdk/ui/umia-mark.js";
import { renderApproval } from "./approval-view.js";
import { startGrantPage } from "./grantPage.js";

installFonts(document, chrome.runtime.getURL("reclaim-browser-extension-sdk/fonts/"));
followTheme(document.documentElement).ready.then(() => {
  document.documentElement.dataset.umiaThemeReady = "true";
});

const root = document.getElementById("view");
const page = startGrantPage({
  chrome,
  search: location.search,
  render: (view) => renderPreservingMarks(root, renderApproval(view)),
  setInterval,
  clearInterval,
});

root.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "grant") page.grant();
  if (action === "deny") page.deny();
});
