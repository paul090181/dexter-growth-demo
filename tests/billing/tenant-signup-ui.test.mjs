import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../../signup.html", import.meta.url), "utf8");
const signupScript = await readFile(new URL("../../assets/tenant-signup.js", import.meta.url), "utf8");
const source = `${page}\n${signupScript}`;

test("signup page collects only basic business, type, and contact fields", () => {
  assert.match(source, /name="business_name"/);
  assert.match(source, /name="business_type"/);
  assert.match(source, /value="retail"/);
  assert.match(source, /value="bakery_food"/);
  assert.match(source, /value="auto_dealer"/);
  assert.match(source, /value="service"/);
  assert.match(source, /name="contact_name"/);
  assert.match(source, /name="email"/);
  assert.doesNotMatch(source, /name="(?:password|phone|address|company|plan|price)"/);
  assert.match(source, /fetch\(['"]\/\.netlify\/functions\/tenant-signup['"]/);
  assert.match(source, /JSON\.stringify\(\{\s*business_name:\s*form\.business_name\.value,\s*business_type:\s*form\.business_type\.value,\s*contact_name:\s*form\.contact_name\.value,\s*email:\s*form\.email\.value\s*\}\)/);
});

test("raw tenant key is kept in session storage and shown only in the one-time key panel", () => {
  assert.match(source, /sessionStorage\.setItem\(['"]growthwise_tenant_key['"],\s*data\.tenant_key\)/);
  assert.match(source, /oneTimeKey\.textContent\s*=\s*data\.tenant_key/);
  assert.match(source, /<section[^>]*(?:id="oneTimeKeyPanel"[^>]*class="[^"]*hidden|class="[^"]*hidden[^"]*"[^>]*id="oneTimeKeyPanel")/);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^)]*tenant_key/);
  assert.doesNotMatch(source, /localStorage/);
});

test("status and checkout send the tenant key only with its stored business ID", () => {
  assert.match(source, /subscription-status\?business_id=\$\{encodeURIComponent\(businessId\)\}/);
  assert.match(source, /['"]X-GrowthWise-Tenant-Key['"]:\s*tenantKey/);
  assert.match(source, /fetch\(['"]\/\.netlify\/functions\/stripe-checkout['"]/);
  assert.match(source, /body:\s*JSON\.stringify\(\{\s*business_id:\s*businessId\s*\}\)/);
  assert.doesNotMatch(source, /JSON\.stringify\(\{[^}]*\b(?:price|plan_key|amount)\b/);
});

test("the page grants access only from server-confirmed subscription status", () => {
  assert.match(source, /data\.access_granted\s*===\s*true/);
  assert.match(source, /data\.access_source\s*===\s*['"]stripe['"]/);
  assert.match(source, /data\.access_source\s*===\s*['"]pilot['"]/);
  assert.match(source, /Pilot access active/);
  assert.match(source, /billingResult\s*===\s*['"]success['"]/);
  assert.match(source, /billingResult\s*===\s*['"]success['"][\s\S]{0,300}refreshStatus\(\)/);
  assert.doesNotMatch(source, /billingResult\s*===\s*['"]success['"][\s\S]{0,300}accessGranted\s*=\s*true/);
  assert.match(source, /const stripeLinked = data\.access_source === ['"]stripe['"]/);
  assert.match(source, /const pilotAccess = data\.access_source === ['"]pilot['"]/);
  assert.match(source, /checkoutButton\.disabled\s*=\s*stripeLinked\s*\|\|\s*pilotAccess/);
});

test("the standalone tenant page does not load Dexter integrations or data", () => {
  assert.doesNotMatch(source, /dexters-hats|square-data|instagram|lead-inbox|retail-leads|retail-ops/i);
});

test("checkout redirects only to Stripe-hosted HTTPS", () => {
  assert.match(source, /checkoutUrl\.protocol\s*===\s*['"]https:['"]/);
  assert.match(source, /checkoutUrl\.hostname\s*===\s*['"]checkout\.stripe\.com['"]/);
  assert.match(source, /window\.location\.href\s*=\s*checkoutUrl\.href/);
});


test("founding offer clearly compares founder and planned standard pricing", () => {
  assert.match(source, /Founding Member Offer/);
  assert.match(source, /\$49<small>\/month<\/small>/);
  assert.match(source, /Planned standard price after launch:/);
  assert.match(source, /\$99\/month/);
  assert.match(source, /Save \$50\/month · \$600\/year/);
});

test("founding pricing states the continuous-membership rule", () => {
  assert.match(source, /rate stays locked in while your subscription remains continuously active/i);
  assert.match(source, /If your membership ends and you later rejoin, the then-current standard rate will apply/i);
  assert.match(source, /Temporary payment-recovery periods do not automatically end founder pricing/i);
});


test("signup tells customers promotion codes are entered and validated in Stripe Checkout", () => {
  assert.match(source, /Have a promo code\?/);
  assert.match(source, /Stripe validates the code/);
});

test("signup keeps the current browser signed in and hands active customers into guided setup", () => {
  assert.match(source, /You're signed in on this device/i);
  assert.match(source, />Continue<\/button>/);
  assert.match(source, /href="\.\/app\.html\?onboarding=1"/);
  assert.match(source, /Continue setup/);
  assert.match(source, /target\.scrollIntoView/);
  assert.match(source, /accessCard\.scrollIntoView/);
});

test("signup records only milestone names through the tenant-authenticated onboarding endpoint", () => {
  assert.match(source, /fetch\(['"]\/\.netlify\/functions\/onboarding-event['"]/);
  assert.match(source, /workspace_created/);
  assert.match(source, /checkout_started/);
  assert.match(source, /checkout_completed/);
  assert.match(source, /['"]X-GrowthWise-Tenant-Key['"]:\s*tenantKey/);
  assert.match(source, /growthwise_onboarding_event/);
  assert.doesNotMatch(source, /onboarding-event\?[^'"]*tenant/);
});

test("returning businesses can find passwordless sign in directly from signup", () => {
  assert.match(source, /Already have a workspace\? Sign in/);
  assert.match(source, /Sign in by email/);
  assert.match(source, /href="\.\/app\.html"/);
  assert.doesNotMatch(source, /Password recovery is not part of this preview yet/i);
  assert.match(source, /use your business email to sign in securely/i);
});


test("signup gives prospective customers direct access to the privacy policy", () => {
  assert.match(source, /href="\.\/privacy-policy\.html"/);
  assert.match(source, /Privacy Policy/);
});


test("signup hides technical preview details and gives pilots a payment-free handoff", () => {
  assert.match(source, /<details[^>]*>[\s\S]*Preview support details/);
  assert.match(source, /Preview access key/);
  assert.match(source, /Your pilot access is active/);
  assert.match(source, /No payment is required during this pilot/);
  assert.match(source, /planCard\.classList\.toggle\(['"]hidden['"],\s*pilotAccess\)/);
  assert.doesNotMatch(source, /Server-controlled plan/);
  assert.doesNotMatch(source, /signed subscription webhook/);
  assert.doesNotMatch(source, /Open secure sandbox checkout/);
});


test("signup loads its behavior from a same-origin external script", () => {
  assert.match(page, /<script src="\.\/assets\/tenant-signup\.js"><\/script>/);
  assert.doesNotMatch(page, /<script>(?:.|\n)*<\/script>/);
});
