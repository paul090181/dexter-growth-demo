import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createDexterInstagramPhotoDraftHandler } from "../../netlify/functions/dexter-instagram-photo-draft.mjs";
import { createDexterInstagramPublishHandler } from "../../netlify/functions/dexter-instagram-publish.mjs";
import { createDexterPilotFeedbackHandler } from "../../netlify/functions/dexter-pilot-feedback.mjs";
import { createDexterPilotEventHandler } from "../../netlify/functions/dexter-pilot-event.mjs";

const ORIGIN="https://deploy-preview-17--euphonious-beijinho-db4b4d.netlify.app";

function denied(){
  return async () => ({ ok:false, businessId:null });
}
function allowed(){
  return async (_request,{businessId,connector}) => {
    assert.equal(businessId,"dexters-hats");
    assert.equal(connector,"instagram");
    return { ok:true, businessId:"dexters-hats" };
  };
}

test("Dexter photo drafting requires the scoped Instagram connector session", async () => {
  let called=false;
  const handler=createDexterInstagramPhotoDraftHandler({
    connectorStore:{},
    connectorAuthorize:denied(),
    fetchImpl:async()=>{called=true;return new Response("{}");},
    env:()=> "synthetic",
  });
  const response=await handler(new Request(ORIGIN+"/.netlify/functions/dexter-instagram-photo-draft",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({image_data_url:"data:image/jpeg;base64,AA=="})
  }));
  assert.equal(response.status,401);
  assert.equal(called,false);
});

test("Dexter publish wrapper never grants a connector session another tenant", async () => {
  let proxied=null;
  const handler=createDexterInstagramPublishHandler({
    connectorStore:{},
    connectorAuthorize:allowed(),
    innerHandler:async request=>{proxied={url:request.url,body:await request.json()};return new Response(JSON.stringify({ok:true}),{status:200,headers:{"content-type":"application/json"}});},
  });
  const good=await handler(new Request(ORIGIN+"/.netlify/functions/dexter-instagram-publish",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({business_id:"dexters-hats",reviewed:true,caption:"Hat",image_data_url:"data:image/jpeg;base64,AA=="})
  }));
  assert.equal(good.status,200);
  assert.equal(proxied.body.business_id,"dexters-hats");
  assert.match(proxied.url,/\/instagram-publish$/);

  const other=await handler(new Request(ORIGIN+"/.netlify/functions/dexter-instagram-publish",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({business_id:"other-business",reviewed:true,caption:"Hat",image_data_url:"data:image/jpeg;base64,AA=="})
  }));
  assert.equal(other.status,403);
});

test("Dexter feedback endpoint is connector scoped before database writes", async () => {
  let dbUsed=false;
  const handler=createDexterPilotFeedbackHandler({
    connectorStore:{},
    connectorAuthorize:denied(),
    getDb:()=>{dbUsed=true;return {};},
  });
  const response=await handler(new Request(ORIGIN+"/.netlify/functions/dexter-pilot-feedback",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({feature:"instagram-post",result:"worked",note:""})
  }));
  assert.equal(response.status,401);
  assert.equal(dbUsed,false);
});

test("Dexter activity POST is connector scoped and GET remains admin-only", async () => {
  const handler=createDexterPilotEventHandler({
    connectorStore:{},
    connectorAuthorize:denied(),
    isAuthorized:()=>({ok:false}),
    getDb:()=>({}),
  });
  const post=await handler(new Request(ORIGIN+"/.netlify/functions/dexter-pilot-event",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({event_name:"pilot_opened"})
  }));
  assert.equal(post.status,401);
  const get=await handler(new Request(ORIGIN+"/.netlify/functions/dexter-pilot-event?business_id=dexters-hats"));
  assert.equal(get.status,401);
});

test("Dexter pilot page uses scoped connector session and no admin unlock", async () => {
  const html=await readFile(new URL("../../dexter-pilot.html",import.meta.url),"utf8");
  assert.match(html,/connector-session/);
  assert.match(html,/dexter-instagram-photo-draft/);
  assert.match(html,/dexter-instagram-publish/);
  assert.match(html,/dexter-pilot-feedback/);
  assert.match(html,/dexter-pilot-event/);
  assert.doesNotMatch(html,/growthwise_admin_key/i);
  assert.doesNotMatch(html,/Unlock GrowthWise/i);
});
