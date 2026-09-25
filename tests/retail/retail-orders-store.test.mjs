import test from "node:test";
import assert from "node:assert/strict";

import { createRetailOrdersStore } from "../../netlify/functions/_retail-orders-store.mjs";

function fakePool() {
  const state = { orders: [], lines: [] };
  const client = {
    async query(sql, params = []) {
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql.trim())) return { rows: [] };
      if (sql.includes("INSERT INTO retail_purchase_orders")) {
        const [id,business_id,po_number,vendor_name,vendor_contact,expected_at,carrier,tracking_number,notes,subtotal_cents,shipping_cents,tax_cents,total_cents] = params;
        const row={id,business_id,po_number,vendor_name,vendor_contact,status:"draft",ordered_at:null,expected_at,received_at:null,carrier,tracking_number,notes,subtotal_cents,shipping_cents,tax_cents,total_cents,created_at:new Date(),updated_at:new Date()};
        state.orders.push(row); return { rows:[row] };
      }
      if (sql.includes("INSERT INTO retail_purchase_order_lines")) {
        const [id,purchase_order_id,square_item_id,square_variation_id,item_name,variation_name,sku,upc,vendor_sku,quantity_ordered,unit_cost_cents,retail_price_cents] = params;
        const row={id,purchase_order_id,square_item_id,square_variation_id,item_name,variation_name,sku,upc,vendor_sku,quantity_ordered,quantity_received:0,unit_cost_cents,retail_price_cents,created_at:new Date()};
        state.lines.push(row); return { rows:[row] };
      }
      if (sql.includes("WHERE id = $1 AND business_id = $2 FOR UPDATE")) {
        return { rows: state.orders.filter(o=>o.id===params[0] && o.business_id===params[1]) };
      }
      if (sql.includes("quantity_received = quantity_ordered")) {
        state.lines.filter(l=>l.purchase_order_id===params[0]).forEach(l=>l.quantity_received=l.quantity_ordered);
        return { rows:[] };
      }
      if (sql.includes("SET quantity_received = $2")) {
        const line=state.lines.find(l=>l.id===params[0]); if(line) line.quantity_received=params[1]; return {rows:[]};
      }
      if (sql.includes("UPDATE retail_purchase_orders")) {
        const [id,businessId,status,now,expectedAt,carrier,tracking,notes]=params;
        const order=state.orders.find(o=>o.id===id && o.business_id===businessId);
        Object.assign(order,{status,expected_at:expectedAt,carrier,tracking_number:tracking,notes,updated_at:now});
        if(status!=="draft"&&!order.ordered_at) order.ordered_at=now;
        if(status==="received"&&!order.received_at) order.received_at=now;
        return {rows:[order]};
      }
      if (sql.includes("FROM retail_purchase_order_lines WHERE purchase_order_id = $1 ORDER BY")) {
        return {rows:state.lines.filter(l=>l.purchase_order_id===params[0])};
      }
      throw new Error("Unexpected SQL in test: "+sql);
    },
    release() {},
  };
  return { state, pool:{ connect:async()=>client } };
}

test("purchase order totals are computed from wholesale unit cost, shipping and tax", async () => {
  const fake=fakePool();
  const store=createRetailOrdersStore({getPool:async()=>fake.pool});
  const order=await store.createOrder({
    id:"o1",businessId:"dexters-hats",poNumber:"GW-1",vendorName:"Vendor",
    shippingCents:500,taxCents:200,
    lines:[
      {id:"l1",itemName:"Hat A",quantityOrdered:2,unitCostCents:2500,retailPriceCents:5000},
      {id:"l2",itemName:"Hat B",quantityOrdered:1,unitCostCents:3000,retailPriceCents:6000},
    ],
  });
  assert.equal(order.subtotal_cents,8000);
  assert.equal(order.total_cents,8700);
  assert.equal(order.lines.length,2);
});

test("received order marks every ordered line received", async () => {
  const fake=fakePool();
  const store=createRetailOrdersStore({getPool:async()=>fake.pool});
  await store.createOrder({
    id:"o2",businessId:"dexters-hats",poNumber:"GW-2",vendorName:"Vendor",
    lines:[{id:"l1",itemName:"Hat",quantityOrdered:4,unitCostCents:2000}],
  });
  await store.updateOrder({businessId:"dexters-hats",id:"o2",status:"ordered"});
  const received=await store.updateOrder({businessId:"dexters-hats",id:"o2",status:"received"});
  assert.equal(received.status,"received");
  assert.equal(received.lines[0].quantity_received,4);
});
