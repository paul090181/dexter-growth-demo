const BUSINESS_ID = "dexters-hats";
let products = [];
let sales = null;
let orders = [];
let summary = {};
let draft = [];

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
const key = () => sessionStorage.getItem("growthwise_admin_key") || "";
const money = (v) => "$" + (Number(v || 0) || 0).toFixed(2);

function tell(title, message){
  if(typeof window.openGrowthWiseModal === "function") window.openGrowthWiseModal(title, message);
  else window.alert(message);
}

function incoming(variationId){
  return orders.filter(o=>!["received","cancelled"].includes(o.status))
    .flatMap(o=>o.lines||[]).filter(l=>l.square_variation_id===variationId)
    .reduce((n,l)=>n+Math.max(0,Number(l.quantity_ordered||0)-Number(l.quantity_received||0)),0);
}

function renderRestock(){
  const root=$("#reorderSuggestions"); if(!root) return;
  if(!products.length){ root.innerHTML='<div class="inventory-empty">Unlock GrowthWise to analyze inventory and recent sales.</div>'; return; }
  const sold=new Map((sales?.top_products||[]).map(p=>[p.catalog_object_id,Number(p.quantity_sold||0)]));
  const picks=products.map(product=>{
    const sold30=sold.get(product.variation_id)||0, current=Number(product.quantity||0), onOrder=incoming(product.variation_id);
    const target=sold30>0?Math.max(2,Math.ceil(sold30)):0;
    return {product,sold30,current,onOrder,qty:target?Math.max(0,target-current-onOrder):0};
  }).filter(x=>x.qty>0).sort((a,b)=>b.qty-a.qty).slice(0,5);
  if(!picks.length){
    const low=products.filter(p=>Number(p.quantity||0)<=2).length;
    root.innerHTML=low && !(sales?.top_products||[]).length
      ? `<div class="inventory-empty">GrowthWise sees ${low} low-stock item${low===1?"":"s"}, but there is not enough recent sales history to recommend reorder quantities yet. You can still create a purchase order manually.</div>`
      : '<div class="inventory-empty">No reorder recommendation is supported by the current inventory and 30-day sales data.</div>';
    return;
  }
  root.innerHTML=picks.map((x,i)=>`<div class="reorder-suggestion"><strong>${esc(x.product.item_name)}</strong><small>${x.sold30} sold in 30 days · ${x.current} in stock · ${x.onOrder} already on order.</small><button type="button" data-restock="${i}">Start order for ${x.qty}</button></div>`).join("");
  root.querySelectorAll("[data-restock]").forEach(b=>b.onclick=()=>startWith(picks[Number(b.dataset.restock)].product,picks[Number(b.dataset.restock)].qty));
}

function renderMoney(){
  if(!$("#moneySales30")) return;
  const sales30=Number(sales?.summary?.total_collected||0);
  const retail=products.reduce((n,p)=>n+(Number(p.price_cents)||0)*(Number(p.quantity)||0),0)/100;
  const received=orders.filter(o=>o.status==="received").reduce((n,o)=>n+Number(o.total||0),0);
  $("#moneySales30").textContent=money(sales30);
  $("#moneyInventoryRetail").textContent=money(retail);
  $("#moneyOpenOrders").textContent=money(summary.open_commitment||0);
  $("#moneyReceivedPurchases").textContent=money(received);
  const costIds=new Set(orders.flatMap(o=>o.lines||[]).filter(l=>l.square_variation_id&&Number(l.unit_cost_cents)>=0).map(l=>l.square_variation_id));
  const ids=new Set(products.map(p=>p.variation_id).filter(Boolean));
  const covered=[...ids].filter(id=>costIds.has(id)).length, pct=ids.size?Math.round(covered/ids.size*100):0;
  $("#moneyCostCoverage").textContent=ids.size?`${pct}% of current product variations have a known purchase cost`:"Wholesale costs are starting to build.";
  $("#moneyCostCoverageDetail").textContent=ids.size?`GrowthWise has cost history for ${covered} of ${ids.size} current Square variations. Each vendor order improves future margin and reorder analysis.`:"Every purchase order you enter gives GrowthWise better cost and margin information.";
  const vendors=new Map();
  orders.filter(o=>o.status==="received").forEach(o=>{const v=vendors.get(o.vendor_name)||{total:0,count:0};v.total+=Number(o.total||0);v.count++;vendors.set(o.vendor_name,v);});
  const rows=[...vendors.entries()].sort((a,b)=>b[1].total-a[1].total);
  $("#vendorSpendList").innerHTML=rows.length?rows.map(([name,v])=>`<div class="vendor-spend-row"><span>${esc(name)} · ${v.count} received order${v.count===1?"":"s"}</span><strong>${money(v.total)}</strong></div>`).join(""):'<div class="inventory-empty">Received purchase orders will appear here.</div>';
}

