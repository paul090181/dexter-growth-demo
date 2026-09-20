const BUSINESS_ID = "dexters-hats";
let products = [];
let selectedProduct = null;
let lastLead = null;
let leads = [];

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
const key = () => sessionStorage.getItem("growthwise_admin_key") || "";

function showStatus(kind, message){
  const box=$("#retailLeadStatus"); if(!box) return;
  box.className=`create-status ${kind}`; box.textContent=message;
}

function decisionLabel(decision){
  if(decision==="auto_reply") return "LOW-RISK REPLY";
  if(decision==="auto_reply_then_review") return "REPLY + DEXTER REVIEW";
  return "DEXTER REVIEW";
}

function renderProductSearch(){
  const root=$("#retailLeadProductResults"); if(!root) return;
  const q=($("#retailLeadProductSearch")?.value||"").trim().toLowerCase();
  if(!products.length){root.innerHTML='<div class="inventory-empty">Unlock GrowthWise to load Square products, or draft a reply without selecting a product.</div>';return;}
  const found=products.filter(p=>!q||[p.item_name,p.variation_name,p.sku,p.upc,p.description].filter(Boolean).join(" ").toLowerCase().includes(q)).slice(0,8);
  root.innerHTML=found.length?found.map(p=>`<button type="button" class="lead-product-result" data-lead-product="${esc(p.variation_id||p.item_id||p.item_name)}"><strong>${esc(p.item_name||"Product")}</strong><small>${p.price?"$"+esc(p.price):"No price"} · ${Number(p.quantity||0)} in stock${p.variation_name&&p.variation_name!=="Default"?" · "+esc(p.variation_name):""}</small></button>`).join(""):'<div class="inventory-empty">No matching Square products.</div>';
  root.querySelectorAll("[data-lead-product]").forEach(btn=>btn.onclick=()=>{
    const id=btn.dataset.leadProduct;
    selectedProduct=products.find(p=>String(p.variation_id||p.item_id||p.item_name)===id)||null;
    renderSelectedProduct();
  });
}

function renderSelectedProduct(){
  const box=$("#retailLeadSelectedProduct"); if(!box) return;
  if(!selectedProduct){box.classList.add("hidden");box.innerHTML="";return;}
  box.innerHTML=`<strong>✓ ${esc(selectedProduct.item_name||"Selected product")}</strong><small>${selectedProduct.price?"$"+esc(selectedProduct.price):"No price"} · ${Number(selectedProduct.quantity||0)} in stock${selectedProduct.variation_name&&selectedProduct.variation_name!=="Default"?" · "+esc(selectedProduct.variation_name):""}</small><button type="button" id="clearRetailLeadProduct">Remove product</button>`;
  box.classList.remove("hidden");
  $("#clearRetailLeadProduct").onclick=()=>{selectedProduct=null;renderSelectedProduct();};
}

function renderLeadResult(data){
  lastLead=data;
  const box=$("#retailLeadResult"); box.classList.remove("hidden");
  const badge=$("#retailLeadDecision"); badge.textContent=decisionLabel(data.decision); badge.className=`lead-decision ${data.decision==="auto_reply"?"safe":data.decision==="auto_reply_then_review"?"review":"human"}`;
  $("#retailLeadIntent").textContent=`Intent: ${(data.intent||"other").replaceAll("_"," ")} · Risk: ${data.risk_level||"—"}`;
  $("#retailLeadReason").textContent=data.reason||"GrowthWise evaluated the message against known product facts and store guardrails.";
  $("#retailLeadReply").value=data.reply||"";
  $("#retailLeadNext").innerHTML=`<strong>Next:</strong> ${esc(data.follow_up_action||"Dexter reviews before sending.")}`;
}

async function runLead(){
  const adminKey=key();
  if(!adminKey){showStatus("error","Unlock GrowthWise first.");return;}
  const message=($("#retailLeadMessage")?.value||"").trim();
  if(!message){showStatus("error","Paste or type the customer's message first.");return;}
  const btn=$("#retailLeadRunBtn");btn.disabled=true;btn.textContent="GrowthWise is drafting…";showStatus("loading","Checking the question against known product facts and retail guardrails…");
  try{
    const r=await fetch(`/.netlify/functions/retail-lead-assistant?business_id=${BUSINESS_ID}`,{method:"POST",headers:{"Content-Type":"application/json","X-GrowthWise-Key":adminKey},body:JSON.stringify({
      source:$("#retailLeadSource").value,
      customer_name:$("#retailLeadCustomer").value.trim(),
      customer_contact:$("#retailLeadContact").value.trim(),
      message,
      history:$("#retailLeadHistory").value.trim(),
      product:selectedProduct,
      business:{name:"Dexter's Hats & Caps"}
    })});
    const data=await r.json().catch(()=>({})); if(!r.ok) throw new Error(data.error||`Lead assistant failed (HTTP ${r.status}).`);
    renderLeadResult(data);
    showStatus(data.decision==="review_required"?"error":"ok", data.decision==="auto_reply"?"✓ Safe draft ready. Dexter still reviews before sending during the pilot.":"✓ Draft ready. GrowthWise flagged the part Dexter needs to decide or verify.");
    await loadLeads();
  }catch(e){showStatus("error",e.message||"GrowthWise could not draft the reply.");}
  finally{btn.disabled=false;btn.textContent="Draft Customer Reply";}
}

