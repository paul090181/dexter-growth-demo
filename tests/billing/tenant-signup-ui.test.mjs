import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../../signup.html", import.meta.url), "utf8");

test("signup page collects only the minimum business and contact fields", () => {
  assert.match(page, /name="business_name"/);
  assert.match(page, /name="contact_name"/);
  assert.match(page, /name="email"/);
  assert.doesNotMatch(page, /name="(?:password|phone|address|company|plan|price)"/);
  assert.match(page, /fetch\(['"]\/\.netlify\/functions\/tenant-signup['"]/);
  assert.match(page, /JSON\.stringify\(\{\s*business_name:\s*form\.business_name\.value,\s*contact_name:\s*form\.contact_name\.value,\s*email:\s*form\.email\.value\s*\}\)/);
});

test("raw tenant key is kept in session storage and shown only in the one-time key panel", () => {
  assert.match(page, /sessionStorage\.setItem\(['"]growthwise_tenant_key['"],\s*data\.tenant_key\)/);
  assert.match(page, /oneTimeKey\.textContent\s*=\s*data\.tenant_key/);
  assert.match(page, /<section[^>]*(?:id="oneTimeKeyPanel"[^>]*class="[^"]*hidden|class="[^"]*hidden[^"]*"[^>]*id="oneTimeKeyPanel")/);
  assert.doesNotMatch(page, /console\.(?:log|error)\([^)]*tenant_key/);
  assert.doesNotMatch(page, /localStorage/);
});

test("status and checkout send the tenant key only with its stored business ID", () => {
  assert.match(page, /subscription-status\?business_id=\$\{encodeURIComponent\(businessId\)\}/);
  assert.match(page, /['"]X-GrowthWise-Tenant-Key['"]:\s*tenantKey/);
  assert.match(page, /fetch\(['"]\/\.netlify\/functions\/stripe-checkout['"]/);
  assert.match(page, /body:\s*JSON\.stringify\(\{\s*business_id:\s*businessId\s*\}\)/);
  assert.doesNotMatch(page, /JSON\.stringify\(\{[^}]*\b(?:price|plan_key|amount)\b/);
});

test("the page grants access only from server-confirmed subscription status", () => {
  assert.match(page, /data\.access_granted\s*===\s*true/);
  assert.match(page, /data\.access_source\s*===\s*['"]stripe['"]/);
  assert.match(page, /billingResult\s*===\s*['"]success['"]/);
  assert.match(page, /billingResult\s*===\s*['"]success['"][\s\S]{0,300}refreshStatus\(\)/);
  assert.doesNotMatch(page, /billingResult\s*===\s*['"]success['"][\s\S]{0,300}accessGranted\s*=\s*true/);
  assert.match(page, /const stripeLinked = data\.access_source === ['"]stripe['"]/);
  assert.match(page, /checkoutButton\.disabled\s*=\s*stripeLinked/);
});

test("the standalone tenant page does not load Dexter integrations or data", () => {
  assert.doesNotMatch(page, /dexters-hats|square-data|instagram|lead-inbox|retail-leads|retail-ops/i);
});

test("checkout redirects only to Stripe-hosted HTTPS", () => {
  assert.match(page, /checkoutUrl\.protocol\s*===\s*['"]https:['"]/);
  assert.match(page, /checkoutUrl\.hostname\s*===\s*['"]checkout\.stripe\.com['"]/);
  assert.match(page, /window\.location\.href\s*=\s*checkoutUrl\.href/);
});


test("founding offer clearly compares founder and planned standard pricing", () => {
  assert.match(page, /Founding Member Offer/);
  assert.match(page, /\$49<small>\/month<\/small>/);
  assert.match(page, /Planned standard price after launch:/);
  assert.match(page, /\$99\/month/);
  assert.match(page, /Save \$50\/month · \$600\/year/);
});

test("founding pricing states the continuous-membership rule", () => {
  assert.match(page, /rate stays locked in while your subscription remains continuously active/i);
  assert.match(page, /If your membership ends and you later rejoin, the then-current standard rate will apply/i);
  assert.match(page, /Temporary payment-recovery periods do not automatically end founder pricing/i);
});


test("signup tells customers promotion codes are entered and validated in Stripe Checkout", () => {
  assert.match(page, /Have a promo code\?/);
  assert.match(page, /Stripe validates the code/);
});

test("signup keeps the current browser signed in and hands active customers into guided setup", () => {
  assert.match(page, /This setup will continue automatically in the current browser session/i);
  assert.match(page, /Continue to activation/);
  assert.match(page, /href="\.\/app\.html\?onboarding=1"/);
  assert.match(page, /Continue setup/);
  assert.match(page, /planCard\.scrollIntoView/);
  assert.match(page, /accessCard\.scrollIntoView/);
});

test("signup records only milestone names through the tenant-authenticated onboarding endpoint", () => {
  assert.match(page, /fetch\(['"]\/\.netlify\/functions\/onboarding-event['"]/);
  assert.match(page, /workspace_created/);
  assert.match(page, /checkout_started/);
  assert.match(page, /checkout_completed/);
  assert.match(page, /['"]X-GrowthWise-Tenant-Key['"]:\s*tenantKey/);
  assert.match(page, /growthwise_onboarding_event/);
  assert.doesNotMatch(page, /onboarding-event\?[^'"]*tenant/);
});

test("returning businesses can find passwordless sign in directly from signup", () => {
  assert.match(page, /Already have a workspace\? Sign in/);
  assert.match(page, /Sign in by email/);
  assert.match(page, /href="\.\/app\.html"/);
  assert.doesNotMatch(page, /Password recovery is not part of this preview yet/i);
  assert.match(page, /use email sign-in from the business workspace/i);
});
