import test from "node:test";
import assert from "node:assert/strict";

const SOURCE = "../../netlify/functions/instagram-photo-draft.mjs";

function req(body,key="admin"){
  return new Request("https://example.test/.netlify/functions/instagram-photo-draft",{
    method:"POST",
    headers:{"content-type":"application/json","x-growthwise-key":key},
    body:JSON.stringify(body)
  });
}

test("Instagram photo draft requires auth and a photo", async()=>{
  globalThis.Netlify={env:{get:(name)=>({
    GROWTHWISE_ADMIN_KEY:"admin",
    OPENAI_API_KEY:"key",
    OPENAI_MARKETING_MODEL:"test-model"
  }[name]||"")}};
  const {default:handler}=await import(SOURCE+"?auth="+Date.now());
  assert.equal((await handler(req({image_data_url:"data:image/jpeg;base64,AA"},"wrong"))).status,401);
  assert.equal((await handler(req({image_data_url:""}))).status,400);
});

test("Instagram photo draft returns grounded caption structure", async()=>{
  globalThis.Netlify={env:{get:(name)=>({
    GROWTHWISE_ADMIN_KEY:"admin",
    OPENAI_API_KEY:"key",
    OPENAI_MARKETING_MODEL:"test-model"
  }[name]||"")}};
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({
    output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({
      product_label:"Classic fedora",
      caption:"A sharp classic fedora from Dexter's Hats & Caps. #DextersHats #BuffaloStyle",
      visible_features:["dark band","structured crown"],
      uncertainty_note:"Brand not visible."
    })}]}]
  }),{status:200,headers:{"content-type":"application/json"}});

  try{
    const {default:handler}=await import(SOURCE+"?ok="+Date.now());
    const response=await handler(req({image_data_url:"data:image/jpeg;base64,AA"}));
    const body=await response.json();
    assert.equal(response.status,200);
    assert.equal(body.product_label,"Classic fedora");
    assert.match(body.caption,/Dexter/);
    assert.equal(body.uncertainty_note,"Brand not visible.");
  }finally{
    globalThis.fetch=oldFetch;
  }
});
