const DEFAULT_GRAPH_VERSION="v26.0";
export const FACEBOOK_OAUTH_SCOPE="pages_show_list,pages_read_engagement,pages_manage_posts";

function env(name){return globalThis.Netlify?.env?.get(name)??"";}

function safeGraphVersion(value){
  const clean=String(value||"").trim();
  return /^v\d+\.\d+$/.test(clean)?clean:DEFAULT_GRAPH_VERSION;
}

function safeOrigin(value){
  const url=new URL(String(value||""));
  if(url.protocol!=="https:"||url.username||url.password||url.pathname!=="/"||url.search||url.hash){
    throw new Error("INVALID_PUBLIC_ORIGIN");
  }
  return url.origin;
}

export function configuredFacebookOAuth({publicOrigin}={}){
  const appId=env("GROWTHWISE_FACEBOOK_APP_ID")||env("GROWTHWISE_INSTAGRAM_APP_ID");
  const appSecret=env("GROWTHWISE_FACEBOOK_APP_SECRET")||env("GROWTHWISE_INSTAGRAM_APP_SECRET");
  const graphVersion=safeGraphVersion(env("FACEBOOK_GRAPH_VERSION"));
  const origin=safeOrigin(publicOrigin||env("GROWTHWISE_PUBLIC_ORIGIN"));
  if(!appId||!appSecret)throw new Error("FACEBOOK_OAUTH_NOT_CONFIGURED");
  return {
    appId,appSecret,graphVersion,publicOrigin:origin,
    callbackUri:`${origin}/.netlify/functions/facebook-oauth-callback`,
  };
}

export function buildFacebookAuthorizationUrl({appId,callbackUri,state,graphVersion=DEFAULT_GRAPH_VERSION}){
  const url=new URL(`https://www.facebook.com/${safeGraphVersion(graphVersion)}/dialog/oauth`);
  url.searchParams.set("client_id",appId);
  url.searchParams.set("redirect_uri",callbackUri);
  url.searchParams.set("response_type","code");
  url.searchParams.set("scope",FACEBOOK_OAUTH_SCOPE);
  url.searchParams.set("state",state);
  return url.toString();
}

async function readJson(response,maxBytes=512*1024){
  const declared=Number(response.headers.get("content-length")||0);
  if(Number.isFinite(declared)&&declared>maxBytes)throw Object.assign(new Error("response_too_large"),{httpStatus:response.status});
  const text=await response.text();
  if(Buffer.byteLength(text,"utf8")>maxBytes)throw Object.assign(new Error("response_too_large"),{httpStatus:response.status});
  let data={};
  if(text){
    try{data=JSON.parse(text);}catch{throw Object.assign(new Error("invalid_json"),{httpStatus:response.status});}
  }
  if(!response.ok){
    const error=new Error("facebook_http_error");
    error.httpStatus=response.status;
    error.providerCode=data?.error?.code;
    throw error;
  }
  return data;
}

export async function exchangeFacebookAuthorizationCode({
  appId,appSecret,callbackUri,code,graphVersion=DEFAULT_GRAPH_VERSION,fetchImpl=fetch,
}){
  const url=new URL(`https://graph.facebook.com/${safeGraphVersion(graphVersion)}/oauth/access_token`);
  url.searchParams.set("client_id",appId);
  url.searchParams.set("client_secret",appSecret);
  url.searchParams.set("redirect_uri",callbackUri);
  url.searchParams.set("code",code);
  const response=await fetchImpl(url,{method:"GET",headers:{accept:"application/json"}});
  const data=await readJson(response);
  if(typeof data.access_token!=="string"||!data.access_token){
    throw Object.assign(new Error("missing_access_token"),{httpStatus:response.status});
  }
  return {
    accessToken:data.access_token,
    tokenType:typeof data.token_type==="string"?data.token_type:"bearer",
    expiresInSeconds:Number.isFinite(Number(data.expires_in))?Number(data.expires_in):null,
  };
}

export async function listFacebookPages({
  accessToken,graphVersion=DEFAULT_GRAPH_VERSION,fetchImpl=fetch,
}){
  const url=new URL(`https://graph.facebook.com/${safeGraphVersion(graphVersion)}/me/accounts`);
  url.searchParams.set("fields","id,name,access_token,tasks");
  url.searchParams.set("limit","100");
  const response=await fetchImpl(url,{
    method:"GET",
    headers:{Authorization:`Bearer ${accessToken}`,accept:"application/json"},
  });
  const data=await readJson(response);
  const pages=(Array.isArray(data?.data)?data.data:[]).map((page)=>({
    id:typeof page?.id==="string"?page.id.trim():"",
    name:typeof page?.name==="string"?page.name.trim():"",
    accessToken:typeof page?.access_token==="string"?page.access_token:"",
    tasks:Array.isArray(page?.tasks)?page.tasks.filter((item)=>typeof item==="string"):[],
  })).filter((page)=>page.id&&page.name&&page.accessToken);
  return pages;
}

export async function verifyFacebookPage({
  pageId,pageAccessToken,graphVersion=DEFAULT_GRAPH_VERSION,fetchImpl=fetch,
}){
  const url=new URL(`https://graph.facebook.com/${safeGraphVersion(graphVersion)}/${encodeURIComponent(pageId)}`);
  url.searchParams.set("fields","id,name");
  const response=await fetchImpl(url,{
    method:"GET",
    headers:{Authorization:`Bearer ${pageAccessToken}`,accept:"application/json"},
  });
  const data=await readJson(response,128*1024);
  if(String(data?.id||"")!==String(pageId)||typeof data?.name!=="string"||!data.name.trim()){
    throw Object.assign(new Error("invalid_page_identity"),{httpStatus:response.status});
  }
  return {pageId:String(data.id),pageName:data.name.trim()};
}
