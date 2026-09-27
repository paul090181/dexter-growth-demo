import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createFacebookOAuthStartHandler } from "../../netlify/functions/facebook-oauth-start.mjs";
import { createFacebookOAuthCallbackHandler } from "../../netlify/functions/facebook-oauth-callback.mjs";
import { createFacebookConnectionHandler } from "../../netlify/functions/facebook-connection.mjs";
import { createFacebookDisconnectHandler } from "../../netlify/functions/facebook-disconnect.mjs";
import { createFacebookPageOptionsHandler } from "../../netlify/functions/facebook-page-options.mjs";
import { createFacebookPageSelectHandler } from "../../netlify/functions/facebook-page-select.mjs";

const ORIGIN="https://deploy-preview-18--euphonious-beijinho-db4b4d.netlify.app";
const BUSINESS_ID="tierney-town-treats";
const NOW=new Date("2026-09-27T02:00:00.000Z");

function connectorAllowed(){
  return async (_request,{businessId,connector})=>{
    assert.equal(businessId,BUSINESS_ID);
    assert.equal(connector,"facebook");
    return {ok:true,businessId:BUSINESS_ID,connectors:["facebook"]};
  };
}
function connectorDenied(){return async()=>({ok:false,businessId:null,connectors:[]});}

test("Facebook OAuth start is tenant-bound and returns only a validated Meta authorization URL",async()=>{
  let stored=null;
  const handler=createFacebookOAuthStartHandler({
    connectorStore:{},
    connectorAuthorize:connectorAllowed(),
    now:()=>NOW,
    config:()=>({
      appId:"123456789",
      appSecret:"synthetic-secret",
      graphVersion:"v26.0",
      publicOrigin:ORIGIN,
      callbackUri:ORIGIN+"/.netlify/functions/facebook-oauth-callback",
    }),
    crypto:{createState:()=>({state:"v1.synthetic.state",nonceHash:"synthetic-hash"})},
    store:{
      async createTransactionWithFreshState(input){
        stored=input;
        return {state:"v1.synthetic.state"};
      },
    },
  });
  const response=await handler(new Request(ORIGIN+"/.netlify/functions/facebook-oauth-start",{
    method:"POST",
    headers:{
      "content-type":"application/json",
      origin:ORIGIN,
      "sec-fetch-site":"same-origin",
    },
    body:JSON.stringify({business_id:BUSINESS_ID}),
  }));
  assert.equal(response.status,200);
  const body=await response.json();
  const target=new URL(body.authorization_url);
  assert.equal(target.origin,"https://www.facebook.com");
  assert.equal(target.pathname,"/v26.0/dialog/oauth");
  assert.equal(target.searchParams.get("client_id"),"123456789");
  assert.equal(target.searchParams.get("redirect_uri"),ORIGIN+"/.netlify/functions/facebook-oauth-callback");
  assert.equal(target.searchParams.get("state"),"v1.synthetic.state");
  assert.equal(target.searchParams.get("scope"),"pages_show_list,pages_read_engagement,pages_manage_posts");
  assert.equal(stored.businessId,BUSINESS_ID);
});

test("Facebook OAuth start fails before provider navigation without the scoped connector session",async()=>{
  const handler=createFacebookOAuthStartHandler({
    connectorStore:{},
    connectorAuthorize:connectorDenied(),
    config:()=>({
      appId:"123456789",appSecret:"synthetic-secret",graphVersion:"v26.0",
      publicOrigin:ORIGIN,callbackUri:ORIGIN+"/.netlify/functions/facebook-oauth-callback",
    }),
  });
  const response=await handler(new Request(ORIGIN+"/.netlify/functions/facebook-oauth-start",{
    method:"POST",
    headers:{"content-type":"application/json",origin:ORIGIN,"sec-fetch-site":"same-origin"},
    body:JSON.stringify({business_id:BUSINESS_ID}),
  }));
  assert.equal(response.status,401);
});

