import assert from "node:assert/strict";
import { test } from "node:test";
import { compareArtifacts } from "./compare-artifacts.js";

const artifact = (files, extra = {}) => ({
  extensionVersion: "0.5.0",
  channel: "store",
  profileSetSha256: "p",
  canonicalAssetManifestSha256: "a",
  sourceSha: "monorepo",
  files,
  ...extra,
});

test("a rebuild matches when every file matches, whatever commit it came from", () => {
  const files = [{ path: "a.js", size: 1, sha256: "x" }];
  assert.deepEqual(compareArtifacts(artifact(files, { sourceSha: "mirror" }), artifact(files)), []);
  assert.deepEqual(
    compareArtifacts(
      artifact(
        [
          { path: "a.js", size: 1, sha256: "y" },
          { path: "b.js", size: 1, sha256: "z" },
        ],
        {
          channel: "dev",
        },
      ),
      artifact(files),
    ),
    ["differs: a.js", "not in the release: b.js", "channel differs"],
  );
});
