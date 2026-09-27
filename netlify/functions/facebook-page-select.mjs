import { authorizeConnectorRequest } from "./_connector-auth.mjs";
import { createConnectorStore } from "./_connector-store.mjs";
import { canonicalOrigin, connectorJson, exactKeys, readConnectorJson } from "./_connector-http.mjs";
import { createFacebookCrypto } from "./_facebook-crypto.mjs";
import { createFacebookStore } from "./_facebook-store.mjs";
import {
  facebookSelectionTokenPattern,
  hashFacebookSelectionToken,
} from "./_facebook-selection.mjs";
import { verifyFacebookPage } from "./_facebook-oauth.mjs";
import { resolveGrowthWisePublicOrigin } from "./_public-origin.mjs";

const PATH="/.netlify/functions/facebook-page-select";

function env(name){return globalThis.Netlify?.env?.get(name)??"";}
function versions(name){return {current:{id:"v1",key:env(name)}};}
function defaultCrypto(){
  return createFacebookCrypto({
    stateSecrets:versions("GROWTHWISE_FACEBOOK_OAUTH_STATE_SECRET"),
    bindingSecrets:versions("GROWTHWISE_FACEBOOK_ACCOUNT_BINDING_SECRET"),
    credentialKeys:versions("GROWTHWISE_FACEBOOK_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

export function createFacebookPageSelectHandler(options={}){
  const connectorStore=options.connectorStore??createConnectorStore();
  const connectorAuthorize=options.connectorAuthorize??authorizeConnectorRequest;
  const now=options.now??(()=>new Date());

  return async function facebookPageSelect(request){
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
    if(!exactKeys(body,["page_id","selection_token"])
      ||!facebookSelectionTokenPattern.test(String(body.selection_token||""))
      ||typeof body.page_id!=="string"||!body.page_id.trim()||body.page_id.length>200){
      return connectorJson(400,{error:"Invalid Page selection."});
    }

    const checkedAt=now();
    const auth=await connectorAuthorize(request,{store:connectorStore,connector:"facebook",now:checkedAt});
    if(!auth?.ok||!auth.businessId||!auth.connectors?.includes("facebook")){
      return connectorJson(401,{error:"Session is invalid or expired."});
    }

    const crypto=options.crypto??defaultCrypto();
    const store=options.store??createFacebookStore({crypto});
    const selectionHash=hashFacebookSelectionToken(body.selection_token);
    let selection;
    try{
      selection=await store.readPageSelection({
        selectionHash,businessId:auth.businessId,now:checkedAt,
      });
    }catch{}
    if(!selection)return connectorJson(401,{error:"Page selection is invalid or expired."});
    const selected=selection.pages.find((page)=>page.id===body.page_id.trim());
    if(!selected)return connectorJson(400,{error:"Choose one of the Pages shown by GrowthWise."});

    let identity;
    try{
      identity=await (options.verifyPage??verifyFacebookPage)({
        pageId:selected.id,
        pageAccessToken:selected.accessToken,
        graphVersion:env("FACEBOOK_GRAPH_VERSION")||"v26.0",
      });
    }catch{
      return connectorJson(503,{error:"GrowthWise could not verify that Facebook Page. Try connecting Facebook again."});
    }

    try{
      await store.connectSelectedCredential({
        selectionHash,
        businessId:auth.businessId,
        pageId:identity.pageId,
        verifiedPageName:identity.pageName,
        graphVersion:env("FACEBOOK_GRAPH_VERSION")||"v26.0",
        now:checkedAt,
      });
      return connectorJson(200,{
        ok:true,
        business_id:auth.businessId,
        account:{page_name:identity.pageName},
      });
    }catch(error){
      if(error?.message==="PAGE_REBIND_FORBIDDEN"){
        return connectorJson(409,{error:"That Facebook Page is already connected to another GrowthWise business."});
      }
      return connectorJson(401,{error:"Page selection is invalid or expired."});
    }
  };
}

export default createFacebookPageSelectHandler();
