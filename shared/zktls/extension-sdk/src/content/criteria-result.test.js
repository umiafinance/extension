import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { describeRequestMatch } from "../utils/claim-creator/network-filter.js";
import { isEligibilityResponseMismatch } from "./criteria-result.js";

describe("eligibility mismatch evidence", () => {
  const actor = '<meta name="octolytics-actor-id" content="123" />';
  const rules = {
    url: "https://github.com/search",
    method: "GET",
    responseVariables: ["github_actor_id"],
    responseMatches: [
      {
        type: "contains",
        value: '<meta name="octolytics-actor-id" content="{{github_actor_id}}" />',
      },
      { type: "regex", value: '"totalCount":(?:[5-9]|[1-9][0-9]+)\\b' },
    ],
  };
  const check = (body, status = 200, config = rules) => {
    const verdict = describeRequestMatch(
      { url: config.url, method: "GET", responseText: body },
      config,
    );
    return isEligibilityResponseMismatch(config, verdict, { status, body });
  };

  it("accepts a completed authenticated response with a below-threshold count", () => {
    assert.equal(check(`${actor}"totalCount":3`), true);
    assert.equal(check(`${actor}"totalCount":5`), false);
    const maintainer = {
      ...rules,
      responseMatches: [
        rules.responseMatches[0],
        { type: "regex", value: '"result_count":(?:[1-9][0-9]*)\\b' },
      ],
    };
    assert.equal(check(`${actor}"result_count":0`, 200, maintainer), true);
  });

  it("recognizes every current GitHub search recipe", () => {
    const directory = new URL("../../../providers/recipes/github-2026q3/", import.meta.url);
    const recipes = readdirSync(directory).filter((name) => name.endsWith(".json"));
    assert.ok(recipes.length > 0);
    for (const file of recipes) {
      const recipe = JSON.parse(readFileSync(new URL(file, directory), "utf8"));
      const config = recipe.providerConfigs[0].requestData[0];
      const field = config.responseMatches[1].value.includes("result_count")
        ? "result_count"
        : "totalCount";
      assert.equal(check(`${actor}"${field}":0`, 200, config), true, file);
    }
  });

  it("ignores sign-in, loading, error, and ambiguous responses", () => {
    assert.equal(check('"totalCount":0'), false, "no authenticated actor");
    assert.equal(check(actor), false, "the count has not loaded");
    assert.equal(check(`${actor}"totalCount":0`, 401), false, "HTTP failure");
    assert.equal(check(`${actor}"totalCount":0"totalCount":0`), false, "ambiguous count");
    assert.equal(check(`${actor}"totalCount":0`, 200, { ...rules, responseVariables: [] }), false);
    assert.equal(
      check(`${actor}"otherCount":0`, 200, {
        ...rules,
        responseMatches: [rules.responseMatches[0], { type: "regex", value: '"otherCount":[1-9]' }],
      }),
      false,
      "unreviewed recipe shape",
    );
  });

  describe("FOMO profile recipes", () => {
    const USER = "d16c8d0d-0000-4000-8000-000000000001";
    const OTHER = "0afc9a35-0000-4000-8000-000000000002";
    const directory = new URL("../../../providers/recipes/", import.meta.url);
    const recipes = ["fomo-hold-time", "fomo-clans", "fomo-clan-lists"].flatMap((folder) =>
      readdirSync(new URL(`${folder}/`, directory))
        .filter((name) => name.endsWith(".json"))
        .map((name) => `${folder}/${name}`),
    );
    const load = (file) =>
      JSON.parse(readFileSync(new URL(file, directory), "utf8")).providerConfigs[0].requestData;
    const body = (id, fields) =>
      JSON.stringify({
        success: true,
        responseObject: { id, address: "0xabc", ...fields, followsCurrentUser: false },
      });
    const check = (
      requests,
      responseBody,
      { status = 200, signedIn = USER, signedInStatus = 200 } = {},
    ) => {
      const [account, profile] = requests;
      const matched = signedIn
        ? [{ criteria: account, response: { status: signedInStatus, body: body(signedIn, {}) } }]
        : [];
      const verdict = describeRequestMatch(
        { url: `https://prod-api.fomo.family/v2/users/${USER}`, method: "GET", responseText: responseBody },
        profile,
      );
      return isEligibilityResponseMismatch(profile, verdict, { status, body: responseBody }, matched);
    };
    const holdTime = load("fomo-hold-time/more-than-5-days.json");

    it("fails a loaded own profile that does not meet the rule", () => {
      assert.ok(recipes.length >= 6);
      for (const file of recipes) {
        const requests = load(file);
        const missed = file.endsWith("no-clan.json")
          ? { clan: { id: OTHER, name: "x" } }
          : { averageHoldTimeSeconds: null, clan: null };
        assert.equal(check(requests, body(USER, missed)), true, file);
      }
      assert.equal(check(holdTime, body(USER, { averageHoldTimeSeconds: 3600, clan: null })), true);
      assert.equal(check(holdTime, body(USER, { clan: null })), true, "no hold time");
      assert.equal(check(holdTime, body(USER, { averageHoldTimeSeconds: 432001, clan: null })), false);
    });

    it("waits for the signed-in account and ignores other users and failed responses", () => {
      const missed = body(USER, { averageHoldTimeSeconds: 0 });
      assert.equal(check(holdTime, missed, { signedIn: null }), false, "account not proven yet");
      assert.equal(check(holdTime, missed, { signedIn: OTHER }), false, "another user's profile");
      assert.equal(check(holdTime, missed, { signedInStatus: 431 }), false, "account request failed");
      assert.equal(check(holdTime, missed, { status: 431 }), false, "HTTP failure");
      assert.equal(check(holdTime, "not json"), false, "unparseable");
    });
  });
});