async function loadLeads(){
  const adminKey=key(); if(!adminKey) return;
  try{
    const r=await fetch(`/.netlify/functions/retail-lead-assistant?business_id=${BUSINESS_ID}`,{headers:{"X-GrowthWise-Key":adminKey},cache:"no-store"});
    const data=await r.json().catch(()=>({})); if(!r.ok) return;
    leads=Array.isArray(data.leads)?data.leads:[]; renderLeads();
  }catch{}
}

function renderLeads(){
  const root=$("#retailLeadList"); if(!root) return;
  if(!leads.length){root.innerHTML='<div class="inventory-empty">Customer questions handled through GrowthWise will appear here.</div>';return;}
  root.innerHTML=leads.slice(0,12).map(l=>`<div class="retail-lead-card"><div class="retail-lead-card-top"><strong>${esc(l.customer_name||l.source||"Customer")}</strong><span>${esc(l.status||"new")}</span></div><small>${esc(l.product_name||l.source||"")}</small><p>${esc((l.message||"").slice(0,180))}</p><div class="retail-lead-card-actions">${l.status!=="replied"?`<button data-lead-status="replied" data-lead-id="${l.id}">Mark Replied</button>`:""}${l.status!=="closed"?`<button data-lead-status="closed" data-lead-id="${l.id}">Close</button>`:""}</div></div>`).join("");
  root.querySelectorAll("[data-lead-status]").forEach(btn=>btn.onclick=()=>updateLead(btn.dataset.leadId,btn.dataset.leadStatus));
}

async function updateLead(id,status){
  try{
    const r=await fetch(`/.netlify/functions/retail-lead-assistant?business_id=${BUSINESS_ID}`,{method:"PATCH",headers:{"Content-Type":"application/json","X-GrowthWise-Key":key()},body:JSON.stringify({id,status})});
    if(r.ok) await loadLeads();
  }catch{}
}

async function copyReply(){
  const value=$("#retailLeadReply").value.trim(); if(!value) return;
  try{await navigator.clipboard.writeText(value);showStatus("ok","✓ Reply copied. Paste it into the customer's message thread.");}catch{showStatus("error","Could not copy the reply from this browser.");}
}

async function shareReply(){
  const value=$("#retailLeadReply").value.trim(); if(!value) return;
  try{
    if(navigator.share) await navigator.share({title:"Dexter customer reply",text:value});
    else await copyReply();
  }catch(e){if(e?.name!=="AbortError") showStatus("error","Could not open the share sheet.");}
}

function loadSample(){
  $("#retailLeadSource").value="Instagram DM";
  $("#retailLeadCustomer").value="Maria";
  $("#retailLeadMessage").value="Hi, do you still have this hat in stock and how much is it? Could you hold it for me until tomorrow?";
  showStatus("loading","Sample loaded. Choose a Square product if you want GrowthWise to use verified price and stock, then draft the reply.");
}

export function mountRetailLeads(){
  products=Array.isArray(window.growthwiseInventoryProducts)?window.growthwiseInventoryProducts:[];
  $("#retailLeadProductSearch")?.addEventListener("input",renderProductSearch);
  $("#retailLeadRunBtn")?.addEventListener("click",runLead);
  $("#retailLeadSampleBtn")?.addEventListener("click",loadSample);
  $("#retailLeadCopyBtn")?.addEventListener("click",copyReply);
  $("#retailLeadShareBtn")?.addEventListener("click",shareReply);
  window.addEventListener("growthwise:inventory-updated",e=>{products=Array.isArray(e.detail?.products)?e.detail.products:[];renderProductSearch();});
  window.addEventListener("growthwise:admin-key-ready",()=>loadLeads());
  document.querySelectorAll('[data-nav="leads"]').forEach(btn=>btn.addEventListener("click",()=>{products=Array.isArray(window.growthwiseInventoryProducts)?window.growthwiseInventoryProducts:products;renderProductSearch();loadLeads();}));
  renderProductSearch(); renderLeads(); if(key()) loadLeads();
}
