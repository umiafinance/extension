# Echo participant

`echo.json` is one provider with one request in the `echo` namespace. It proves that one
signed-in Echo account has put a nonzero amount into Echo rounds.

## The request

`GET https://app.echo.xyz/portfolio/<uuid>/current` is the signed-in account's portfolio page.
It needs a session. The page server-renders three summary figures and the account's email:

- **Contributions**, the total put into rounds. The response must show it as a dollar amount
  with a nonzero leading digit, so a `$0` portfolio does not match.
- **Performance** and **Current value** move with prices, and Current value does not always
  resolve in the server render. The recipe reads neither.
- **`EmailAddress`** in the embedded user object is the account capture, hashed with `oprf-raw`
  under the `echouser` key.

The portfolio UUID is not the identity: it sits in the URL path, so hashing it would leak the
value the OPRF is meant to hide. All five hyphen-separated UUID groups are secret URL parameters
(`URL_PARAM_1_SECRET` through `URL_PARAM_5_SECRET`), so only the hyphens are visible and the
longest hidden run is 12 bytes. The attestor limits each contiguous hidden run in a URL path;
a secret covering more of the UUID exceeds that limit.

`writeRedactionMode: "zk"` keeps the path literals visible. The default key-update mode can hide
them as well, which also exceeds the limit. No other request-derived parameter is public, and the
recipe sets no proxy geography.

## Revealed and hidden

Claim parameters are public wherever the proof travels, so the table describes the signed claim.

| Value | In the signed claim |
| --- | --- |
| That Contributions is a nonzero dollar amount | Revealed, as the match rule |
| The Contributions amount | Not included; the attestor reads it only to check the rule |
| The account email | Hidden; only its OPRF pseudonym is signed |
| The portfolio UUID in the URL | Hidden; all five UUID groups are secret parameters |
| Performance, Current value and the rest of the page | Hidden; outside the revealed ranges |
