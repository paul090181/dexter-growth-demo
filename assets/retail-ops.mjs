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
  orders.filter(o=>o.status==="received").forEach(o=>{const v=vendors.get(o.vendor_name)||{total:0,count:0};v.total+=Number(o.total||0);v.count++;vendors.set(o.ve