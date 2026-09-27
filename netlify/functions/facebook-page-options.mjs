import { authorizeConnectorRequest } from "./_connector-auth.mjs";
import { createConnectorStore } from "./_connector-store.mjs";
import { canonicalOrigin, connectorJson, exactKeys, readConnectorJson } from "./_connector-http.mjs";
import { createFacebookCrypto } from "./_facebook-crypto.mjs";
import { createFacebookStore } from "./_facebook-store.mjs";
import {
  facebookSelectionTokenPattern,
  hashFacebookSelectionToken,
} from "./_facebook-selection.mjs";
import { resolveGrowthWisePublicOrigin } from "./_public-origin.mjs";

const PATH="/.netlify/functions/facebook-page-options";

function env(name){return globalThis.Netlify?.env?.get(name)??"";}
function versions(name){return {current:{id:"v1",key:env(name)}};}
function defaultCrypto(){
  return createFacebookCrypto({
    stateSecrets:versions("GROWTHWISE_FACEBOOK_OAUTH_STATE_SECRET"),
    bindingSecrets:versions("GROWTHWISE_FACEBOOK_ACCOUNT_BINDING_SECRET"),
    credentialKeys:versions("GROWTHWISE_FACEBOOK_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

export function createFacebookPageOptionsHandler(options={}){
  const connectorStore=options.connectorStore??createConnectorStore();
  const connectorAuthorize=options.connectorAuthorize??authorizeConnectorRequest;
  const now=options.now??(()=>new Date());

  return async function facebookPageOptions(request){
    if(request.method!=="POST")return connectorJson(405,{error:"Method not allowed."},{allow:"POST"});
    let origin,url;
    try{
      origin=canonicalOrigin(resolveGrowthWisePublicOrigin((name)=>env(name),request.url));
      url=new URL(request.url);
    }catch{return connectorJson(503,{error:"Facebook Page selection is unavailable."});}
    if(url.origin!==origin||url.pathname!==PATH||url.search||url.hash
      ||request.headers.get("origin")!==origin
      ||(request.headers.get("sec-fetch-site")!==null&&request.headers.get("sec-fetch-site")!=="same-origin")){
      return connectorJson(403,{error:"Request origin was rejected."});
    }
    let body;
    try{body=await readConnectorJson(request);}catch{return connectorJson(400,{error:"Invalid request."});}
    if(!exactKeys(body,["selection_token"])
      ||!facebookSelectionTokenPattern.test(String(body.selection_token||""))){
      return connectorJson(400,{error:"Invalid Page selection."});
    }

    const auth=await connectorAuthorize(request,{store:connectorStore,connector:"facebook",now:now()});
    if(!auth?.ok||!auth.businessId||!auth.connectors?.includes("facebook")){
      return connectorJson(401,{error:"Session is invalid or expired."});
    }
    try{
      const store=options.store??createFacebookStore({crypto:options.crypto??defaultCrypto()});
      const selection=await store.readPageSelection({
        selectionHash:hashFacebookSelectionToken(body.selection_token),
        businessId:auth.businessId,
        now:now(),
      });
      if(!selection)return connectorJson(401,{error:"Page selection is invalid or expired."});
      return connectorJson(200,{
        business_id:auth.businessId,
        pages:selection.pages.map((page)=>({id:page.id,name:page.name})),
        expires_at:selection.selection_expires_at.toISOString(),
      });
    }catch{
      return connectorJson(401,{error:"Page selection is invalid or expired."});
    }
  };
}

export default createFacebookPageOptionsHandler();
