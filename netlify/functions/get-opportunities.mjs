const OPENAI_URL = "https://api.openai.com/v1/responses";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {"content-type":"application/json; charset=utf-8","cache-control":"no-store"},
  });
}
function clean(value, max=5000){return String(value??"").trim().slice(0,max)}
function num(value,fallback=0){const n=Number(value);return Number.isFinite(n)?n:fallback}
function extractOutputText(data){for(const item of data?.output||[]){if(item?.type!=="message")continue;for(const part of item?.content||[]){if(part?.type==="output_text"&&typeof part.text==="string")return part.text}}return ""}
function collectSourceUrls(data){const urls=[];for(const item of data?.output||[]){if(item?.type!=="web_search_call")continue;for(const source of item?.action?.sources||[]){if(source?.url&&!urls.includes(source.url))urls.push(source.url)}}return urls.slice(0,30)}
function normalizeUrl(url){const v=clean(url,1200);return /^https?:\/\//i.test(v)?v:""}

export default async (request)=>{
  if(request.method==="OPTIONS") return new Response(null,{status:204,headers:{"Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, X-GrowthWise-Key"}});
  if(request.method!=="POST") return json(405,{error:"Method not allowed"});

  const adminKey=Netlify.env.get("GROWTHWISE_ADMIN_KEY");
  const openaiKey=Netlify.env.get("OPENAI_API_KEY");
  if(!adminKey||!openaiKey) return json(500,{error:"Server AI configuration is incomplete."});
  if((request.headers.get("x-growthwise-key")||"")!==adminKey) return json(401,{error:"Invalid GrowthWise admin key."});

  let body; try{body=await request.json()}catch{return json(400,{error:"Invalid JSON body."})}
  const responseId=clean(body.response_id,200);
  if(!/^resp_[A-Za-z0-9_-]+$/.test(responseId)) return json(400,{error:"A valid Vehicle Scout response ID is required."});

  const response=await fetch(`${OPENAI_URL}/${encodeURIComponent(responseId)}`,{headers:{"Authorization":`Bearer ${openaiKey}`}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const msg=data?.error?.message||data?.error||`OpenAI retrieval failed (HTTP ${response.status}).`;return json(response.status,{error:String(msg)})}

  const status=clean(data.status,40)||"in_progress";
  if(status!=="completed"){
    if(["failed","cancelled","incomplete"].includes(status)){
      return json(200,{ok:false,done:true,status,error:data?.error?.message||`Vehicle Scout ended with status: ${status}.`});
    }
    return json(200,{ok:true,done:false,status,message:"Vehicle Scout is still researching current listings…"});
  }

  const text=extractOutputText(data);
  if(!text) return json(502,{error:"Vehicle Scout completed but returned no readable results."});
  let result; try{result=JSON.parse(text)}catch{return json(502,{error:"Vehicle Scout returned unreadable structured results."})}

  const md=data?.metadata||{};
  const maxPurchase=Math.max(0,num(md.max_purchase,12000));
  const targetGross=Math.max(0,num(md.target_gross,3500));
  const sourceUrls=collectSourceUrls(data);
  const opportunities=[];

  for(const raw of Array.isArray(result.opportunities)?result.opportunities:[]){
    const ask=Math.max(0,num(raw.asking_price));
    const retailLow=Math.max(0,num(raw.retail_low));
    const retailMid=Math.max(retailLow,num(raw.retail_mid));
    const retailHigh=Math.max(retailMid,num(raw.retail_high));
    const fees=Math.max(0,num(raw.estimated_fees));
    const transport=Math.max(0,num(raw.estimated_transport));
    const recon=Math.max(0,num(raw.estimated_recon));
    const labor=Math.max(0,num(raw.estimated_labor));
    const allIn=ask+fees+transport+recon+labor;
    const projectedGross=retailMid-allIn;
    const roi=allIn>0?(projectedGross/allIn)*100:0;
    const maxBuy=Math.max(0,retailMid-fees-transport-recon-labor-targetGross);
    let recommendation="WATCH";
    if(ask>0&&projectedGross>=targetGross&&roi>=15&&ask<=maxPurchase) recommendation="STRONG LEAD";
    else if(ask>maxPurchase||projectedGross<Math.max(1000,targetGross*.5)||roi<5) recommendation="PASS";

    opportunities.push({
      year:Math.round(num(raw.year)),make:clean(raw.make,80),model:clean(raw.model,100),trim:clean(raw.trim,100),source_type:clean(raw.source_type,80),
      listing_url:"",discovery_url:normalizeUrl(raw.listing_url),verified:false,verification_status:"UNVERIFIED LEAD",location:clean(raw.location,160),asking_price:Math.round(ask),mileage:Math.round(Math.max(0,num(raw.mileage))),
      retail_low:Math.round(retailLow),retail_mid:Math.round(retailMid),retail_high:Math.round(retailHigh),estimated_fees:Math.round(fees),estimated_transport:Math.round(transport),estimated_recon:Math.round(recon),estimated_labor:Math.round(labor),
      projected_all_in:Math.round(allIn),projected_gross:Math.round(projectedGross),projected_roi:Math.round(roi*10)/10,recommended_max_buy:Math.round(maxBuy),score:Math.max(0,Math.min(100,Math.round(num(raw.score)))),evidence_quality:clean(raw.evidence_quality,20)||"Low",recommendation,why_fit:clean(raw.why_fit,800),caveats:Array.isArray(raw.caveats)?raw.caveats.map(v=>clean(v,320)).filter(Boolean):[]
    });
  }

  opportunities.sort((a,b)=>b.score-a.score||b.projected_gross-a.projected_gross);
  return json(200,{
    ok:true,
    done:true,
    status:"completed",
    model:data.model||"",
    search_summary:clean(result.search_summary,1500),
    confidence:clean(result.confidence,20)||"Low",
    criteria:{retail_market:clean(md.retail_market,120),search_radius:num(md.search_radius),max_purchase:maxPurchase,target_gross:targetGross,min_year:num(md.min_year),max_year:num(md.max_year),max_mileage:num(md.max_mileage),vehicle_types:clean(md.vehicle_types,300),preferred_makes:clean(md.preferred_makes,400)},
    opportunities,
    source_urls:sourceUrls,
    caution:"Research leads are shown even when not yet verified. Use Verify exact listing before Auto City relies on a candidate for bidding, travel or purchase decisions."
  });
};
