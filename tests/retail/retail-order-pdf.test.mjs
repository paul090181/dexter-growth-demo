import test from "node:test";
import assert from "node:assert/strict";

import { createRetailOrderPdfHandler, wrapText } from "../../netlify/functions/retail-order-pdf.mjs";

function request(orderId="order-1", key="admin"){
  return new Request(`https://example.test/.netlify/functions/retail-order-pdf?business_id=dexters-hats&order_id=${orderId}`,{
    method:"GET",
    headers:{"x-growthwise-key":key},
  });
}

const sampleOrder={
  id:"order-1",
  business_id:"dexters-hats",
  po_number:"GW-20260920-TEST",
  vendor_name:"Test Vendor",
  vendor_contact:"vendor@example.com",
  status:"received",
  created_at:"2026-09-20T12:00:00.000Z",
  ordered_at:"2026-09-20T13:00:00.000Z",
  expected_at:"2026-09-25T00:00:00.000Z",
  received_at:"2026-09-24T15:00:00.000Z",
  carrier:"UPS",
  tracking_number:"1ZTEST",
  notes:"Keep one copy for accounting.",
  subtotal_cents:3000,
  shipping_cents:500,
  tax_cents:250,
  total_cents:3750,
  lines:[{
    id:"line-1",
    item_name:"Bowl & Basket Yellow Mustard",
    variation_name:"Yellow / 20 oz",
    sku:"MUST-20",
    upc:"041190081721",
    vendor_sku:"V-123",
    quantity_ordered:30,
    quantity_received:30,
    unit_cost_cents:100,
    retail_price_cents:199,
  }],
};

test("purchase order PDF requires authentication", async()=>{
  const handler=createRetailOrderPdfHandler({
    env:(name)=>name==="GROWTHWISE_ADMIN_KEY"?"admin":"",
    store:{getOrder:async()=>sampleOrder},
  });
  const response=await handler(request("order-1","wrong"));
  assert.equal(response.status,401);
});

test("purchase order PDF returns a real PDF attachment", async()=>{
  const handler=createRetailOrderPdfHandler({
    env:(name)=>name==="GROWTHWISE_ADMIN_KEY"?"admin":"",
    store:{getOrder:async()=>sampleOrder},
  });
  const response=await handler(request());
  assert.equal(response.status,200);
  assert.equal(response.headers.get("content-type"),"application/pdf");
  assert.match(response.headers.get("content-disposition")||"",/GW-20260920-TEST\.pdf/);
  const bytes=new Uint8Array(await response.arrayBuffer());
  const header=new TextDecoder("ascii").decode(bytes.slice(0,5));
  assert.equal(header,"%PDF-");
  assert.ok(bytes.length>500);
});

test("purchase order PDF returns 404 for unknown order", async()=>{
  const handler=createRetailOrderPdfHandler({
    env:(name)=>name==="GROWTHWISE_ADMIN_KEY"?"admin":"",
    store:{getOrder:async()=>null},
  });
  const response=await handler(request("missing"));
  assert.equal(response.status,404);
});

test("PDF word wrapping preserves the letter s in product names", () => {
  const font = {
    widthOfTextAtSize(text) {
      return text.length * 5;
    },
  };
  const lines = wrapText("Bowl & Basket Yellow Mustard", font, 9, 500);
  assert.deepEqual(lines, ["Bowl & Basket Yellow Mustard"]);
  assert.match(lines[0], /Basket/);
  assert.match(lines[0], /Mustard/);
});
