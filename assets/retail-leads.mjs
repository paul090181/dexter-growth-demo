const BUSINESS_ID = "dexters-hats";
let products = [];
let selectedProduct = null;
let lastLead = null;
let leads = [];
let automationSettings = { mode: "shadow", pause_auto_replies: false };

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
const key = () => sessionStorage.getItem("growthwise_admin_key") || "";

function showStatus(kind, message){
  const box=$("#retailLeadStatus"); if(!box) return;
  box.className=`create-status ${kind}`; box.textContent=message;
}

function renderLeadUnlock(){
  const box=$("#retailLeadUnlock");
  if(!box) return;
  box.classList.toggle("hidden", Boolean(key()));
}

function showUnlockStatus(kind,message){
  const box=$("#retailLeadUnlockStatus");
  if(!box) return;
  box.className=`lead-inline-unlock-status ${kind}`;
  box.textContent=message;
}

async function unlockLeads(){
  const input=$("#retailLeadUnlockKey");
  const btn=$("#retailLeadUnlockBtn");
  const supplied=(input?.value||"").trim();
  if(!supplied){ input?.focus(); return; }

  if(btn){ btn.disabled=true; btn.textContent="Checking…"; }
  showUnlockStatus("loading","Checking GrowthWise and loading Square products…");

  try{
    const r=await fetch("/.netlify/functions/square-data",{
      method:"GET",
      headers:{"X-GrowthWise-Key":supplied},
      cache:"no-store"
    });
    const data=await r.json().catch(()=>({}));
    if(r.status===401) throw new Error("GrowthWise access key was not accepted.");
    if(!r.ok) throw new Error(data.error||`Could not load Square products (HTTP ${r.status}).`);

    sessionStorage.setItem("growthwise_admin_key",supplied);
    products=Array.isArray(data.products)?data.products:[];
    window.growthwiseInventoryProducts=products;
    window.dispatchEvent(new CustomEvent("growthwise:inventory-updated",{detail:{products,summary:data.summary||{},generated_at:data.generated_at||null}}));
    window.dispatchEvent(new Event("growthwise:admin-key-ready"));

    if(input) input.value="";
    renderLeadUnlock();
    renderProductSearch();
    await Promise.all([loadAutomationSettings(),loadLeads()]);
    showStatus("ok","✓ GrowthWise unlocked. Square products are ready and your example is still here.");
  }catch(e){
    showUnlockStatus("error",e.message||"GrowthWise could not unlock this Lead Assistant.");
  }finally{
    if(btn){ btn.disabled=false; btn.textContent="Unlock"; }
  }
}

function decisionLabel(decision){
  if(decision==="auto_reply") return "LOW-RISK REPLY";
  if(decision==="auto_reply_then_review") return "REPLY + DEXTER REVIEW";
  return "DEXTER REVIEW";
}

function renderAutomationMode(){
  document.querySelectorAll("[data-lead-mode]").forEach(btn=>{
    btn.classList.toggle("active", btn.dataset.leadMode === automationSettings.mode);
  });
  const badge=$("#retailLeadModeBadge");
  if(badge) badge.textContent = automationSettings.mode === "draft_only" ? "DRAFT ONLY" : "SHADOW MODE";
  const notice=$("#retailLeadAutomationNotice");
  if(notice) notice.textContent = automationSettings.mode === "draft_only"
    ? "Draft Only is active. GrowthWise writes replies, but does not score them for future automatic sending."
    : "No customer messages are being sent automatically. Shadow Mode is observation only.";
}

function renderAutomationStats(){
  const safe=leads.filter(l=>l.automation_class==="safe_auto").length;
  const ack=leads.filter(l=>l.automation_class==="safe_ack_then_review").length;
  const human=leads.filter(l=>l.automation_class==="human_only").length;
  if($("#retailLeadSafeCount")) $("#retailLeadSafeCount").textContent=String(safe);
  if($("#retailLeadAckCount")) $("#retailLeadAckCount").textContent=String(ack);
  if($("#retailLeadHumanCount")) $("#retailLeadHumanCount").textContent=String(human);
}

async function loadAutomationSettings(){
  const adminKey=key(); if(!adminKey) return;
  try{
    const r=await fetch(`/.netlify/functions/retail-lead-settings?business_id=${BUSINESS_ID}`,{headers:{"X-GrowthWise-Key":adminKey},cache:"no-store"});
    const data=await r.json().catch(()=>({}));
    if(r.ok && data.settings) automationSettings={...automationSettings,...data.settings};
  }catch{}
  renderAutomationMode();
}