test("Facebook callback connects exactly one manageable Page and stores no token in the redirect",async()=>{
  let connected=null;
  const store={
    async claimTransaction(){return {business_id:BUSINESS_ID,status:"processing"};},
    async connectCredential(input){connected=input;return {business_id:BUSINESS_ID};},
    async finishTransaction(){throw new Error("should not finish separately on success");},
  };
  const handler=createFacebookOAuthCallbackHandler({
    now:()=>NOW,
    config:()=>({
      appId:"123456789",appSecret:"synthetic-secret",graphVersion:"v26.0",
      publicOrigin:ORIGIN,callbackUri:ORIGIN+"/.netlify/functions/facebook-oauth-callback",
    }),
    crypto:{transactionKey:()=> "synthetic-hash"},
    store,
    exchangeCode:async()=>({accessToken:"USER_TOKEN",tokenType:"bearer",expiresInSeconds:3600}),
    listPages:async()=>[{id:"page-123",name:"Tierney Town Treats",accessToken:"PAGE_TOKEN",tasks:["CREATE_CONTENT"]}],
    verifyPage:async()=>({pageId:"page-123",pageName:"Tierney Town Treats"}),
    logger:{warn(){}},
  });
  const response=await handler(new Request(
    ORIGIN+"/.netlify/functions/facebook-oauth-callback?state=v1.synthetic.state&code=provider-code",
  ));
  assert.equal(response.status,303);
  const location=response.headers.get("location");
  assert.equal(location,ORIGIN+"/connect-accounts.html?facebook=connected");
  assert.equal(location.includes("PAGE_TOKEN"),false);
  assert.equal(connected.businessId,BUSINESS_ID);
  assert.equal(connected.pageId,"page-123");
  assert.equal(connected.payload.page_access_token,"PAGE_TOKEN");
  assert.deepEqual(connected.payload.permissions,["pages_show_list","pages_read_engagement","pages_manage_posts"]);
});

test("Facebook callback never guesses when an owner manages multiple Pages",async()=>{
  let connected=false,saved=null;
  const selectionToken=`gw_fbsel_${"S".repeat(43)}`;
  const handler=createFacebookOAuthCallbackHandler({
    now:()=>NOW,
    config:()=>({
      appId:"123456789",appSecret:"synthetic-secret",graphVersion:"v26.0",
      publicOrigin:ORIGIN,callbackUri:ORIGIN+"/.netlify/functions/facebook-oauth-callback",
    }),
    crypto:{transactionKey:()=> "synthetic-hash"},
    store:{
      async claimTransaction(){return {business_id:BUSINESS_ID,status:"processing"};},
      async connectCredential(){connected=true;},
      async savePageSelection(input){saved=input;return input;},
    },
    selectionTokenFactory:()=>selectionToken,
    exchangeCode:async()=>({accessToken:"USER_TOKEN"}),
    listPages:async()=>[
      {id:"page-1",name:"One",accessToken:"TOKEN_1",tasks:[]},
      {id:"page-2",name:"Two",accessToken:"TOKEN_2",tasks:[]},
    ],
    logger:{warn(){}},
  });
  const response=await handler(new Request(
    ORIGIN+"/.netlify/functions/facebook-oauth-callback?state=v1.synthetic.state&code=provider-code",
  ));
  assert.equal(response.status,303);
  const location=response.headers.get("location");
  assert.match(location,/\/connect-accounts\.html\?facebook=select#facebook_selection=gw_fbsel_/);
  assert.equal(location.includes("TOKEN_1"),false);
  assert.equal(location.includes("TOKEN_2"),false);
  assert.equal(connected,false);
  assert.equal(saved.businessId,BUSINESS_ID);
  assert.equal(saved.pages.length,2);
});

test("Facebook Page options return only Page ids and names from the tenant-bound selection",async()=>{
  const selectionToken=`gw_fbsel_${"T".repeat(43)}`;
  const handler=createFacebookPageOptionsHandler({
    connectorStore:{},
    connectorAuthorize:connectorAllowed(),
    now:()=>NOW,
    crypto:{},
    store:{
      async readPageSelection(){
        return {
          business_id:BUSINESS_ID,
          selection_expires_at:new Date(NOW.getTime()+600000),
          pages:[
            {id:"page-1",name:"One",accessToken:"SECRET_1",tasks:[]},
            {id:"page-2",name:"Two",accessToken:"SECRET_2",tasks:[]},
          ],
        };
      },
    },
  });
  const response=await handler(new Request(ORIGIN+"/.netlify/functions/facebook-page-options",{
    method:"POST",
    headers:{"content-type":"application/json",origin:ORIGIN,"sec-fetch-site":"same-origin"},
    body:JSON.stringify({selection_token:selectionToken}),
  }));
  assert.equal(response.status,200);
  const body=await response.json();
  assert.deepEqual(body.pages,[{id:"page-1",name:"One"},{id:"page-2",name:"Two"}]);
  assert.equal(JSON.stringify(body).includes("SECRET_"),false);
});

test("Facebook Page selection verifies the chosen Page and consumes only that tenant selection",async()=>{
  const selectionToken=`gw_fbsel_${"U".repeat(43)}`;
  let connected=null;
  const handler=createFacebookPageSelectHandler({
    connectorStore:{},
    connectorAuthorize:connectorAllowed(),
    now:()=>NOW,
    crypto:{},
    store:{
      async readPageSelection(){
        return {
          business_id:BUSINESS_ID,
          selection_expires_at:new Date(NOW.getTime()+600000),
          pages:[
            {id:"page-1",name:"One",accessToken:"SECRET_1",tasks:[]},
            {id:"page-2",name:"Two",accessToken:"SECRET_2",tasks:[]},
          ],
        };
      },
      async connectSelectedCredential(input){connected=input;return {business_id:BUSINESS_ID};},
    },
    verifyPage:async({pageId,pageAccessToken})=>{
      assert.equal(pageId,"page-2");
      assert.equal(pageAccessToken,"SECRET_2");
      return {pageId:"page-2",pageName:"Two"};
    },
  });
  const response=await handler(new Request(ORIGIN+"/.netlify/functions/facebook-page-select",{
    method:"POST",
    headers:{"content-type":"application/json",origin:ORIGIN,"sec-fetch-site":"same-origin"},
    body:JSON.stringify({page_id:"page-2",selection_token:selectionToken}),
  }));
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.account.page_name,"Two");
  assert.equal(connected.businessId,BUSINESS_ID);
  assert.equal(connected.pageId,"page-2");
});

