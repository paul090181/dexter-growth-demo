import { createFacebookCrypto } from "./_facebook-crypto.mjs";
import { createFacebookStore } from "./_facebook-store.mjs";
import {
  configuredFacebookOAuth,
  exchangeFacebookAuthorizationCode,
  listFacebookPages,
  verifyFacebookPage,
} from "./_facebook-oauth.mjs";
import { resolveGrowthWisePublicOrigin } from "./_public-origin.mjs";

const PATH="/.netlify/functions/facebook-oauth-callback";
const MAX_QUERY_BYTES=8192;
const SAFE_HEADERS={
  "cache-control":"no-store",
  pragma:"no-cache",
  "referrer-policy":"no-referrer",
  "x-content-type-options":"nosniff",
};

function env(name){return globalThis.Netlify?.env?.get(name)??"";}
function versions(name){return {current:{id:"v1",key:env(name)}};}
function defaultCrypto(){
  return createFacebookCrypto({
    stateSecrets:versions("GROWTHWISE_FACEBOOK_OAUTH_STATE_SECRET"),
    bindingSecrets:versions("GROWTHWISE_FACEBOOK_ACCOUNT_BINDING_SECRET"),
    credentialKeys:versions("GROWTHWISE_FACEBOOK_CREDENTIAL_ENCRYPTION_KEY"),
  });
}
function plain(status){
  return new Response("Facebook connection could not be completed.",{
    status,headers:{...SAFE_HEADERS,"content-type":"text/plain; charset=utf-8"},
  });
}
function redirect(origin,hint){
  const target=new URL("/connect-accounts.html",origin);
  target.searchParams.set("facebook",hint);
  return new Response(null,{status:303,headers:{...SAFE_HEADERS,location:target.toString()}});
}
function parseCallback(request){
  if(request.method!=="GET")throw new Error("INVALID_CALLBACK");
  const url=new URL(request.url);
  if(url.pathname!==PATH||url.hash||Buffer.byteLength(url.search,"utf8")>MAX_QUERY_BYTES){
    throw new Error("INVALID_CALLBACK");
  }
  const entries=[...url.searchParams];
  if(entries.some(([key,value])=>!key||!value)
    ||new Set(entries.map(([key])=>key)).size!==entries.length){
    throw new Error("INVALID_CALLBACK");
  }
  const keys=new Set(entries.map(([key])=>key));
  const successAllowed=new Set(["state","code"]);
  const success=keys.has("state")&&keys.has("code")&&[...keys].every((key)=>successAllowed.has(key));
  const denialAllowed=new Set(["state","error","error_code","error_reason","error_description"]);
  const denial=keys.has("state")&&keys.has("error")&&[...keys].every((key)=>denialAllowed.has(key));
  if(!success&&!denial)throw new Error("INVALID_CALLBACK");
  return {url,state:url.searchParams.get("state"),code:success?url.searchParams.get("code"):null,denied:denial};
}

export function createFacebookOAuthCallbackHandler(options={}){
  const now=options.now??(()=>new Date());
  const logger=options.logger??console;
  const safeWarn=(stage,status=null)=>{
    try{logger.warn("facebook_oauth_callback_failed",{stage,...(Number.isInteger(status)?{provider_status:status}:{})});}catch{}
  };

  return async function facebookOAuthCallback(request){
    let input;
    try{input=parseCallback(request);}catch{safeWarn("parse_callback");return plain(400);}

    let origin,settings,crypto,transactionKey;
    try{
      origin=resolveGrowthWisePublicOrigin((name)=>env(name),request.url);
      settings=(options.config??configuredFacebookOAuth)({publicOrigin:origin});
      const canonical=new URL(settings.publicOrigin);
      if(canonical.protocol!=="https:"||canonical.origin!==settings.publicOrigin||canonical.pathname!=="/"
        ||canonical.search||canonical.hash||input.url.origin!==canonical.origin||input.url.pathname!==PATH
        ||input.url.username||input.url.password)throw new Error("INVALID_ORIGIN");
      crypto=options.crypto??defaultCrypto();
      transactionKey=crypto.transactionKey(input.state);
    }catch{safeWarn("state_or_config");return plain(400);}

    const store=options.store??createFacebookStore({crypto});
    let transaction;
    try{transaction=await store.claimTransaction({transactionKey});}
    catch{safeWarn("transaction_claim");return plain(400);}
    if(!transaction){safeWarn("transaction_missing_or_replayed");return plain(400);}

    if(input.denied){
      try{
        await store.finishTransaction({transactionKey,status:"consumed_denied",now:now()});
        return redirect(settings.publicOrigin,"cancelled");
      }catch{safeWarn("denial_finalize");return plain(500);}
    }

    let stage="provider_code_exchange";
    try{
      const userToken=await (options.exchangeCode??exchangeFacebookAuthorizationCode)({
        appId:settings.appId,appSecret:settings.appSecret,callbackUri:settings.callbackUri,
        code:input.code,graphVersion:settings.graphVersion,
      });
      stage="page_list";
      const pages=await (options.listPages??listFacebookPages)({
        accessToken:userToken.accessToken,graphVersion:settings.graphVersion,
      });
      if(pages.length!==1){
        await store.finishTransaction({transactionKey,status:"consumed_failed",now:now()});
        return redirect(settings.publicOrigin,pages.length>1?"multiple-pages":"no-page");
      }
      const page=pages[0];
      stage="page_verify";
      const identity=await (options.verifyPage??verifyFacebookPage)({
        pageId:page.id,pageAccessToken:page.accessToken,graphVersion:settings.graphVersion,
      });
      const verifiedAt=now();
      stage="credential_store";
      await store.connectCredential({
        businessId:transaction.business_id,
        pageId:identity.pageId,
        payload:{
          page_id:identity.pageId,
          page_access_token:page.accessToken,
          graph_version:settings.graphVersion,
          permissions:["pages_show_list","pages_read_engagement","pages_manage_posts"],
        },
        status:"active",
        pageName:identity.pageName,
        lastVerifiedAt:verifiedAt,
        transactionKey,
        consumedAt:verifiedAt,
      });
      return redirect(settings.publicOrigin,"connected");
    }catch(error){
      safeWarn(stage,error?.httpStatus);
      try{
        await store.finishTransaction({transactionKey,status:"consumed_failed",now:now()});
        return redirect(settings.publicOrigin,"attention");
      }catch{return plain(500);}
    }
  };
}

export default createFacebookOAuthCallbackHandler();
