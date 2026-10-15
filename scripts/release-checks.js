import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeOrigin } from "../src/callerOrigin.js";
import { sha256 } from "./artifact-files.js";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(extensionRoot, "../..");

const sorted = (values) => [...new Set(values ?? [])].sort();

function contentScriptFlags(entry) {
  return [
    entry.all_frames && "all_frames",
    entry.match_about_blank && "match_about_blank",
    entry.match_origin_as_fallback && "match_origin_as_fallback",
    entry.world && `world:${entry.world}`,
  ].filter(Boolean);
}

// Everything Chrome shows or re-prompts for, what web pages can reach (messaging and
// web-accessible files), and the CSPs.
export function permissionSurface(manifest) {
  const contentScripts = manifest.content_scripts ?? [];
  const accessible = manifest.web_accessible_resources ?? [];
  return {
    permissions: sorted(manifest.permissions),
    optionalPermissions: sorted(manifest.optional_permissions),
    hostPermissions: sorted(manifest.host_permissions),
    optionalHostPermissions: sorted(manifest.optional_host_permissions),
    contentScriptMatches: sorted(contentScripts.flatMap((entry) => entry.matches ?? [])),
    contentScriptFlags: sorted(contentScripts.flatMap(contentScriptFlags)),
    externallyConnectableMatches: sorted(manifest.externally_connectable?.matches),
    externallyConnectableIds: sorted(manifest.externally_connectable?.ids),
    webAccessibleResources: sorted(accessible.flatMap((entry) => entry.resources ?? [])),
    webAccessibleResourceMatches: sorted(accessible.flatMap((entry) => entry.matches ?? [])),
    webAccessibleResourceDynamicUrls: sorted(
      accessible.filter((entry) => entry.use_dynamic_url).flatMap((entry) => entry.resources ?? []),
    ),
    extensionPagesCsp: manifest.content_security_policy?.extension_pages ?? null,
    sandboxCsp: manifest.content_security_policy?.sandbox ?? null,
  };
}

// A built manifest's caller origins come from its attested endpoint profiles, never wider.
export function builtCallerMatches(endpointProfiles) {
  return sorted(
    (endpointProfiles ?? []).map((profile) => {
      const origin = normalizeOrigin(profile.callerOrigin);
      if (!origin) throw new Error("artifact caller origin is not canonical HTTPS");
      return `${origin}/*`;
    }),
  );
}

export function assertPermissionBaseline(manifest, baseline, overrides = {}) {
  const actual = permissionSurface(manifest);
  const changes = [];
  for (const [key, value] of Object.entries(actual)) {
    const reviewed = Object.hasOwn(overrides, key) ? overrides[key] : baseline[key];
    if (Array.isArray(value)) {
      const expected = new Set(reviewed ?? []);
      const added = value.filter((item) => !expected.has(item));
      const removed = [...expected].filter((item) => !value.includes(item));
      if (added.length) changes.push(`${key} added ${added.join(", ")}`);
      if (removed.length) changes.push(`${key} removed ${removed.join(", ")}`);
    } else if (value !== reviewed) {
      changes.push(`${key} changed`);
    }
  }
  if (changes.length) {
    throw new Error(
      `manifest permissions differ from release-baseline.json: ${changes.join("; ")}`,
    );
  }
}

export function assertVersionParity({ manifest, packageJson, sdkPackage, baseline, artifact }) {
  const mismatches = [];
  if (manifest.version !== packageJson.version) mismatches.push("manifest vs package.json");
  if (packageJson.dependencies?.[baseline.sdk.name] !== "workspace:*") {
    mismatches.push("extension does not depend on the workspace SDK");
  }
  if (sdkPackage.name !== baseline.sdk.name || sdkPackage.version !== baseline.sdk.version) {
    mismatches.push("SDK version vs reviewed pin");
  }
  if (
    sdkPackage.dependencies?.["@reclaimprotocol/attestor-core"] !== baseline.sdk.attestorVersion
  ) {
    mismatches.push("attestor-core vs reviewed pin");
  }
  if (artifact) {
    if (artifact.extensionVersion !== manifest.version) mismatches.push("artifact extension");
    if (artifact.sdkVersion !== baseline.sdk.version) mismatches.push("artifact SDK");
    if (artifact.attestorVersion !== baseline.sdk.attestorVersion) {
      mismatches.push("artifact attestor-core");
    }
  }
  if (mismatches.length) throw new Error(`release versions differ: ${mismatches.join("; ")}`);
}

