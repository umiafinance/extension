import { icons } from "@umia/zktls-extension-sdk/ui/icons.js";
import { OTHER, providerForSites } from "@umia/zktls-extension-sdk/ui/providers.js";
import { esc, mark } from "@umia/zktls-extension-sdk/ui/view-utils.js";
import github from "./providers/github.png";
import google from "./providers/google.png";
import luma from "./providers/luma.png";
import other from "./providers/other.png";
import snapshot from "./providers/snapshot.png";
import x from "./providers/x.png";

const LOGOS = { github, google, luma, other, snapshot, x };

// The site-access window (grant.html). Phases follow grantPage.js:
//
//   loading  until the background answers `ready` with the site and its origins
//   ready    buttons live; `locked` while Chrome's own permission prompt is open
//   granted  chrome.permissions.request resolved true; the flow resumes in the provider tab
//   expired  `expired`, a dropped port, or a missing pendingId

const connection = (provider, phase) => `
  <div class="umia-connection" data-phase="${phase}">
    ${mark(phase === "expired" ? "oops" : phase === "granted" ? "focus" : "peek", 56)}
    <span class="umia-connection__dots" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
    <span class="umia-provider-logo"><img src="${LOGOS[provider.id] ?? LOGOS.other}" alt="" /></span>
  </div>`;

const sees = (provider) => `
  <div class="umia-sees">
    <p class="umia-sees__label">Umia receives</p>
    <ul>
      <li data-kind="receives">${icons.check}Whether you qualify</li>
      <li data-kind="receives">${icons.check}A private tag to prevent reuse</li>
    </ul>
    <p class="umia-sees__label">Umia can't see</p>
    <ul>
      ${provider.cantSee.map((line) => `<li>${icons.eyeOff}${esc(line)}</li>`).join("")}
    </ul>
  </div>`;

const actions = (disabled) => `
  <div class="umia-approval__actions">
    <button type="button" class="umia-button" data-variant="outline" data-action="deny"${disabled ? " disabled" : ""}>Cancel</button>
    <button type="button" class="umia-button" data-variant="primary" data-action="grant"${disabled ? " disabled" : ""}>Allow access</button>
  </div>`;

const scope = (site) =>
  `The extension only works on ${site ? esc(site) : "the sites you allow"} during a check. Remove its access anytime in Chrome.`;

export function renderApproval({ phase, site, locked = false }) {
  const provider = phase === "loading" ? OTHER : providerForSites(site);
  let card;
  let footer = `<footer class="umia-approval__footer">${icons.lock}<p>${scope(site)}</p></footer>`;

  if (phase === "expired") {
    card = `${connection(provider, phase)}
      <div class="umia-approval__text">
        <h1>This check timed out</h1>
        <p>Close this window and start again from the auction.</p>
      </div>`;
    footer = "";
  } else {
    card = `${connection(provider, phase)}
      <div class="umia-approval__text">
        <h1>${esc(provider.title)}</h1>
        <p>${esc(`${provider.label ?? "The site"} opens next. Your browser does the check, and only the result reaches Umia.`)}</p>
      </div>
      ${sees(provider)}
      ${
        phase === "granted"
          ? `<p class="umia-approval__status">${icons.spinner}Opening ${esc(provider.label ?? "the site")}…</p>`
          : actions(phase === "loading" || locked)
      }`;
  }

  return `<section class="umia-approval" data-phase="${phase}">
    <div class="umia-approval__card">${card}</div>${footer}
  </section>`;
}
