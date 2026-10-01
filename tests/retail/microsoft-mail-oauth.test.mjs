import assert from "node:assert/strict";
import test from "node:test";

import {
  MICROSOFT_MAIL_SCOPES,
  buildMicrosoftMailAuthorizationUrl,
  exchangeMicrosoftMailAuthorizationCode,
  refreshMicrosoftMailToken,
  verifyMicrosoftMailboxIdentity,
} from "../../netlify/functions/_microsoft-mail-oauth.mjs";

const callback = "https://preview.example/.netlify/functions/microsoft-mail-oauth-callback";

test("Microsoft authorization supports personal Hotmail and Microsoft 365 through the common endpoint", () => {
  const url = new URL(buildMicrosoftMailAuthorizationUrl({
    clientId: "client-123",
    callbackUri: callback,
    state: "state-123",
  }));

  assert.equal(url.origin, "https://login.microsoftonline.com");
  assert.equal(url.pathname, "/common/oauth2/v2.0/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("response_mode"), "query");
  assert.equal(url.searchParams.get("redirect_uri"), callback);
  assert.equal(url.searchParams.get("scope"), MICROSOFT_MAIL_SCOPES.join(" "));
  assert.equal(url.searchParams.get("prompt"), "select_account");
});

test("Microsoft mail scope is read-only and never requests send or write access", () => {
  assert.ok(MICROSOFT_MAIL_SCOPES.includes("Mail.Read"));
  assert.ok(MICROSOFT_MAIL_SCOPES.includes("offline_access"));
  assert.ok(MICROSOFT_MAIL_SCOPES.includes("User.Read"));
  assert.ok(!MICROSOFT_MAIL_SCOPES.includes("Mail.Send"));
  assert.ok(!MICROSOFT_MAIL_SCOPES.includes("Mail.ReadWrite"));
});

test("authorization code exchange requires access refresh expiry and Mail.Read", async () => {
  const calls = [];
  const result = await exchangeMicrosoftMailAuthorizationCode({
    clientId: "client",
    clientSecret: "secret",
    callbackUri: callback,
    code: "code",
    fetchImpl: async (url, init) => {
      calls.push({ url:String(url), init });
      return new Response(JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid profile offline_access User.Read Mail.Read",
      }), { status: 200 });
    },
  });

  assert.equal(result.accessToken, "access");
  assert.equal(result.refreshToken, "refresh");
  assert.equal(result.expiresInSeconds, 3600);
  assert.ok(result.scope.includes("Mail.Read"));
  assert.equal(calls.length, 1);
  assert.match(calls[0].init.body, /grant_type=authorization_code/);
  assert.match(calls[0].init.body, /client_secret=secret/);
});

test("refresh token flow preserves read-only scopes", async () => {
  const result = await refreshMicrosoftMailToken({
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh-old",
    fetchImpl: async () => new Response(JSON.stringify({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "openid profile offline_access User.Read Mail.Read",
    }), { status: 200 }),
  });

  assert.equal(result.accessToken, "access-new");
  assert.equal(result.refreshToken, "refresh-new");
  assert.ok(result.scope.includes("Mail.Read"));
});

test("mailbox identity binds to Microsoft account ID and normalized address", async () => {
  const identity = await verifyMicrosoftMailboxIdentity({
    accessToken: "access",
    fetchImpl: async (url, init) => {
      assert.equal(url.origin, "https://graph.microsoft.com");
      assert.equal(url.pathname, "/v1.0/me");
      assert.equal(url.searchParams.get("$select"), "id,displayName,mail,userPrincipalName");
      assert.equal(init.headers.Authorization, "Bearer access");
      return new Response(JSON.stringify({
        id: "account-123",
        displayName: "Dexter",
        mail: null,
        userPrincipalName: "Dexter@Hotmail.com",
      }), { status: 200 });
    },
  });

  assert.deepEqual(identity, {
    accountId: "account-123",
    address: "dexter@hotmail.com",
    displayName: "Dexter",
  });
});

test("provider failures are sanitized and never surface raw Microsoft error bodies", async () => {
  await assert.rejects(
    exchangeMicrosoftMailAuthorizationCode({
      clientId: "client",
      clientSecret: "secret",
      callbackUri: callback,
      code: "code",
      fetchImpl: async () => new Response(JSON.stringify({
        error: "invalid_grant",
        error_description: "secret provider detail",
      }), { status: 400 }),
    }),
    (error) => {
      assert.equal(error.code, "exchange_failed");
      assert.doesNotMatch(error.message, /secret provider detail|invalid_grant/);
      return true;
    },
  );
});
