import test from "node:test";
import assert from "node:assert/strict";

import { createMasterPackage } from "../../core/publishing/master-package/create.mjs";
import { validateMasterPackage } from "../../core/publishing/master-package/validate.mjs";
import { automotiveToMasterInput } from "../../verticals/automotive/publishing-adapter/index.mjs";
import { retailToMasterInput } from "../../verticals/retail/publishing-adapter/index.mjs";
import { propertyPublishingAdapterContract } from "../../verticals/property/publishing-adapter/contract.mjs";
import { servicesPublishingAdapterContract } from "../../verticals/services/publishing-adapter/contract.mjs";
import { automotiveMedia, automotiveVehicle } from "./fixtures/automotive-vehicle.mjs";
import { retailMedia, retailProduct } from "./fixtures/retail-product.mjs";

test("automotive adapter maps vehicle facts and vertical attributes", () => {
  const input = automotiveToMasterInput({
    businessId: "auto-city",
    vehicle: automotiveVehicle,
    media: automotiveMedia,
    business: { name: "Auto City" },
  });
  const master = createMasterPackage(input);

  assert.equal(master.title, "2021 Honda Accord Sport");
  assert.deepEqual(master.verified_facts, {
    vin: automotiveVehicle.vin,
    stock: automotiveVehicle.stock,
    mileage: automotiveVehicle.mileage,
    price: automotiveVehicle.asking,
    availability: automotiveVehicle.status,
  });
  assert.equal(master.attributes.bodyStyle, "sedan");
  assert.equal(master.bodyStyle, undefined);
  assert.deepEqual(master.media.map(({ id }) => id), ["vehicle-front", "vehicle-rear"]);
  assert.deepEqual(validateMasterPackage(master), { ok: true, errors: [] });
});

test("retail adapter maps product facts and vertical attributes", () => {
  const input = retailToMasterInput({
    businessId: "dexters-hats",
    product: retailProduct,
    media: retailMedia,
    business: { name: "Dexter's Hats" },
  });
  const master = createMasterPackage(input);

  assert.equal(master.title, "Dexter's Hats Classic Fedora");
  assert.deepEqual(master.verified_facts, {
    sku: retailProduct.sku,
    quantity: retailProduct.quantity,
    price: retailProduct.price,
    availability: "available",
  });
  assert.equal(master.attributes.variant, "black-medium");
  assert.equal(master.variant, undefined);
  assert.deepEqual(validateMasterPackage(master), { ok: true, errors: [] });
});

test("future vertical contracts only document the shared master-input boundary", () => {
  for (const contract of [propertyPublishingAdapterContract, servicesPublishingAdapterContract]) {
    assert.equal(Object.isFrozen(contract), true);
    assert.deepEqual(contract.requiredOutputFields, [
      "business_id", "source", "item_type", "title", "description", "media",
      "verified_facts", "attributes", "source_of_truth", "approval",
    ]);
    assert.equal(typeof contract.adapter, "undefined");
  }
});