async function saveAutomationMode(mode){
  const adminKey=key();
  if(!adminKey){showStatus("error","Unlock GrowthWise first.");return;}
  if(!["draft_only","shadow"].includes(mode)) return;
  try{
    const r=await fetch(`/.netlify/functions/retail-lead-settings?business_id=${BUSINESS_ID}`,{
      method:"PUT",
      headers:{"Content-Type":"application/json","X-GrowthWise-Key":adminKey},
      body:JSON.stringify({mode,pause_auto_replies:false})
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data.error||"Could not update Smart Auto mode.");
    automationSettings={...automationSettings,...data.settings};
    renderAutomationMode();
    showStatus("ok", mode==="shadow"
      ? "✓ Shadow Mode is active. GrowthWise will record what it would automate, but nothing will send automatically."
      : "✓ Draft Only is active. Dexter reviews and sends every reply.");
  }catch(e){showStatus("error",e.message||"Could not update Smart Auto mode.");}
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
  const automationBox=$("#retailLeadAutomationDecision");
  if(automationBox){
    const cls=data.automation_class==="safe_auto"?"safe":data.automation_class==="safe_ack_then_review"?"review":"human";
    const label=data.automation_class==="safe_auto"
      ? "SHADOW RESULT · WOULD AUTO-REPLY"
      : data.automation_class==="safe_ack_then_review"
        ? "SHADOW RESULT · WOULD ACKNOWLEDGE, THEN ALERT DEXTER"
        : "SHADOW RESULT · WOULD WAIT FOR DEXTER";
    automationBox.className=`lead-automation-decision ${cls}`;
    automationBox.textContent = automationSettings.mode==="draft_only"
      ? "Draft Only · no automation decision is being used for sending."
      : `${label} — ${data.automation_reason||"GrowthWise scored this conversation for the Smart Auto pilot."}`;
  }
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
      automation_mode:automationSettings.mode,
      business:{name:"Dexter's Hats & Caps"}
    })});
    const data=await r.json().catch(()=>({})); if(!r.ok) throw new Error(data.error||`Lead assistant failed (HTTP ${r.status}).`);
    renderLeadResult(data);
    const shadowText = automationSettings.mode==="shadow"
      ? data.automation_class==="safe_auto"
        ? "✓ Shadow Mode: GrowthWise would have auto-replied. Dexter still sends this one manually."
        : data.automation_class==="safe_ack_then_review"
          ? "✓ Shadow Mode: GrowthWise would send the acknowledgement, then alert Dexter for the decision."
          : "✓ Shadow Mode: GrowthWise would wait for Dexter."
      : data.decision==="auto_reply"
        ? "✓ Safe draft ready. Dexter reviews before sending."
        : "✓ Draft ready. GrowthWise flagged the part Dexter needs to decide or verify.";
    showStatus(data.decision==="review_required"?"error":"ok", shadowText);
    await loadLeads();
  }catch(e){showStatus("error",e.message||"GrowthWise could not draft the reply.");}
  finally{btn.disabled=false;btn.textContent="Draft Customer Reply";}
}

async function loadLeads(){
  const adminKey=key(); if(!adminKey) return;
  try{
    const r=await fetch(`/.netlify/functions/retail-lead-assistant?business_id=${BUSINESS_ID}`,{headers:{"X-GrowthWise-Key":adminKey},cache:"no-store"});
    const data=await r.json().catch(()=>({})); if(!r.ok) return;
    leads=Array.isArray(data.leads)?data.leads:[]; renderLeads(); renderAutomationStats();
  }catch{}
}

function renderLeads(){
  const root=$("#retailLeadList"); if(!root) return;
  if(!leads.length){root.innerHTML='<div class="inventory-empty">Customer questions handled through GrowthWise will appear here.</div>';return;}
  root.innerHTML=leads.slice(0,12).map(l=>{
    const auto=l.automation_class==="safe_auto"?"SAFE AUTO":l.automation_class==="safe_ack_then_review"?"ACK + REVIEW":l.automation_class==="human_only"?"HUMAN ONLY":"";
    return `<div class="retail-lead-card"><div class="retail-lead-card-top"><strong>${esc(l.customer_name||l.source||"Customer")}</strong><span>${esc(l.status||"new")}</span></div><small>${esc(l.product_name||l.source||"")}${auto?" · "+esc(auto):""}</small><p>${esc((l.message||"").slice(0,180))}</p><div class="retail-lead-card-actions">${l.status!=="replied"?`<button data-lead-status="replied" data-lead-id="${l.id}">Mark Replied</button>`:""}${l.status!=="closed"?`<button data-lead-status="closed" data-lead-id="${l.id}">Close</button>`:""}</div></div>`;
  }).join("");
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
  renderLeadUnlock();
  $("#retailLeadProductSearch")?.addEventListener("input",renderProductSearch);
  $("#retailLeadUnlockBtn")?.addEventListener("click",unlockLeads);
  $("#retailLeadUnlockKey")?.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();unlockLeads();}});
  $("#retailLeadRunBtn")?.addEventListener("click",runLead);
  $("#retailLeadSampleBtn")?.addEventListener("click",loadSample);
  $("#retailLeadCopyBtn")?.addEventListener("click",copyReply);
  $("#retailLeadShareBtn")?.addEventListener("click",shareReply);
  document.querySelectorAll("[data-lead-mode]").forEach(btn=>btn.addEventListener("click",()=>saveAutomationMode(btn.dataset.leadMode)));
  window.addEventListener("growthwise:inventory-updated",e=>{products=Array.isArray(e.detail?.products)?e.detail.products:[];renderProductSearch();});
  window.addEventListener("growthwise:admin-key-ready",()=>{renderLeadUnlock();loadAutomationSettings();loadLeads();});
  document.querySelectorAll('[data-nav="leads"]').forEach(btn=>btn.addEventListener("click",()=>{products=Array.isArray(window.growthwiseInventoryProducts)?window.growthwiseInventoryProducts:products;renderLeadUnlock();renderProductSearch();loadAutomationSettings();loadLeads();}));
  renderProductSearch(); renderLeads(); renderAutomationMode(); renderAutomationStats(); if(key()){loadAutomationSettings();loadLeads();}
}
