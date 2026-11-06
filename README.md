# Umia Extension

Source of the [Umia Chrome extension](https://chromewebstore.google.com/detail/umia/ejcaahfcaaiblipldkfijdcbannidbdd).
It generates the zkTLS proofs that verify eligibility for Umia auctions, in your own browser
session. What it can access and reveal: [privacy and security FAQ](https://umia.finance/docs/zktls-extension-privacy).

Every store version is an immutable [release](https://github.com/umiafinance/extension/releases)
here, and this repository rebuilds it byte for byte. You can check that the extension Chrome
installed is that build, and rebuild it yourself.

## Check your installed extension

Needs [`gh`](https://cli.github.com) and Node 22 or later. Set `tag` to the version shown in
`chrome://extensions`.

```bash
tag=v0.5.1
git clone https://github.com/umiafinance/extension && cd extension && git checkout "$tag"
gh release download "$tag" -D release && gh release verify "$tag"
(cd release && shasum -a 256 -c SHA256SUMS && unzip -q "umia-extension-$tag.zip" -d unzipped)
node web/extension/scripts/verify-install.js \
  "$HOME/Library/Application Support/Google/Chrome/Default/Extensions/ejcaahfcaaiblipldkfijdcbannidbdd/${tag#v}_0" \
  release/unzipped
```

On Linux the Chrome profile is `~/.config/google-chrome/Default`; on Windows,
`%LOCALAPPDATA%\Google\Chrome\User Data\Default`. Every file must match byte for byte, except the
`key` and `update_url` manifest fields and the `_metadata/` folder, which Chrome adds on install.

## Rebuild from source

In the same checkout, with [Bun](https://bun.sh) at the version in `package.json` (`packageManager`):

```bash
./build.sh
node web/extension/scripts/compare-artifacts.js \
  web/extension/dist/artifact-manifest.json release/artifact-manifest.json
```

`build.sh` installs the locked dependencies, downloads Reclaim's circuit files and checks their
SHA-256s, then builds the store extension. The two artifact manifests differ only in the commit
they record.

## Layout

| Path | Contents |
|---|---|
| `web/extension/` | The extension, and its build, release and verification scripts |
| `shared/zktls/extension-sdk/` | Umia's fork of Reclaim's browser extension SDK |
| `shared/zktls/config/` | The Umia app, API and attestor the extension trusts |
| `shared/zktls/providers/recipes/` | Provider recipes |
| `infra/aws/src/asset-mirror/` | Pinned circuit files with their SHA-256s, and the script that fetches them |

This repository is synced from Umia's monorepo; `.upstream-sha` names the source commit. The
extension is MIT licensed ([`web/extension/LICENSE`](web/extension/LICENSE)).
