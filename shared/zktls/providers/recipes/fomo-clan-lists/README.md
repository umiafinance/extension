# Fomo clan lists

Two independent providers in the `fomo` namespace, each accepting membership in **any one** of
its listed clans.

| Recipe | Eligible clans |
| --- | --- |
| `recommended.json` | The seven clans marked below |
| `all-listed.json` | All nineteen clans below |

"All listed" is a fixed allowlist, not every clan on Fomo. Clan names are display copy;
eligibility uses exact clan IDs, so a rename does not affect it. Changing either allowlist
requires a new recipe version.

| Clan | In `recommended.json` | Clan ID |
| --- | --- | --- |
| Sparsity | Yes | `87c22801-d5a6-4e9e-8f18-bceadf8b1040` |
| Fantom Troupe | Yes | `715a68a6-657e-4424-8c65-68ad3af899b1` |
| Risk On | Yes | `fc94d51d-4a71-4078-a635-77a11c94a2e9` |
| WAGMI | Yes | `ea30cc45-bc73-40d5-b909-9d2f49f9bace` |
| The Big Blue | Yes | `5481c4c8-b0fe-496a-b583-6890a677d5d5` |
| Boogle | Yes | `ec2aef5b-7370-4a5e-87c9-3053dba02458` |
| Dabal | Yes | `75cefc60-e6f6-4189-8073-18e7cb37db5d` |
| Unipcs | No | `7ec62252-3512-435d-a682-5941ee308cda` |
| HFT | No | `9769b8df-1a28-46d7-80e4-dc64f6377831` |
| Nobi Ventures | No | `11e5d07c-6f1d-4aa7-8a0d-aacf1c5f2033` |
| Grand | No | `e5857909-6100-4425-869f-681beb2be75b` |
| Prosperity Customer Funds | No | `d0f8fd50-ad7a-4138-b1d7-f25d685ec799` |
| Heaven | No | `80b2cce3-6a0f-47f5-a9e0-ef48baa81309` |
| UWU | No | `ee815f8f-7530-4e59-af85-26d9db5a6fe0` |
| One Life | No | `22952276-1424-4e49-806f-cdea7a1602ef` |
| BIN | No | `5f22ff37-534c-41bb-bbde-b51b1625280a` |
| Hedgooor | No | `80159dbe-a27d-49f3-8a16-322d054ddb7f` |
| IncelTradingDesk | No | `1ee52238-f464-41ac-ba2e-e7fb86237403` |
| Ender | No | `659b4a4b-5063-4815-b5bc-239109e68dd7` |

## Ownership and privacy

Each provider has one configuration with two required GET requests:

1. `/v2/users/current` proves the signed-in account.
2. `/v2/users/<uuid>` proves that account's clan membership.

The profile endpoint allows reading other accounts, so it cannot establish ownership alone.
Both requests capture the full account ID as `fomo_user` using `oprf-raw`, and the verifier
accepts the pair only when both captures name the same account.

The request chain waits for an authenticated `/v2/users/pin`, then derives the profile URL from
the session account. All five UUID segments are secret parameters, each at most twelve
characters, with explicit `writeRedactionMode: "zk"`, so no part of the UUID is public. The
revealed match rule contains the clan ID; which clan the account belongs to is not private.

## Tests

The SDK test suite checks every listed clan, the recommended provider's exclusions, rejection of
unknown, no-clan and lookalike IDs, identity extraction, full UUID hiding, request-chain
reconstruction and registry validation. These fixtures check the recipe against response
shapes; they are not a live proof.