function renderOrders(){
  $("#ordersOpenCount").textContent=Number(summary.open_order_count||0);
  $("#ordersCommitment").textContent=money(summary.open_commitment||0);
  $("#ordersAwaitingCount").textContent=Number(summary.awaiting_receipt_count||0);
  const root=$("#purchaseOrderList");
  if(!orders.length){root.innerHTML='<div class="inventory-empty">No GrowthWise purchase orders yet.</div>';renderRestock();renderMoney();return;}
  root.innerHTML=orders.map(o=>{
    const lines=(o.lines||[]).map(l=>`${esc(l.item_name)} × ${Number(l.quantity_ordered||0)}${Number(l.quantity_received||0)?` · ${Number(l.quantity_received)} received`:""}`).join("<br>");
    let actions="";
    if(o.status==="draft") actions+=`<button class="primary-action" data-status="ordered" data-id="${o.id}">Mark Sent / Ordered</button>`;
    if(o.status==="ordered") actions+=`<button data-status="confirmed" data-id="${o.id}">Vendor Confirmed</button>`;
    if(["ordered","confirmed"].includes(o.status)) actions+=`<button data-status="shipped" data-id="${o.id}">Mark Shipped</button>`;
    if(["ordered","confirmed","shipped"].includes(o.status)) actions+=`<button class="primary-action" data-receive="${o.id}">Receive into Square</button>`;
    return `<div class="po-card"><div class="po-card-top"><div><div class="tag">${esc(o.po_number)}</div><h3>${esc(o.vendor_name)}</h3></div><span class="po-status ${esc(o.status)}">${esc(o.status)}</span></div><div class="po-card-meta">Total: <strong>${money(o.total)}</strong> · Expected: ${o.expected_at?new Date(o.expected_at).toLocaleDateString():"Not set"}<br>${o.tracking_number?`${esc(o.carrier||"Carrier")} · ${esc(o.tracking_number)}`:"No tracking yet"}</div><div class="po-line-summary">${lines}</div>${actions?`<div class="po-actions">${actions}</div>`:""}</div>`;
  }).join("");
  root.querySelectorAll("[data-status]").forEach(b=>b.onclick=()=>advance(b.dataset.id,b.dataset.status));
  root.querySelectorAll("[data-receive]").forEach(b=>b.onclick=()=>receive(b.dataset.receive));
  renderRestock(); renderMoney();
}

async function loadOrders(adminKey=key()){
  if(!adminKey) return false;
  try{
    const r=await fetch(`/.netlify/functions/retail-orders?business_id=${encodeURIComponent(BUSINESS_ID)}`,{headers:{"X-GrowthWise-Key":adminKey},cache:"no-store"});
    const data=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data.error||`Purchase order request failed (HTTP ${r.status}).`);
    orders=Array.isArray(data.orders)?data.orders:[]; summary=data.summary||{}; renderOrders(); return true;
  }catch(e){ console.error("retail_orders_load_failed",e); if($("#purchaseOrderList")) $("#purchaseOrderList").innerHTML=`<div class="inventory-empty">${esc(e.message||"Purchase orders could not be loaded.")}</div>`; return false; }
}

function showComposer(show=true){const box=$("#purchaseOrderComposer");box.classList.toggle("hidden",!show);if(show){renderSearch();box.scrollIntoView({behavior:"smooth",block:"start"});}}
function startWith(product,qty=1){document.querySelector('[data-nav="orders"]')?.click();showComposer(true);addLine(product,qty);}
function renderSearch(){
  const root=$("#poProductSearchResults"); if(!root) return;
  const q=($("#poProductSearch").value||"").trim().toLowerCase();
  const found=products.filter(p=>!q||[p.item_name,p.variation_name,p.sku,p.upc].filter(Boolean).join(" ").toLowerCase().includes(q)).slice(0,10);
  root.innerHTML=found.length?found.map(p=>`<button type="button" class="po-search-item" data-product="${esc(p.variation_id)}"><strong>${esc(p.item_name)}</strong><small>${p.price?"$"+esc(p.price):"No retail price"} · ${Number(p.quantity||0)} in stock${p.variation_name&&p.variation_name!=="Default"?" · "+esc(p