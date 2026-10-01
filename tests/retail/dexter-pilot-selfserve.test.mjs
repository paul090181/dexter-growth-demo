import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PILOT_SESSION_COOKIE,
  authorizePilotRequest,
  hashPilotToken,
} from "../../netlify/functions/_pilot-auth.mjs";
import { PILOT_SESSION_TTL_MS } from "../../netlify/functions/_pilot-store.mjs";
import { createDexterPilotInvitationCreateHandler } from "../../netlify/functions/dexter-pilot-invitation-create.mjs";
import { createDexterPilotInvitationExchangeHandler } from "../../netlify/functions/dexter-pilot-invitation-exchange.mjs";
import { createDexterPilotSessionHandler } from "../../netlify/functions/dexter-pilot-session.mjs";
import { createDexterInstagramConnectionHandler } from "../../netlify/functions/dexter-instagram-connection.mjs";
import { createDexterInstagramOAuthStartHandler } from "../../netlify/functions/dexter-instagram-oauth-start.mjs";
import { createDexterInstagramPhotoDraftHandler } from "../../netlify/functions/dexter-instagram-photo-draft.mjs";
import { createDexterInstagramPublishHandler } from "../../netlify/functions/dexter-instagram-publish.mjs";
import { createDexterPilotFeedbackHandler } from "../../netlify/functions/dexter-pilot-feedback.mjs";
import { createDexterPilotEventHandler } from "../../netlify/functions/dexter-pilot-event.mjs";
import { resolveInstagramReturnDestination } from "../../netlify/functions/_instagram-clients.mjs";

const ORIGIN="https://deploy-preview-17--euphonious-beijinho-db4b4d.netlify.app";
const NOW=new Date("2026-09-26T22:30:00.000Z");

function pilotAllowed(){
  return async (_request,{businessId})=>{
    assert.equal(businessId,"dexters-hats");
    return {ok:true,businessId:"dexters-hats",expiresAt:new Date(NOW.getTime()+PILOT_SESSION_TTL_MS)};
  };
}

function pilotDenied(){
  return async()=>({ok:false,businessId:null});
}

test("Dexter pilot invite is single-business, preview-only, and valid for 72 hours",async()=>{
  let stored;
  const raw=`gw_pilot_inv_${"A".repeat(43)}`;
  const handler=createDexterPilotInvitationCreateHandler({
    isAuthorized:()=>({ok:true}),
    store:{async createInvitation(row){stored=row;return row;}},
    now:()=>NOW,
    tokenFactory:()=>raw,
  });
  const response=await handler(new Request(ORIGIN+"/.netlify/functions/dexter-pilot-invitation-create",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({business_id:"dexters-hats"}),
  }));
  assert.equal(response.status,201);
  const body=await response.json();
  assert.equal(body.business_id,"dexters-hats");
  assert.equal(new Date(body.expires_at).getTime()-NOW.getTime(),72*60*60*1000);
  assert.equal(stored.businessId,"dexters-hats");
  assert.equal(stored.invitationHash,hashPilotToken(raw));
  assert.match(body.invitation_url,/\/dexter-pilot\.html#invite=gw_pilot_inv_/);

  const production=await handler(new Request("https://euphonious-beijinho-db4b4d.netlify.app/.netlify/functions/dexter-pilot-invitation-create",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({business_id:"dexters-hats"}),
  }));
  assert.equal(production.status,404);
});

test("redeeming Dexter invite creates a fixed 30-day HttpOnly pilot session",async()=>{
  const invitationToken=`gw_pilot_inv_${"B".repeat(43)}`;
  const sessionToken=`gw_pilot_${"C".repeat(43)}`;
  let redeemed;
  const handler=createDexterPilotInvitationExchangeHandler({
    store:{
      async redeemInvitation(input){
        redeemed=input;
        return {business_id:"dexters-hats",expires_at:new Date(NOW.getTime()+PILOT_SESSION_TTL_MS)};
      },
    },
    now:()=>NOW,
    sessionTokenFactory:()=>sessionToken,
  });
  const response=await handler(new Request(ORIGIN+"/.netlify/functions/dexter-pilot-invitation-exchange",{
    method:"POST",
    headers:{"Content-Type":"application/json","Origin":ORIGIN},
    body:JSON.stringify({invitation_token:invitationToken}),
  }));
  assert.equal(response.status,200);
  assert.equal(redeemed.invitationHash,hashPilotToken(invitationToken));
  assert.equal(redeemed.sessionHash,hashPilotToken(sessionToken));
  const body=await response.json();
  assert.equal(new Date(body.expires_at).getTime()-NOW.getTime(),PILOT_SESSION_TTL_MS);
  const cookie=response.headers.get("set-cookie")||"";
  assert.match(cookie,new RegExp(PILOT_SESSION_COOKIE+"="));
  assert.match(cookie,/Max-Age=2592000/);
  assert.match(cookie,/HttpOnly/);
  assert.match(cookie,/Secure/);
  assert.match(cookie,/SameSite=Lax/);
});

test("pilot authorization remains tenant-bound",async()=>{
  const token=`gw_pilot_${"D".repeat(43)}`;
  const request=new Request(ORIGIN+"/x",{headers:{cookie:`${PILOT_SESSION_COOKIE}=${token}`}});
  const store={
    async authorizeSession({sessionHash,businessId}){
      assert.equal(sessionHash,hashPilotToken(token));
      assert.equal(businessId,"dexters-hats");
      return {business_id:"dexters-hats",expires_at:new Date(NOW.getTime()+60000)};
    },
  };
  const auth=await authorizePilotRequest(request,{store,businessId:"dexters-hats",now:NOW});
  assert.equal(auth.ok,true);
  assert.equal(auth.businessId,"dexters-hats");
});

