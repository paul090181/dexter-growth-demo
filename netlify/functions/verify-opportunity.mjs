const OPENAI_URL="https://api.openai.com/v1/responses";
function json(status,body){return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}})}
function clean(v,max=5000){return String(v??"").trim().slice(0,max)}
function num(v,f=0){const n=Number(v);return Number.isFinite(n)?n:f}
function extractOutputText(data){for(const item of data?.output||[]){if(item?.type!=="message")continue;for(const part of item?.content||[]){if(part?.type==="output_text"&&typeof part.text==="string")return part.text}}return ""}
function collectSourceUrls(data){const out=[];for(const item of data?.output||[]){if(item?.type!=="web_search_call")continue;for(const s of item?.action?.sources||[]){if(s?.url&&!out.includes(s.url))out.push(s.url)}}return out}
function normalizeUrl(url){const v=clean(url,1200);return /^https?:\/\//i.test(v)?v:""}
function exactSourceMatch(url,sources){const raw=normalizeUrl(url);if(!raw)return "";if(sources.includes(raw))return raw;try{const u=new URL(raw);for(const s of sources){try{const su=new URL(s);if(u.hostname===su.hostname&&u.pathname===su.pathname&&u.search===su.search)return s}catch{}}}catch{}return ""}
function isLikelySearchOrCollectionPage(url){
  try{
    const u=new URL(url);
    const host=u.hostname.toLowerCase();
    const path=(u.pathname||"").toLowerCase();
    const q=(u.search||"").toLowerCase();
    if(host.includes("cars.com")){
      if(path.startsWith("/shopping/") || path.includes("/research/") || path==="/shopping") return true;
      return !path.includes("/vehicledetail/");
    }
    if(host.includes("autotrader.com")){
      if(path.includes("/cars-for-sale/") && !path.includes("vehicledetails")) return true;
      return !(path.includes("vehicledetails") || q.includes("listingid="));
    }
    if(host.includes("truecar.com")){
      if(path.includes("/used-cars-for-sale/") && !path.includes("/listing/")) return true;
      return !path.includes("/listing/");
    }
    if(host.includes("cargurus.com")){
      return !(path.includes("/cars/") && (q.includes("listingid=") || path.includes("inventorylisting")));
    }
    if(host.includes("craigslist.org")){
      return !/\/\d+\.html$/.test(path);
    }
    if(host.includes("facebook.com")){
      return !path.includes("/marketplace/item/");
    }
    // For unknown dealer sites, reject obvious search/inventory/category pages.
    if(/\/(search|inventory|vehicles?|cars-for-sale|used-cars|preowned|pre-owned)(\/|$)/.test(path) && !/\d{5,}/.test(path+q)) return true;
    if(q.includes("page=") || q.includes("sort=") || q.includes("price-") || q.includes("radius=")) return true;
    // Unknown sites may still have direct detail URLs; require a reasonably specific path/query.
    const specificity=(path.split("/").filter(Boolean).length>=2) || /vin=|stock=|listingid=|vehicleid=|id=/.test(q);
    return !specificity;
  }catch{return true}
}
function directListingSourceMatch(url,sources){
  const exact=exactSourceMatch(url,sources);
  if(!exact || isLikelySearchOrCollectionPage(exact)) return "";
  return exact;
}

export default async(request)=>{
 if(request.method==="OPTIONS")return new Response(null,{status:204,headers:{"Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, X-GrowthWise-Key"}});
 if(request.method!=="POST")return json(405,{error:"Method not allowed"});
 const adminKey=Netlify.env.get("GROWTHWISE_ADMIN_KEY"),openaiKey=Netlify.env.get("OPENAI_API_KEY"),model=Netlify.env.get("OPENAI_AUTOMOTIVE_MODEL")||Netlify.env.get("OPENAI_PRODUCT_MODEL")||"gpt-5.6-luna";
 if(!adminKey||!openaiKey)return json(500,{error:"Server AI configuration is incomplete."});
 if((request.headers.get("x-growthwise-key")||"")!==adminKey)return json(401,{error:"Invalid GrowthWise admin key."});
 let body;try{body=await request.json()}catch{return json(400,{error:"Invalid JSON body."})}
 const candidate={year:Math.round(num(body.year)),make:clean(body.make,80),model:clean(body.model,100),trim:clean(body.trim,100),location:clean(body.location,160),asking_price:Math.max(0,num(body.asking_price)),mileage:Math.max(0,num(body.mileage)),source_type:clean(body.source_type,100),discovery_url:normalizeUrl(body.discovery_url)};
 if(!candidate.year||!candidate.make||!candidate.model)return json(400,{error:"Year, make and model are required to verify a lead."});
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),7000);
 try{
  const response=await fetch(OPENAI_URL,{method:"POST",signal:controller.signal,headers:{"Authorization":`Bearer ${openaiKey}`,"Content-Type":"application/json"},body:JSON.stringify({
   model,store:false,include:["web_search_call.action.sources"],reasoning:{effort:"none"},tools:[{type:"web_search",search_context_size:"low"}],
   instructions:"Verify ONE vehicle research lead against a CURRENT direct public listing detail page. matched=true only if the exact advertised vehicle can be identified by same year/make/model and reasonably consistent price/mileage/location. listing_url must be copied verbatim from an actual web-search source URL returned in this response. Do not use category/search pages, generic inventory pages, homepages or inferred URLs. If you cannot verify a direct detail page, matched=false and listing_url must be empty. Never guess.",
   input:[{role:"user",content:[{type:"input_text",text:`Verify this vehicle research lead:\nYear: ${candidate.year}\nMake: ${candidate.make}\nModel: ${candidate.model}\nTrim: ${candidate.trim||"unknown"}\nLocation: ${candidate.location||"unknown"}\nAsking price: ${candidate.asking_price||"unknown"}\nMileage: ${candidate.mileage||"unknown"}\nSource/type: ${candidate.source_type||"unknown"}\nDiscovery URL hint: ${candidate.discovery_url||"none"}`}]}],
   text:{verbosity:"low",format:{type:"json_schema",name:"growthwise_verify_one_vehicle",strict:true,schema:{type:"object",additionalProperties:false,properties:{matched:{type:"boolean"},listing_url:{type:"string"},asking_price:{type:"number"},mileage:{type:"number"},location:{type:"string"},evidence_note:{type:"string"}},required:["matched","listing_url","asking_price","mileage","location","evidence_note"]}}}
  })});
  const data=await response.json().catch(()=>({}));if(!response.ok)return json(200,{ok:true,verified:false,message:"GrowthWise could not verify this lead right now. Treat it as research only."});
  const text=extractOutputText(data);let result=null;try{result=JSON.parse(text)}catch{}
  const sources=collectSourceUrls(data);const exact=result?.matched?directListingSourceMatch(result.listing_url,sources):"";
  if(!exact){
    const sourceMatched=result?.matched && !!exactSourceMatch(result.listing_url,sources);
    return json(200,{ok:true,verified:false,source_matched:sourceMatched,message:sourceMatched?"GrowthWise matched the lead details to a current search result, but not to a direct vehicle-detail page. Keep it flagged as a research lead until a direct listing is confirmed.":"No exact direct listing page could be verified. Keep this as a research lead only.",source_urls:sources.slice(0,10)});
  }
  return json(200,{ok:true,verified:true,listing_url:exact,asking_price:Math.round(Math.max(0,num(result.asking_price,candidate.asking_price))),mileage:Math.round(Math.max(0,num(result.mileage,candidate.mileage))),location:clean(result.location,160)||candidate.location,evidence_note:clean(result.evidence_note,600),source_urls:sources.slice(0,10)});
 }catch(err){if(err?.name==="AbortError")return json(200,{ok:true,verified:false,message:"Exact-listing verification reached the demo time limit. GrowthWise left the lead unverified rather than guessing."});return json(200,{ok:true,verified:false,message:"Exact-listing verification was unavailable. Keep this lead as research only."})}finally{clearTimeout(timer)}
};
