import { MATCH_STAGES } from "../utils/claim-creator/network-filter.js";

const FOMO_ACCOUNT_MATCH = '"responseObject":{"id":"{{fomo_user}}","address":"';
const GITHUB_ACTOR_MATCH = '<meta name="octolytics-actor-id" content="{{github_actor_id}}" />';
const GITHUB_COUNT_FIELDS = new Map([
  ['"totalCount":(?:[1-9][0-9]*)\\b', "totalCount"],
  ['"totalCount":(?:[5-9]|[1-9][0-9]+)\\b', "totalCount"],
  ['"result_count":(?:[1-9][0-9]*)\\b', "result_count"],
]);

/**
 * A complete, successful response that proved the account but failed the recipe's
 * eligibility rule. Only reviewed recipe shapes qualify; others stay inconclusive
 * until they have their own explicit failure evidence.
 */
export function isEligibilityResponseMismatch(criteria, verdict, response, matchedResponses = []) {
  if (
    verdict?.stage !== MATCH_STAGES.RESPONSE_MATCH ||
    verdict.failedMatchIndex !== 1 ||
    !isSuccessful(response)
  ) {
    return false;
  }
  return criteria?.responseMatches?.[0]?.value === FOMO_ACCOUNT_MATCH
    ? isFomoProfileMismatch(response.body, matchedResponses)
    : isGithubCountMismatch(criteria, response.body);
}

function isSuccessful(response) {
  return (
    Number.isInteger(response?.status) &&
    response.status >= 200 &&
    response.status < 300 &&
    typeof response.body === "string"
  );
}

/** A missing rule is conclusive once the numeric search count is present exactly once. */
function isGithubCountMismatch(criteria, body) {
  if (
    criteria?.responseVariables?.length !== 1 ||
    criteria.responseVariables[0] !== "github_actor_id" ||
    criteria?.responseMatches?.length !== 2 ||
    criteria.responseMatches[0].type !== "contains" ||
    criteria.responseMatches[0].value !== GITHUB_ACTOR_MATCH
  ) {
    return false;
  }

  const rule = criteria.responseMatches[1];
  const field = rule?.type === "regex" ? GITHUB_COUNT_FIELDS.get(rule.value) : null;
  if (!field) return false;
  const counts = [...body.matchAll(new RegExp(`"${field}":([0-9]+)\\b`, "g"))];
  return counts.length === 1 && Number.isSafeInteger(Number(counts[0][1]));
}

/**
 * The signed-in account's own profile cannot start matching later in the session.
 * Other users' profiles are readable too, so the account must be the one the
 * matched `/v2/users/current` response proved.
 */
function isFomoProfileMismatch(body, matchedResponses) {
  const id = fomoAccountId(body);
  return (
    id !== null &&
    matchedResponses.some(
      ({ criteria, response }) =>
        criteria?.responseMatches?.length === 1 &&
        criteria.responseMatches[0].value === FOMO_ACCOUNT_MATCH &&
        isSuccessful(response) &&
        fomoAccountId(response.body) === id,
    )
  );
}

function fomoAccountId(body) {
  try {
    const id = JSON.parse(body)?.responseObject?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
