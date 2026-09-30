import assert from "node:assert/strict";
import test from "node:test";

import { authorizeTenantFacebookPublishingRequest } from "../../netlify/functions/_tenant-facebook-auth.mjs";
import { hashTenantAccessKey } from "../../netlify/functions/_tenant-auth.mjs";
import {
  FacebookPublishingError,
  publishFacebookPagePost,
  verifyFacebookPublishingPage,
} from "../../netlify/functions/_facebook-publishing.mjs";
import { createTenantFacebookConnectionHandler } from "../../netlify/functions/tenant-facebook-connection.mjs";
import { createTenantFacebookPublishHandler } from "../../netlify/functions/tenant-facebook-publish.mjs";

const ORIGIN = "https://deploy-preview-18--euphonious-beijinho-db4b4d.netlify.app";
const BUSINESS_ID = "north-star-books-abcdef123456";
const OTHER_ID = "other-business-abcdef123456";
const NOW = new Date("2026-09-27T15:00:00.000Z");
const TENANT_KEY = `gw_tenant_${"A".repeat(43)}`;

function request(path, body = null, method = body ? "POST" : "GET") {
  return new Request(ORIGIN + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function allowed() {
  return async (_request, { businessId }) => ({
    ok: true,
    via: "tenant",
    businessId,
    entitlements: { feature_access: { automated_publishing: true } },
  });
}

test("Facebook publishing entitlement stays tenant-bound and plan-bound", async () => {
  const tenantStore = {
    async readTenantAuth({ businessId }) {
      return businessId === BUSINESS_ID
        ? { business_id: BUSINESS_ID, access_key_hash: hashTenantAccessKey(TENANT_KEY) }
        : null;
    },
  };
  const tenantRequest = new Request(ORIGIN, {
    headers: { "x-growthwise-tenant-key": TENANT_KEY },
  });

  const founding = await authorizeTenantFacebookPublishingRequest(tenantRequest, {
    businessId: BUSINESS_ID,
    tenantStore,
    billingStore: {
      async readSubscription() {
        return {
          business_id: BUSINESS_ID,
          access_source: "pilot",
          plan_key: "founding_monthly",
          status: "pilot",
        };
      },
    },
    now: NOW,
  });
  assert.equal(founding.ok, true);
  assert.equal(founding.businessId, BUSINESS_ID);

  const starter = await authorizeTenantFacebookPublishingRequest(tenantRequest, {
    businessId: BUSINESS_ID,
    tenantStore,
    billingStore: {
      async readSubscription() {
        return {
          business_id: BUSINESS_ID,
          access_source: "stripe",
          plan_key: "starter_monthly",
          status: "active",
        };
      },
    },
    now: NOW,
  });
  assert.equal(starter.ok, false);
  assert.equal(starter.via, "locked");

  const otherTenant = await authorizeTenantFacebookPublishingRequest(tenantRequest, {
    businessId: OTHER_ID,
    tenantStore,
    billingStore: {
      async readSubscription() {
        throw new Error("should not read billing");
      },
    },
    now: NOW,
  });
  assert.equal(otherTenant.ok, false);
  assert.equal(otherTenant.via, "none");
});

test("Facebook provider helper verifies the exact connected Page without exposing the token", async () => {
  const calls = [];
  const result = await verifyFacebookPublishingPage({
    pageId: "page-123",
    pageAccessToken: "PAGE_SECRET",
    graphVersion: "v26.0",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "page-123", name: "North Star Books" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(result, { pageId: "page-123", pageName: "North Star Books" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v26\.0\/page-123\?fields=id,name$/);
  assert.equal(calls[0].init.headers.Authorization, "Bearer PAGE_SECRET");
  assert.equal(JSON.stringify(result).includes("PAGE_SECRET"), false);
});

test("Facebook provider helper publishes reviewed text without returning provider credentials", async () => {
  const calls = [];
  const result = await publishFacebookPagePost({
    pageId: "page-123",
    pageAccessToken: "PAGE_SECRET",
    graphVersion: "v26.0",
    message: "New arrivals are here.",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "page-123_456" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(result, {
    postType: "text",
    postId: "page-123_456",
    photoCount: 0,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/page-123\/feed$/);
  assert.equal(calls[0].init.headers.Authorization, "Bearer PAGE_SECRET");
  assert.equal(String(calls[0].init.body), "message=New+arrivals+are+here.");
  assert.equal(JSON.stringify(result).includes("PAGE_SECRET"), false);
});

test("Facebook provider helper maps expired authorization to reconnect-required", async () => {
  await assert.rejects(
    () => verifyFacebookPublishingPage({
      pageId: "page-123",
      pageAccessToken: "EXPIRED",
      fetchImpl: async () => new Response(JSON.stringify({
        error: { code: 190, message: "provider detail should not escape" },
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    }),
    (error) => {
      assert.equal(error instanceof FacebookPublishingError, true);
      assert.equal(error.code, "FACEBOOK_RECONNECT_REQUIRED");
      assert.equal(error.httpStatus, 409);
      assert.doesNotMatch(error.message, /provider detail/i);
      return true;
    },
  );
});

test("tenant Facebook status exposes Page name but never stored credentials", async () => {
  const handler = createTenantFacebookConnectionHandler({
    authorize: allowed(),
    now: () => NOW,
    crypto: {},
    store: {
      async readCredential({ businessId }) {
        assert.equal(businessId, BUSINESS_ID);
        return {
          business_id: BUSINESS_ID,
          status: "active",
          page_name: "North Star Books",
          encrypted_credential: { ciphertext: "SECRET_CIPHERTEXT" },
          last_verified_at: NOW,
        };
      },
    },
  });

  const response = await handler(request(
    "/.netlify/functions/tenant-facebook-connection?business_id=" + BUSINESS_ID,
  ));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.state, "Connected");
  assert.equal(body.account.page_name, "North Star Books");
  assert.equal(JSON.stringify(body).includes("SECRET_CIPHERTEXT"), false);
});

test("tenant Facebook publish rejects non-JSON and oversized requests before authorization", async () => {
  let authCalls = 0;
  const handler = createTenantFacebookPublishHandler({
    authorize: async () => {
      authCalls += 1;
      return { ok: true, via: "tenant", businessId: BUSINESS_ID };
    },
  });

  const wrongType = await handler(new Request(
    ORIGIN + "/.netlify/functions/tenant-facebook-publish",
    {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    },
  ));
  assert.equal(wrongType.status, 415);

  const oversized = await handler(new Request(
    ORIGIN + "/.netlify/functions/tenant-facebook-publish",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(33 * 1024 * 1024),
      },
      body: "{}",
    },
  ));
  assert.equal(oversized.status, 413);
  assert.equal(authCalls, 0);
});

test("tenant Facebook publish requires explicit human review before any credential read", async () => {
  let reads = 0;
  const handler = createTenantFacebookPublishHandler({
    authorize: allowed(),
    crypto: {},
    store: {
      async readDecryptedCredential() {
        reads += 1;
        return null;
      },
    },
  });

  const response = await handler(request("/.netlify/functions/tenant-facebook-publish", {
    business_id: BUSINESS_ID,
    reviewed: false,
    message: "Do not publish this.",
  }));
  assert.equal(response.status, 400);
  assert.equal(reads, 0);
});

test("tenant Facebook publish cannot publish another business through a mismatched authorization", async () => {
  let reads = 0;
  const handler = createTenantFacebookPublishHandler({
    authorize: async () => ({ ok: true, via: "tenant", businessId: OTHER_ID }),
    crypto: {},
    store: {
      async readDecryptedCredential() {
        reads += 1;
        return null;
      },
    },
  });

  const response = await handler(request("/.netlify/functions/tenant-facebook-publish", {
    business_id: BUSINESS_ID,
    reviewed: true,
    message: "Reviewed post.",
  }));
  assert.equal(response.status, 401);
  assert.equal(reads, 0);
});

test("tenant Facebook publish uses only the tenant-bound stored Page credential", async () => {
  const calls = [];
  let health = null;
  const handler = createTenantFacebookPublishHandler({
    authorize: allowed(),
    now: () => NOW,
    crypto: {},
    store: {
      async readDecryptedCredential({ businessId }) {
        assert.equal(businessId, BUSINESS_ID);
        return {
          business_id: BUSINESS_ID,
          status: "active",
          page_name: "North Star Books",
          payload: {
            page_id: "page-123",
            page_access_token: "PAGE_SECRET",
            graph_version: "v26.0",
            permissions: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
          },
        };
      },
      async updateCredentialHealth(input) {
        health = input;
        return input;
      },
    },
    verifyPage: async (input) => {
      calls.push({ stage: "verify", ...input });
      return { pageId: "page-123", pageName: "North Star Books" };
    },
    publishPost: async (input) => {
      calls.push({ stage: "publish", ...input });
      return { postType: "text", postId: "page-123_789", photoCount: 0 };
    },
  });

  const response = await handler(request("/.netlify/functions/tenant-facebook-publish", {
    business_id: BUSINESS_ID,
    reviewed: true,
    message: "Reviewed customer-facing post.",
    expected_page_name: "North Star Books",
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: true,
    business_id: BUSINESS_ID,
    page_name: "North Star Books",
    post_type: "text",
    post_id: "page-123_789",
    photo_count: 0,
  });
  assert.equal(calls[0].pageId, "page-123");
  assert.equal(calls[0].pageAccessToken, "PAGE_SECRET");
  assert.equal(calls[1].pageId, "page-123");
  assert.equal(calls[1].pageAccessToken, "PAGE_SECRET");
  assert.equal(calls[1].message, "Reviewed customer-facing post.");
  assert.equal(health.status, "active");
  assert.equal(JSON.stringify(body).includes("PAGE_SECRET"), false);
});

test("tenant Facebook publish blocks a Page-name mismatch before publishing", async () => {
  let published = false;
  const handler = createTenantFacebookPublishHandler({
    authorize: allowed(),
    crypto: {},
    store: {
      async readDecryptedCredential() {
        return {
          business_id: BUSINESS_ID,
          status: "active",
          page_name: "Stored Page",
          payload: {
            page_id: "page-123",
            page_access_token: "PAGE_SECRET",
            permissions: ["pages_manage_posts"],
          },
        };
      },
    },
    verifyPage: async () => ({ pageId: "page-123", pageName: "Different Page" }),
    publishPost: async () => {
      published = true;
      return { postType: "text", postId: "unexpected", photoCount: 0 };
    },
  });

  const response = await handler(request("/.netlify/functions/tenant-facebook-publish", {
    business_id: BUSINESS_ID,
    reviewed: true,
    message: "Reviewed post.",
    expected_page_name: "Stored Page",
  }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "FACEBOOK_PAGE_MISMATCH");
  assert.equal(published, false);
});

test("tenant Facebook publish marks connection needs-attention after provider auth expiry", async () => {
  let health = null;
  const handler = createTenantFacebookPublishHandler({
    authorize: allowed(),
    now: () => NOW,
    crypto: {},
    store: {
      async readDecryptedCredential() {
        return {
          business_id: BUSINESS_ID,
          status: "active",
          page_name: "North Star Books",
          payload: {
            page_id: "page-123",
            page_access_token: "PAGE_SECRET",
            permissions: ["pages_manage_posts"],
          },
        };
      },
      async updateCredentialHealth(input) {
        health = input;
        return input;
      },
    },
    verifyPage: async () => {
      throw new FacebookPublishingError(
        "FACEBOOK_RECONNECT_REQUIRED",
        "Facebook authorization expired. Reconnect this business's Facebook Page.",
        { httpStatus: 409, providerCode: 190 },
      );
    },
  });

  const response = await handler(request("/.netlify/functions/tenant-facebook-publish", {
    business_id: BUSINESS_ID,
    reviewed: true,
    message: "Reviewed post.",
  }));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "FACEBOOK_RECONNECT_REQUIRED");
  assert.equal(health.status, "needs_attention");
  assert.equal(JSON.stringify(body).includes("PAGE_SECRET"), false);
});
