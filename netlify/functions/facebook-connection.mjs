import { authorizeConnectorRequest } from "./_connector-auth.mjs";
import { createConnectorStore } from "./_connector-store.mjs";
import { connectorJson } from "./_connector-http.mjs";
import { createFacebookCrypto } from "./_facebook-crypto.mjs";
import { createFacebookStore } from "./_facebook-store.mjs";
import { verifyFacebookPage } from "./_facebook-oauth.mjs";

const PATH="/.netlify/functions/facebook-connection";
const STATES=new Set(["active","needs_attention"]);

function env(name){return globalThis.Netlify?.env?.get(name)??"";}
function versions(name){return {current:{id:"v1",key:env(name)}};}
function defaultCrypto(){
  return createFacebookCrypto({
    stateSecrets:versions("GROWTHWISE_FACEBOOK_OAUTH_STATE_SECRET"),
    bindingSecrets:versions("GROWTHWISE_FACEBOOK_ACCOUNT_BINDING_SECRET"),
    credentialKeys:versions("GROWTHWISE_FACEBOOK_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

export function createFacebookConnectionHandler(options={}){
  const connectorStore=options.connectorStore??createConnectorStore();
  const connectorAuthorize=options.connectorAuthorize??authorizeConnectorRequest;
  const now=options.now??(()=>new Date());

  return async function facebookConnection(request){
    if(request.method!=="GET")return connectorJson(405,{error:"Method not allowed."},{allow:"GET"});
    const url=new URL(request.url);
    if(url.pathname!==PATH||url.hash||[...url.searchParams].length!==1
      ||url.searchParams.getAll("business_id").length!==1){
      return connectorJson(400,{error:"Invalid request."});
    }
    const businessId=url.searchParams.get("business_id");
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(businessId||"")){
      return connectorJson(400,{error:"Invalid request."});
    }
    const checkedAt=now();
    const auth=await connectorAuthorize(request,{
      store:connectorStore,businessId,connector:"facebook",now:checkedAt,
    });
    if(!auth?.ok||auth.businessId!==businessId){
      return connectorJson(401,{error:"Session is invalid or expired."});
    }

    try{
      const crypto=options.crypto??defaultCrypto();
      const store=options.store??createFacebookStore({crypto});
      const row=await store.readCredential({businessId});
      if(!row){
        return connectorJson(200,{
          business_id:businessId,state:"Not Connected",checked_at:checkedAt.toISOString(),
          action:"Connect the Facebook Page used by this business.",
        });
      }
      if(!STATES.has(row.status)||row.status!=="active"){
        return connectorJson(200,{
          business_id:businessId,state:"Needs Attention",checked_at:checkedAt.toISOString(),
          account:{page_name:row.page_name||"Facebook Page"},
          action:"Reconnect Facebook so GrowthWise can verify this Page.",
        });
      }
      let payload;
      try{
        payload=crypto.decryptCredential({
          businessId,
          pageId:"",
          pageBindingKey:row.page_binding_key,
          encryptedToken:row.encrypted_credential,
        });
      }catch{
        await store.updateCredentialHealth({
          businessId,status:"needs_attention",pageName:row.page_name,lastVerifiedAt:checkedAt,
        });
        return connectorJson(200,{
          business_id:businessId,state:"Needs Attention",checked_at:checkedAt.toISOString(),
          account:{page_name:row.page_name||"Facebook Page"},
          action:"Reconnect Facebook so GrowthWise can restore this Page.",
        });
      }
      if(typeof payload?.page_id!=="string"||!payload.page_id
        ||typeof payload?.page_access_token!=="string"||!payload.page_access_token){
        return connectorJson(200,{
          business_id:businessId,state:"Needs Attention",checked_at:checkedAt.toISOString(),
          account:{page_name:row.page_name||"Facebook Page"},
          action:"Reconnect Facebook so GrowthWise can restore this Page.",
        });
      }
      let identity;
      try{
        identity=await (options.verifyPage??verifyFacebookPage)({
          pageId:payload.page_id,
          pageAccessToken:payload.page_access_token,
          graphVersion:payload.graph_version||env("FACEBOOK_GRAPH_VERSION")||"v26.0",
        });
      }catch{
        await store.updateCredentialHealth({
          businessId,status:"needs_attention",pageName:row.page_name,lastVerifiedAt:checkedAt,
        });
        return connectorJson(200,{
          business_id:businessId,state:"Needs Attention",checked_at:checkedAt.toISOString(),
          account:{page_name:row.page_name||"Facebook Page"},
          action:"Reconnect Facebook so GrowthWise can verify Page access.",
        });
      }
      await store.updateCredentialHealth({
        businessId,status:"active",pageName:identity.pageName,lastVerifiedAt:checkedAt,
      });
      return connectorJson(200,{
        business_id:businessId,state:"Connected",checked_at:checkedAt.toISOString(),
        account:{page_name:identity.pageName},action:"",
      });
    }catch{
      return connectorJson(503,{error:"Facebook connection could not be checked."});
    }
  };
}

export default createFacebookConnectionHandler();
