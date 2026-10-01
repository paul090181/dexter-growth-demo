import { authorizeConnectorRequest } from "./_connector-auth.mjs";
import { createConnectorStore } from "./_connector-store.mjs";
import { canonicalOrigin, connectorJson, exactKeys, readConnectorJson } from "./_connector-http.mjs";
import { createFacebookCrypto } from "./_facebook-crypto.mjs";
import { createFacebookStore } from "./_facebook-store.mjs";
import { resolveGrowthWisePublicOrigin } from "./_public-origin.mjs";

const PATH="/.netlify/functions/facebook-disconnect";

function env(name){return globalThis.Netlify?.env?.get(name)??"";}
function versions(name){return {current:{id:"v1",key:env(name)}};}
function defaultCrypto(){
  return createFacebookCrypto({
    stateSecrets:versions("GROWTHWISE_FACEBOOK_OAUTH_STATE_SECRET"),
    bindingSecrets:versions("GROWTHWISE_FACEBOOK_ACCOUNT_BINDING_SECRET"),
    credentialKeys:versions("GROWTHWISE_FACEBOOK_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

export function createFacebookDisconnectHandler(options={}){
  const connectorStore=options.connectorStore??createConnectorStore();
  const connectorAuthorize=options.connectorAuthorize??authorizeConnectorRequest;
  const now=options.now??(()=>new Date());

  return async function facebookDisconnect(request){
    if(request.method!=="POST")return connectorJson(405,{error:"Method not allowed."},{allow:"POST"});
    let origin,url;
    try{
      origin=canonicalOrigin(resolveGrowthWisePublicOrigin((name)=>env(name),request.url));
      url=new URL(request.url);
    }catch{return connectorJson(503,{error:"Facebook connection is not configured."});}
    if(url.origin!==origin||url.pathname!==PATH||url.search||url.hash
      ||request.headers.get("origin")!==origin
      ||(request.headers.get("sec-fetch-site")!==null&&request.headers.get("sec-fetch-site")!=="same-origin")){
      return connectorJson(403,{error:"Request origin was rejected."});
    }
    let body;
    try{body=await readConnectorJson(request);}catch{return connectorJson(400,{error:"Invalid request."});}
    if(!exactKeys(body,["business_id"])||typeof body.business_id!=="string"
      ||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.business_id)){
      return connectorJson(400,{error:"Invalid request."});
    }
    const auth=await connectorAuthorize(request,{
      store:connectorStore,businessId:body.business_id,connector:"facebook",now:now(),
    });
    if(!auth?.ok||auth.businessId!==body.business_id){
      return connectorJson(401,{error:"Session is invalid or expired."});
    }
    try{
      const store=options.store??createFacebookStore({crypto:options.crypto??defaultCrypto()});
      await store.disconnectCredential({businessId:body.business_id});
      return connectorJson(200,{ok:true});
    }catch{
      return connectorJson(503,{error:"Facebook could not be disconnected."});
    }
  };
}

export default createFacebookDisconnectHandler();
