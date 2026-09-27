import { authorizeConnectorRequest } from "./_connector-auth.mjs";
import { canonicalOrigin, connectorJson, exactKeys, readConnectorJson } from "./_connector-http.mjs";
import { createConnectorStore } from "./_connector-store.mjs";
import { createFacebookCrypto } from "./_facebook-crypto.mjs";
import { createFacebookStore } from "./_facebook-store.mjs";
import {
  FACEBOOK_OAUTH_SCOPE,
  buildFacebookAuthorizationUrl,
  configuredFacebookOAuth,
} from "./_facebook-oauth.mjs";
import { resolveGrowthWisePublicOrigin } from "./_public-origin.mjs";

const PATH="/.netlify/functions/facebook-oauth-start";
const TTL_MS=10*60*1000;

function env(name){return globalThis.Netlify?.env?.get(name)??"";}
function versions(name){return {current:{id:"v1",key:env(name)}};}
function cryptoConfig(){
  return createFacebookCrypto({
    stateSecrets:versions("GROWTHWISE_FACEBOOK_OAUTH_STATE_SECRET"),
    bindingSecrets:versions("GROWTHWISE_FACEBOOK_ACCOUNT_BINDING_SECRET"),
    credentialKeys:versions("GROWTHWISE_FACEBOOK_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

function validateAuthorizationUrl(value,{appId,callbackUri,state,graphVersion}){
  const url=new URL(value);
  const expected={
    client_id:appId,
    redirect_uri:callbackUri,
    response_type:"code",
    scope:FACEBOOK_OAUTH_SCOPE,
    state,
  };
  if(url.protocol!=="https:"||url.hostname!=="www.facebook.com"
    ||url.pathname!==`/${graphVersion}/dialog/oauth`
    ||url.username||url.password||url.hash){
    throw new Error("UNSAFE_AUTHORIZATION_URL");
  }
  const entries=[...url.searchParams];
  if(entries.length!==Object.keys(expected).length)throw new Error("UNSAFE_AUTHORIZATION_URL");
  for(const [key,wanted] of Object.entries(expected)){
    const values=url.searchParams.getAll(key);
    if(values.length!==1||values[0]!==wanted)throw new Error("UNSAFE_AUTHORIZATION_URL");
  }
  return url;
}

export function createFacebookOAuthStartHandler(options={}){
  const connectorStore=options.connectorStore??createConnectorStore();
  const connectorAuthorize=options.connectorAuthorize??authorizeConnectorRequest;
  const now=options.now??(()=>new Date());

  return async function facebookOAuthStart(request){
    if(request.method!=="POST"){
      return connectorJson(405,{error:"Method not allowed."},{allow:"POST"});
    }
    let origin,requestUrl,settings;
    try{
      origin=canonicalOrigin(resolveGrowthWisePublicOrigin(
        (name)=>env(name),
        request.url,
      ));
      requestUrl=new URL(request.url);
      settings=(options.config??configuredFacebookOAuth)({publicOrigin:origin});
    }catch{
      return connectorJson(503,{error:"Facebook connection is not configured."});
    }
    if(requestUrl.origin!==origin||requestUrl.pathname!==PATH||requestUrl.search||requestUrl.hash
      ||request.headers.get("origin")!==origin
      ||(request.headers.get("sec-fetch-site")!==null&&request.headers.get("sec-fetch-site")!=="same-origin")){
      return connectorJson(403,{error:"Request origin was rejected."});
    }

    let body;
    try{body=await readConnectorJson(request);}catch{return connectorJson(400,{error:"Invalid request."});}
    if(!exactKeys(body,["business_id"])
      ||typeof body.business_id!=="string"
      ||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.business_id)){
      return connectorJson(400,{error:"Invalid request."});
    }

    const startedAt=now();
    const auth=await connectorAuthorize(request,{
      store:connectorStore,businessId:body.business_id,connector:"facebook",now:startedAt,
    });
    if(!auth?.ok||auth.businessId!==body.business_id){
      return connectorJson(401,{error:"Session is invalid or expired."});
    }

    try{
      const crypto=options.crypto??cryptoConfig();
      const store=options.store??createFacebookStore({crypto});
      const {state}=await store.createTransactionWithFreshState({
        createState:()=>crypto.createState(),
        businessId:body.business_id,
        expiresAt:new Date(startedAt.getTime()+TTL_MS),
      });
      const authorizationUrl=(options.buildUrl??buildFacebookAuthorizationUrl)({
        appId:settings.appId,
        callbackUri:settings.callbackUri,
        state,
        graphVersion:settings.graphVersion,
      });
      const safe=validateAuthorizationUrl(authorizationUrl,{
        appId:settings.appId,callbackUri:settings.callbackUri,state,graphVersion:settings.graphVersion,
      });
      return connectorJson(200,{authorization_url:safe.toString()});
    }catch{
      return connectorJson(503,{error:"Facebook connection could not be started."});
    }
  };
}

export default createFacebookOAuthStartHandler();
