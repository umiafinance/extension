// Display copy per provider, keyed off a site: the grant page gets it from the background, the
// widget reads its own page's hostname. A site with no entry falls back to OTHER. `cantSee` must
// hold for the provider's recipes: only fields a recipe reveals reach Umia, and the GitHub
// recipes reveal none of these.

export const OTHER = {
  id: "other",
  label: null,
  title: "Prove you qualify",
  cantSee: ["Your password", "Anything else on your account"],
};

export const PROVIDERS = [
  {
    id: "github",
    label: "GitHub",
    hosts: ["github.com"],
    cantSee: ["Your password", "Your username, repos or messages"],
  },
  {
    id: "x",
    label: "X",
    hosts: ["x.com", "twitter.com"],
    cantSee: ["Your password", "Your posts or DMs"],
  },
  {
    id: "google",
    label: "Google",
    hosts: ["accounts.google.com"],
    cantSee: ["Your password", "Your email or files"],
  },
  {
    id: "luma",
    label: "Luma",
    hosts: ["lu.ma", "luma.com"],
    cantSee: ["Your password", "Your other events or guest lists"],
  },
  {
    id: "snapshot",
    label: "Snapshot",
    hosts: ["snapshot.box", "snapshot.org"],
    cantSee: ["Your wallet keys", "Your full voting history"],
  },
].map((provider) => ({ ...provider, title: `Prove you qualify with ${provider.label}` }));

/**
 * The provider behind a grant's comma-separated site list. A first grant can bundle the Umia
 * app and API with the provider's site; only one known provider among them picks its copy.
 */
export function providerForSites(sites) {
  const known = new Set(
    String(sites ?? "")
      .split(",")
      .map((site) => providerForSite(site.trim()))
      .filter((provider) => provider !== OTHER),
  );
  return known.size === 1 ? [...known][0] : OTHER;
}

export function providerForSite(site) {
  const host = String(site ?? "").toLowerCase();
  return PROVIDERS.find((p) => p.hosts.some((h) => host === h || host.endsWith(`.${h}`))) ?? OTHER;
}