test("Facebook health is connector-scoped and reports the stored Page identity",async()=>{
  const handler=createFacebookConnectionHandler({
    connectorStore:{},
    connectorAuthorize:connectorAllowed(),
    now:()=>NOW,
    crypto:{
      decryptCredential:()=>({
        page_id:"page-123",page_access_token:"PAGE_TOKEN",graph_version:"v26.0",
      }),
    },
    store:{
      async readCredential(){return {
        business_id:BUSINESS_ID,status:"active",page_name:"Tierney Town Treats",
        page_binding_key:"v1.binding",encrypted_credential:{algorithm:"A256GCM"},
      };},
      async updateCredentialHealth(){return {};},
    },
    verifyPage:async()=>({pageId:"page-123",pageName:"Tierney Town Treats"}),
  });
  const response=await handler(new Request(
    ORIGIN+"/.netlify/functions/facebook-connection?business_id="+BUSINESS_ID,
  ));
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.state,"Connected");
  assert.equal(body.account.page_name,"Tierney Town Treats");
});

test("Facebook disconnect deletes only the session-bound business credential",async()=>{
  let deleted=null;
  const handler=createFacebookDisconnectHandler({
    connectorStore:{},
    connectorAuthorize:connectorAllowed(),
    now:()=>NOW,
    crypto:{},
    store:{async disconnectCredential(input){deleted=input;return {business_id:BUSINESS_ID};}},
  });
  const response=await handler(new Request(ORIGIN+"/.netlify/functions/facebook-disconnect",{
    method:"POST",
    headers:{"content-type":"application/json",origin:ORIGIN,"sec-fetch-site":"same-origin"},
    body:JSON.stringify({business_id:BUSINESS_ID}),
  }));
  assert.equal(response.status,200);
  assert.deepEqual(deleted,{businessId:BUSINESS_ID});
});

test("Facebook connector code and UI never embed provider credentials",async()=>{
  const files=await Promise.all([
    readFile(new URL("../../connect-accounts.html",import.meta.url),"utf8"),
    readFile(new URL("../../assets/connector-invitation.mjs",import.meta.url),"utf8"),
    readFile(new URL("../../netlify/functions/facebook-oauth-start.mjs",import.meta.url),"utf8"),
    readFile(new URL("../../netlify/functions/facebook-oauth-callback.mjs",import.meta.url),"utf8"),
  ]);
  const combined=files.join("\n");
  assert.match(combined,/Connect Facebook/);
  assert.doesNotMatch(combined,/EA[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(combined,/FACEBOOK_PAGE_ACCESS_TOKEN\s*=\s*["'][^"']+/);
});
