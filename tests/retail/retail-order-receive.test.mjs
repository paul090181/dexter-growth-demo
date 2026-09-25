import test from "node:test";
import assert from "node:assert/strict";

import { createRetailOrderReceiveHandler } from "../../netlify/functions/retail-order-receive.mjs";

function request(body,key="admin"){
  return new Request("https://example.test/.netlify/functions/retail-order-receive",{
    method:"POST",
    headers:{"content-type":"application/json","x-growthwise-key":key},
    body:JSON.stringify(body),
  });
}

test("receiving an order uses one stable Square idempotency key and RECEIVED adjustments", async () => {
  const calls=[];
  let updated;
  const order={
    id:"8fc6a5b0-9fe8-4b46-b46b-2ef95793abbe",
    business_id:"dexters-hats",status:"shipped",
    lines:[{id:"line-1",square_variation_id:"var-1",item_name:"Hat",quantity_ordered:6,quantity_received:1}],
  };
  const handler=createRetailOrderReceiveHandler({
    env:(name)=>({GROWTHWISE_ADMIN_KEY:"admin",SQUARE_SANDBOX_TOKEN:"token"}[name]||""),
    store:{
      getOrder:async()=>order,
      updateOrder:async(input)=>{updated=input; return {...order,status:"received"};},
    },
    now:()=>new Date("2026-09-20T17:00:00.000Z"),
    fetchImpl:async (url,init)=>{
      calls.push({url,init});
      if(url.endsWith("/v2/locations")){
        return new Response(JSON.stringify({locations:[{id:"loc-1",name:"Store",status:"ACTIVE"}]}),{status:200});
      }
      return new Response(JSON.stringify({counts:[]}),{status:200});
    },
  });
  const response=await handler(request({business_id:"dexters-hats",order_id:order.id}));
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.received_line_count,1);
  const payload=JSON.parse(calls[1].init.body);
  assert.equal(payload.idempotency_key,order.id);
  assert.equal(payload.changes[0].adjustment.from_state,"NONE");
  assert.equal(payload.changes[0].adjustment.to_state,"IN_STOCK");
  assert.equal(payload.changes[0].adjustment.from_location_id,"loc-1");
  assert.equal(payload.changes[0].adjustment.to_location_id,"loc-1");
  assert.equal(Object.hasOwn(payload.changes[0].adjustment,"location_id"),false);
  assert.equal(payload.changes[0].adjustment.quantity,"5");
  assert.equal(payload.changes[0].adjustment.reason_id.type,"RECEIVED");
  assert.equal(updated.status,"received");
});

test("Square failure leaves GrowthWise order open", async () => {
  let updated=false;
  const handler=createRetailOrderReceiveHandler({
    env:(name)=>({GROWTHWISE_ADMIN_KEY:"admin",SQUARE_SANDBOX_TOKEN:"token"}[name]||""),
    store:{
      getOrder:async()=>({id:"order",status:"shipped",lines:[{id:"l",square_variation_id:"v",item_name:"Hat",quantity_ordered:1,quantity_received:0}]}),
      updateOrder:async()=>{updated=true;},
    },
    fetchImpl:async (url)=>{
      if(url.endsWith("/v2/locations")) return new Response(JSON.stringify({locations:[{id:"loc",status:"ACTIVE"}]}),{status:200});
      return new Response(JSON.stringify({errors:[{code:"ERROR"}]}),{status:400});
    },
  });
  const response=await handler(request({order_id:"order"}));
  assert.equal(response.status,502);
  assert.equal(updated,false);
});
