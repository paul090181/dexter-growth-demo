import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createChannelDraft } from "../../core/publishing/channels/draft.mjs";
import { createMasterPackage } from "../../core/publishing/master-package/create.mjs";
import { validateMasterPackage } from "../../core/publishing/master-package/validate.mjs";
import { retailToMasterInput } from "../../verticals/retail/publishing-adapter/index.mjs";

const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");

test("Dexter Square success submits the four approved shadow channels", () => {
  const helper = html.slice(html.indexOf("async function sendDexterPublishingShadow"), html.indexOf("async function publishNewProductToFacebook"));
  for (const channel of ["facebook-page", "facebook-marketplace", "instagram", "website"]) {
    assert.match(helper, new RegExp(`['\"]${channel}['\"]`));
  }
  assert.match(helper, /business_id:\s*['"]dexters-hats['"]/);
  assert.match(helper, /vertical:\s*['"]retail['"]/);
  assert.match(helper, /role:\s*['"]owner_admin['"]/);
});

test("shadow bridge is best-effort and cannot enter legacy failure handling", () => {
  const helper = html.slice(html.indexOf("async function sendDexterPublishingShadow"), html.indexOf("async function publishNewProductToFacebook"));
  assert.match(helper, /catch\s*\([^)]*\)/);
  assert.match(helper, /console\.warn/);
  assert.match(html, /void sendDexterPublishingShadow\(form, created\)/);
  assert.doesNotMatch(helper, /throw\s/);
});

test("the Dexter bridge media shape passes the real retail master-package path", () => {
  const media = [{
    id: "product-hero",
    type: "image",
    url: "data:image/jpeg;base64,AAAA",
    role: "hero",
    order: 0,
    approved: true,
  }];
  const product = {
    sku: "square-variation-id",
    brand: "Dexter's Hats",
    name: "Bridge Fedora",
    description: "Bridge test product",
    price: 79,
    quantity: 2,
  };

  const masterPackage = createMasterPackage(retailToMasterInput({
    businessId: "dexters-hats",
    product,
    media,
    business: { name: "Dexter's Hats" },
  }));

  assert.deepEqual(validateMasterPackage(masterPackage), { ok: true, errors: [] });
  assert.deepEqual(masterPackage.media, media);
  assert.deepEqual(createChannelDraft(masterPackage, "instagram").media, media);
  assert.match(html, /role:\s*['"]hero['"],\s*order:\s*0,\s*approved:\s*true/);
});