test("Dexter session endpoint exposes only fixed pilot identity",async()=>{
  const handler=createDexterPilotSessionHandler({
    store:{
      async authorizeSession(){
        return {business_id:"dexters-hats",expires_at:new Date(NOW.getTime()+60000)};
      },
    },
    now:()=>NOW,
  });
  const token=`gw_pilot_${"E".repeat(43)}`;
  const response=await handler(new Request(ORIGIN+"/.netlify/functions/dexter-pilot-session",{
    headers:{cookie:`${PILOT_SESSION_COOKIE}=${token}`},
  }));
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.business_id,"dexters-hats");
  assert.equal(body.business_name,"Dexter's Hats");
});

test("Dexter Instagram health and OAuth start require pilot authorization",async()=>{
  const deniedConnection=createDexterInstagramConnectionHandler({
    pilotStore:{},
    pilotAuthorize:pilotDenied(),
    innerHandler:async()=>new Response("should-not-run"),
  });
  const denied=await deniedConnection(new Request(ORIGIN+"/.netlify/functions/dexter-instagram-connection"));
  assert.equal(denied.status,401);

  let innerRequest;
  const allowedConnection=createDexterInstagramConnectionHandler({
    pilotStore:{},
    pilotAuthorize:pilotAllowed(),
    innerHandler:async(request)=>{innerRequest=request;return new Response(JSON.stringify({state:"Connected"}),{status:200});},
  });
  const ok=await allowedConnection(new Request(ORIGIN+"/.netlify/functions/dexter-instagram-connection"));
  assert.equal(ok.status,200);
  assert.equal(new URL(innerRequest.url).searchParams.get("business_id"),"dexters-hats");

  let client;
  const oauth=createDexterInstagramOAuthStartHandler({
    pilotStore:{},
    pilotAuthorize:pilotAllowed(),
    innerFactory:(options)=>{
      client=options.getClient("dexters-hats");
      return async()=>new Response(JSON.stringify({authorization_url:"https://www.instagram.com/oauth/authorize?ok=1"}),{status:200,headers:{"content-type":"application/json"}});
    },
  });
  const oauthResponse=await oauth(new Request(ORIGIN+"/.netlify/functions/dexter-instagram-oauth-start",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({business_id:"dexters-hats"}),
  }));
  assert.equal(oauthResponse.status,200);
  assert.equal(client.returnDestinationId,"dexter-pilot-integration");
  assert.equal(resolveInstagramReturnDestination({
    destinationId:"dexter-pilot-integration",
    hint:"connected",
    publicOrigin:ORIGIN,
  }),ORIGIN+"/dexter-pilot.html?instagram=connected");
});

test("Dexter pilot actions use pilot session rather than connector/admin credentials",async()=>{
  let aiCalled=false;
  const draft=createDexterInstagramPhotoDraftHandler({
    pilotStore:{},
    pilotAuthorize:pilotDenied(),
    fetchImpl:async()=>{aiCalled=true;return new Response("{}");},
    env:()=> "synthetic",
  });
  const draftResponse=await draft(new Request(ORIGIN+"/.netlify/functions/dexter-instagram-photo-draft",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({image_data_url:"data:image/jpeg;base64,AA=="}),
  }));
  assert.equal(draftResponse.status,401);
  assert.equal(aiCalled,false);

  const publish=createDexterInstagramPublishHandler({
    pilotStore:{},
    pilotAuthorize:pilotDenied(),
    innerHandler:async()=>new Response("should-not-run"),
  });
  const publishResponse=await publish(new Request(ORIGIN+"/.netlify/functions/dexter-instagram-publish",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({business_id:"dexters-hats"}),
  }));
  assert.equal(publishResponse.status,401);

  let dbUsed=false;
  const feedback=createDexterPilotFeedbackHandler({
    pilotStore:{},
    pilotAuthorize:pilotDenied(),
    getDb:()=>{dbUsed=true;return {};},
  });
  const feedbackResponse=await feedback(new Request(ORIGIN+"/.netlify/functions/dexter-pilot-feedback",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({feature:"instagram-post",result:"worked",note:""}),
  }));
  assert.equal(feedbackResponse.status,401);
  assert.equal(dbUsed,false);

  const event=createDexterPilotEventHandler({
    pilotStore:{},
    pilotAuthorize:pilotDenied(),
    isAuthorized:()=>({ok:false}),
    getDb:()=>({}),
  });
  const eventResponse=await event(new Request(ORIGIN+"/.netlify/functions/dexter-pilot-event",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({event_name:"pilot_opened"}),
  }));
  assert.equal(eventResponse.status,401);
});

test("Dexter browser page has direct 30-day pilot flow and no admin unlock",async()=>{
  const html=await readFile(new URL("../../dexter-pilot.html",import.meta.url),"utf8");
  const js=await readFile(new URL("../../assets/dexter-pilot.mjs",import.meta.url),"utf8");
  assert.match(html,/igConnectButton/);
  assert.match(html,/assets\/dexter-pilot\.mjs/);
  assert.match(js,/dexter-pilot-invitation-exchange/);
  assert.match(js,/dexter-pilot-session/);
  assert.match(js,/dexter-instagram-oauth-start/);
  assert.match(js,/stay signed in for 30 days/i);
  assert.doesNotMatch(html+js,/growthwise_admin_key/i);
  assert.doesNotMatch(html+js,/X-GrowthWise-Key/i);
});
