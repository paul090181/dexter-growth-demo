const OPENAI_URL = "https://api.openai.com/v1/responses";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {"content-type":"application/json; charset=utf-8","cache-control":"no-store"},
  });
}
function clean(value, max=5000){return String(value??"").trim().slice(0,max)}
function num(value,fallback=0){const n=Number(value);return Number.isFinite(n)?n:fallback}

export default async (request)=>{
  if(request.method==="OPTIONS") return new Response(null,{status:204,headers:{"Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, X-GrowthWise-Key"}});
  if(request.method!=="POST") return json(405,{error:"Method not allowed"});

  const adminKey=Netlify.env.get("GROWTHWISE_ADMIN_KEY");
  const openaiKey=Netlify.env.get("OPENAI_API_KEY");
  const model=Netlify.env.get("OPENAI_AUTOMOTIVE_MODEL")||Netlify.env.get("OPENAI_PRODUCT_MODEL")||"gpt-5.6-luna";
  if(!adminKey||!openaiKey) return json(500,{error:"Server AI configuration is incomplete."});
  if((request.headers.get("x-growthwise-key")||"")!==adminKey) return json(401,{error:"Invalid GrowthWise admin key."});

  let body; try{body=await request.json()}catch{return json(400,{error:"Invalid JSON body."})}
  const retailMarket=clean(body.retail_market,120)||"Buffalo, NY";
  const searchRadius=Math.min(500,Math.max(10,num(body.search_radius,150)));
  const maxPurchase=Math.max(1000,num(body.max_purchase,12000));
  const targetGross=Math.max(500,num(body.target_gross,3500));
  const minYear=Math.max(1990,Math.min(2030,num(body.min_year,2012)));
  const maxYear=Math.max(minYear,Math.min(2030,num(body.max_year,2024)));
  const maxMileage=Math.max(10000,num(body.max_mileage,140000));
  const vehicleTypes=clean(body.vehicle_types,300)||"Any body style";
  const preferredMakes=clean(body.preferred_makes,400)||"Any mainstream make";
  const excludedMakes=clean(body.excluded_makes,400);
  const notes=clean(body.notes,1400);
  const maxResults=Math.min(5,Math.max(1,Math.round(num(body.max_results,5))));

  const criteria=[
    `Retail market: ${retailMarket}`,
    `Search radius: about ${Math.round(searchRadius)} miles`,
    `Maximum acquisition price: $${Math.round(maxPurchase)}`,
    `Target gross profit per vehicle: $${Math.round(targetGross)}`,
    `Model years: ${Math.round(minYear)}-${Math.round(maxYear)}`,
    `Maximum mileage: ${Math.round(maxMileage)}`,
    `Preferred vehicle types: ${vehicleTypes}`,
    `Preferred makes: ${preferredMakes}`,
    excludedMakes&&`Exclude makes: ${excludedMakes}`,
    notes&&`Dealer preferences / notes: ${notes}`,
  ].filter(Boolean).join("\n");

  const payload={
    model,
    background:true,
    store:true,
    include:["web_search_call.action.sources"],
    reasoning:{effort:"none"},
    tools:[{type:"web_search",search_context_size:"medium",user_location:{type:"approximate",city:retailMarket,country:"US"}}],
    metadata:{
      gw_kind:"vehicle_scout",
      retail_market:retailMarket.slice(0,120),
      search_radius:String(Math.round(searchRadius)),
      max_purchase:String(Math.round(maxPurchase)),
      target_gross:String(Math.round(targetGross)),
      min_year:String(Math.round(minYear)),
      max_year:String(Math.round(maxYear)),
      max_mileage:String(Math.round(maxMileage)),
      vehicle_types:vehicleTypes.slice(0,300),
      preferred_makes:preferredMakes.slice(0,400)
    },
    instructions:
      "You are GrowthWise Vehicle Scout for a small independent dealership with an in-house repair shop. Search CURRENT public vehicle listings and surface plausible acquisition RESEARCH LEADS. Do not invent vehicles, prices, mileage, locations, VINs, title status, condition, accident history, repair needs or completed-sale prices. Use current public listing evidence only. Return useful leads even when the exact listing page cannot yet be verified; a separate verification step handles that. Clearly lower evidence quality when details are incomplete. Return only the requested structured data.",
    input:[{role:"user",content:[{type:"input_text",text:`Find up to ${maxResults} current vehicle research leads matching these criteria:\n\n${criteria}\n\nFor each lead, use visible public asking price and mileage when available. Estimate local retail conservatively, estimate fees/transport/recon/internal labor as allowances, and score 0-100 for likely fit. listing_url may be a candidate/detail URL if exposed by search, but exact verification happens separately.`}]}],
    text:{verbosity:"low",format:{type:"json_schema",name:"growthwise_vehicle_scout_background",strict:true,schema:{type:"object",additionalProperties:false,properties:{search_summary:{type:"string"},confidence:{type:"string",enum:["Low","Medium","High"]},opportunities:{type:"array",maxItems:5,items:{type:"object",additionalProperties:false,properties:{year:{type:"number"},make:{type:"string"},model:{type:"string"},trim:{type:"string"},source_type:{type:"string"},listing_url:{type:"string"},location:{type:"string"},asking_price:{type:"number"},mileage:{type:"number"},retail_low:{type:"number"},retail_mid:{type:"number"},retail_high:{type:"number"},estimated_fees:{type:"number"},estimated_transport:{type:"number"},estimated_recon:{type:"number"},estimated_labor:{type:"number"},score:{type:"number"},evidence_quality:{type:"string",enum:["Low","Medium","High"]},why_fit:{type:"string"},caveats:{type:"array",items:{type:"string"}}},required:["year","make","model","trim","source_type","listing_url","location","asking_price","mileage","retail_low","retail_mid","retail_high","estimated_fees","estimated_transport","estimated_recon","estimated_labor","score","evidence_quality","why_fit","caveats"]}}},required:["search_summary","confidence","opportunities"]}}}
  };

  const response=await fetch(OPENAI_URL,{method:"POST",headers:{"Authorization":`Bearer ${openaiKey}`,"Content-Type":"application/json"},body:JSON.stringify(payload)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const msg=data?.error?.message||data?.error||`OpenAI request failed (HTTP ${response.status}).`;return json(response.status,{error:String(msg)})}
  if(!data?.id) return json(502,{error:"Vehicle Scout could not start the background search."});

  return json(202,{
    ok:true,
    started:true,
    response_id:data.id,
    status:data.status||"queued",
    message:"Vehicle Scout is researching current listings in the background. GrowthWise will keep checking until the results are ready."
  });
};