// The package must hold exactly the attested files plus the attestation itself.
export function assertPackageMatchesArtifact(entries, artifact) {
  const byPath = new Map();
  for (const entry of entries) {
    if (byPath.has(entry.path)) throw new Error(`duplicate package entry: ${entry.path}`);
    byPath.set(entry.path, entry.bytes);
  }
  const attestation = byPath.get("artifact-manifest.json");
  if (!attestation || JSON.stringify(JSON.parse(attestation)) !== JSON.stringify(artifact)) {
    throw new Error("package does not carry this artifact manifest");
  }
  byPath.delete("artifact-manifest.json");
  for (const file of artifact.files) {
    const bytes = byPath.get(file.path);
    if (!bytes || bytes.length !== file.size || sha256(bytes) !== file.sha256) {
      throw new Error(`package file missing or altered: ${file.path}`);
    }
    byPath.delete(file.path);
  }
  if (byPath.size)
    throw new Error(`package has unattested files: ${[...byPath.keys()].join(", ")}`);
}

export function forbiddenHostPattern(scanScript) {
  const match = /^forbidden='([^']+)'$/m.exec(scanScript);
  if (!match) throw new Error("domain-scan forbidden list not found");
  return new RegExp(match[1]);
}

// Each requested API permission needs its own justification bullet, and no other.
export function assertStoreListingPermissions(storeListing, manifest) {
  const section = /## Permission justifications[^\n]*\n([\s\S]*?)\n## /.exec(storeListing)?.[1];
  if (!section) throw new Error("STORE_LISTING.md has no permission justifications section");
  const justified = sorted(
    [...section.matchAll(/^- \*\*`([a-zA-Z]+)`:\*\*/gm)].map((match) => match[1]),
  );
  const requested = sorted([
    ...(manifest.permissions ?? []),
    ...(manifest.optional_permissions ?? []),
  ]);
  if (JSON.stringify(justified) !== JSON.stringify(requested)) {
    throw new Error(
      `STORE_LISTING.md justifies [${justified.join(", ")}] but the manifest requests [${requested.join(", ")}]`,
    );
  }
  for (const pattern of manifest.optional_host_permissions ?? []) {
    if (!section.includes(`\`${pattern}\``)) {
      throw new Error(`STORE_LISTING.md does not justify optional host ${pattern}`);
    }
  }
}

export function assertPrivacyDisclosure(privacy, forbidden) {
  const hit = forbidden.exec(privacy);
  if (hit) throw new Error(`PRIVACY.md names a forbidden endpoint: ${hit[0]}`);
  for (const [url] of privacy.matchAll(/https?:\/\/[^\s)>\]`]+/g)) {
    // Host-permission match patterns such as https://*/* are scopes, not endpoints.
    if (url.includes("*")) continue;
    const { hostname } = new URL(url);
    if (hostname !== "umia.finance" && !hostname.endsWith(".umia.finance")) {
      throw new Error(`PRIVACY.md names a non-Umia endpoint: ${hostname}`);
    }
  }
  for (const disclosure of ["telemetry", "attestor"]) {
    if (!privacy.toLowerCase().includes(disclosure)) {
      throw new Error(`PRIVACY.md does not disclose ${disclosure} traffic`);
    }
  }
}

export function readReleaseSources(root = extensionRoot, repo = repoRoot) {
  const json = (path) => JSON.parse(readFileSync(path, "utf8"));
  return {
    manifest: json(join(root, "public/manifest.json")),
    packageJson: json(join(root, "package.json")),
    baseline: json(join(root, "release-baseline.json")),
    sdkPackage: json(join(repo, "shared/zktls/extension-sdk/package.json")),
    storeListing: readFileSync(join(root, "STORE_LISTING.md"), "utf8"),
    privacy: readFileSync(join(root, "PRIVACY.md"), "utf8"),
    forbidden: forbiddenHostPattern(
      readFileSync(join(repo, "scripts/zktls-sdk-domain-scan.sh"), "utf8"),
    ),
  };
}

export function checkReleaseSources(sources) {
  assertPermissionBaseline(sources.manifest, sources.baseline);
  assertVersionParity(sources);
  assertStoreListingPermissions(sources.storeListing, sources.manifest);
  assertPrivacyDisclosure(sources.privacy, sources.forbidden);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkReleaseSources(readReleaseSources());
    console.log("[extension release] permissions, versions, store listing and privacy agree");
  } catch (error) {
    console.error(`[extension release] ${error.message}`);
    process.exitCode = 1;
  }
}
