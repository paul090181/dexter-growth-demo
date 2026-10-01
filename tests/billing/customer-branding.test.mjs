import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL("../../" + path, import.meta.url), "utf8");

test("customer-facing workspace uses Narleo while internal GrowthWise identifiers remain implementation details", async () => {
  const [app, signup, signupJs, signin, connectors, dexter, workspaceJs, dexterJs, transactionalEmail, loginRequest, facebookConnection, facebookPageSelect, facebookPublishing, dexterDraft] = await Promise.all([
    read("app.html"),
    read("signup.html"),
    read("assets/tenant-signup.js"),
    read("signin.html"),
    read("connect-accounts.html"),
    read("dexter-pilot.html"),
    read("assets/tenant-workspace.mjs"),
    read("assets/dexter-pilot.mjs"),
    read("netlify/functions/_transactional-email.mjs"),
    read("netlify/functions/tenant-login-request.mjs"),
    read("netlify/functions/facebook-connection.mjs"),
    read("netlify/functions/facebook-page-select.mjs"),
    read("netlify/functions/_facebook-publishing.mjs"),
    read("netlify/functions/dexter-instagram-photo-draft.mjs"),
  ]);

  assert.match(app, /<title>Narleo Business Workspace<\/title>/);
  assert.match(app, /<div class="brand">Narleo<\/div>/);
  assert.match(app, /Narleo will send a one-time sign-in link/);
  assert.match(app, /Narleo unlocks features from your verified plan/);
  assert.doesNotMatch(app, /Narleo\/GrowthWise/);

  const signupSource = `${signup}\n${signupJs}`;

  assert.match(signup, /<div class="brand">Narleo<\/div>/);
  assert.match(signup, /connect email to Narleo/);
  assert.match(signupSource, /Narleo is confirming your access/);
  assert.match(signupSource, /growthwise_business_id/);
  assert.match(signupSource, /X-GrowthWise-Tenant-Key/);

  assert.match(signin, /<title>Secure sign in \| Narleo<\/title>/);
  assert.match(signin, /<div class="brand">Narleo<\/div>/);
  assert.doesNotMatch(signin, />GrowthWise</);

  assert.match(connectors, /<title>Connect your accounts \| Narleo<\/title>/);
  assert.match(connectors, /Narleo secure setup/);
  assert.match(connectors, /Narleo never needs those provider passwords/);
  assert.match(connectors, /Narleo will connect only the Page you select/);

  assert.match(dexter, /<title>Dexter's Hats \| Narleo Pilot<\/title>/);
  assert.match(dexter, /<div class="brand">Narleo<\/div>/);
  assert.match(dexter, /let Narleo write the Instagram post/);

  assert.match(workspaceJs, /Narleo will keep this snapshot focused/);
  assert.match(workspaceJs, /Narleo could not draft the reply/);
  assert.match(workspaceJs, /Narleo is turning your business data into your first Business Pulse/);
  assert.doesNotMatch(workspaceJs, /GrowthWise could not draft the reply/);

  assert.match(dexterJs, /Narleo is studying the photo and writing your caption/);
  assert.match(dexterJs, /Narleo could not create the draft/);
  assert.doesNotMatch(dexterJs, /GrowthWise could not create the draft/);

  assert.match(transactionalEmail, /Your secure Narleo sign-in link/);
  assert.doesNotMatch(transactionalEmail, /Your secure GrowthWise sign-in link/);
  assert.match(loginRequest, /Narleo workspace/);
  assert.doesNotMatch(loginRequest, /GrowthWise workspace/);
  assert.match(facebookConnection, /Narleo can verify this Page/);
  assert.doesNotMatch(facebookConnection, /GrowthWise can (?:verify|restore)/);
  assert.match(facebookPageSelect, /Pages shown by Narleo/);
  assert.doesNotMatch(facebookPageSelect, /Pages shown by GrowthWise/);
  assert.match(facebookPublishing, /this Narleo beta/);
  assert.doesNotMatch(facebookPublishing, /this GrowthWise beta/);
  assert.match(dexterDraft, /You are Narleo, creating an Instagram post/);
  assert.doesNotMatch(dexterDraft, /GrowthWise (?:AI|could|returned)/);
});
