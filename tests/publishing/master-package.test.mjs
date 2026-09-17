import test from "node:test";
import assert from "node:assert/strict";

import { createMasterPackage } from "../../core/publishing/master-package/create.mjs";
import { compareProtectedFacts } from "../../core/publishing/master-package/facts.mjs";
import { validateMasterPackage } from "../../core/publishing/master-package/validate.mjs";

const input = {
  business_id: " auto-city ",
  source: { type: " inventory ", id: " vehicle-1 " },
  item_type: " vehicle ",
  title: " 2020 Example Sedan ",
  description: " A dependable sedan. ",
  media: [
    { id: "rear", type: "image", url: "https://example.com/rear.jpg", role: "gallery", order: 1, approved: true },
    { id: "front", type: "image", url: "https://example.com/front.jpg", role: "hero", order: 0, approved: true },
  ],
  verified_facts: { price: 12_500, vin: "VIN123" },
  attributes: { color: "blue", custom: { retained: true } },
  source_of_truth: { mode: "growthwise" },
  approval: { status: "draft" },
};

test("master packages require an explicit business scope", () => {
  const master = createMasterPackage({ ...input, business_id: "  " });
  const result = validateMasterPackage(master);

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("business_id is required"));
});

test("creation normalizes strings, copies input, and preserves media ordering", () => {
  const master = createMasterPackage(input);

  assert.equal(master.business_id, "auto-city");
  assert.equal(master.source.type, "inventory");
  assert.equal(master.title, "2020 Example Sedan");
  assert.deepEqual(master.media.map(({ id }) => id), ["rear", "front"]);
  assert.notEqual(master.media, input.media);
  assert.notEqual(master.attributes, input.attributes);
  assert.equal(validateMasterPackage(master).ok, true);
});

test("source_of_truth accepts only supported modes", () => {
  for (const mode of ["growthwise", "external", "bidirectional"]) {
    const master = createMasterPackage({ ...input, source_of_truth: { mode } });
    assert.equal(validateMasterPackage(master).ok, true, mode);
  }

  const master = createMasterPackage({ ...input, source_of_truth: { mode: "channel" } });
  const result = validateMasterPackage(master);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /source_of_truth\.mode/);
});

test("media validation returns a human-readable type error", () => {
  const master = createMasterPackage({ ...input, media: [{ ...input.media[0], type: "audio" }] });
  const result = validateMasterPackage(master);

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("media[0].type must be image or video"));
});

test("protected price and VIN changes require exact approved overrides", () => {
  const master = createMasterPackage(input);
  for (const [key, value] of [["price", 12_995], ["vin", "DIFFERENTVIN"]]) {
    const check = compareProtectedFacts(master, {
      ...master,
      verified_facts: { ...master.verified_facts, [key]: value },
    });
    assert.equal(check.ok, false);
    assert.match(check.errors[0], new RegExp(key, "i"));
  }
});

test("marketing description may change without changing protected facts", () => {
  const master = createMasterPackage(input);
  const check = compareProtectedFacts(master, { ...master, description: "Fresh marketing copy." });

  assert.deepEqual(check, { ok: true, changes: [], errors: [] });
});

test("an exact approved override records the protected change", () => {
  const master = createMasterPackage(input);
  const check = compareProtectedFacts(
    master,
    { ...master, verified_facts: { ...master.verified_facts, price: 12_995 } },
    ["price"],
  );

  assert.equal(check.ok, true);
  assert.deepEqual(check.errors, []);
  assert.deepEqual(check.changes, [{ key: "price", from: 12_500, to: 12_995, approved: true }]);
});
