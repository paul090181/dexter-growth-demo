const BUSINESS_ID="dexters-hats";
const $=(id)=>document.getElementById(id);
const sessionStatus=$("sessionStatus");
const app=$("pilotApp");
const photoInput=$("photoInput");
const photoPreview=$("photoPreview");
const draftButton=$("draftButton");
const draftStatus=$("draftStatus");
const draftCard=$("draftCard");
const productLabel=$("productLabel");
const caption=$("caption");
const uncertainty=$("uncertainty");
const reviewed=$("reviewed");
const publishButton=$("publishButton");
const publishStatus=$("publishStatus");
const feedbackCard=$("feedbackCard");
const feedbackNote=$("feedbackNote");
const feedbackButton=$("feedbackButton");
const feedbackStatus=$("feedbackStatus");
const anotherButton=$("anotherButton");
const igStatus=$("igStatus");
const igDot=$("igDot");
const igConnectButton=$("igConnectButton");
let imageDataUrl="",feedbackResult="";

function show(el,text,kind=""){
  el.textContent=text;
  el.className=("status "+kind).trim();
  el.classList.remove("hidden");
}

async function track(name){
  try{
    await fetch("/.netlify/functions/dexter-pilot-event",{
      method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({event_name:name})
    });
  }catch{}
}

function consumeInvite(){
  const url=new URL(location.href);
  const params=new URLSearchParams(url.hash.slice(1));
  const values=params.getAll("invite");
  const token=params.size===1&&values.length===1?values[0]:"";
  if(url.hash){
    url.hash="";
    history.replaceState(null,"",url.pathname+url.search);
  }
  return token;
}

function consumeInstagramHint(){
  const url=new URL(location.href);
  const hint=url.searchParams.get("instagram");
  if(hint){
    url.searchParams.delete("instagram");
    const query=url.searchParams.toString();
    history.replaceState(null,"",url.pathname+(query?"?"+query:""));
  }
  return hint;
}

async function exchangeInvite(token){
  if(!token)return false;
  const response=await fetch("/.netlify/functions/dexter-pilot-invitation-exchange",{
    method:"POST",credentials:"same-origin",cache:"no-store",
    headers:{"Content-Type":"application/json","Origin":location.origin},
    body:JSON.stringify({invitation_token:token})
  });
  return response.ok;
}

async function hasPilotSession(){
  const response=await fetch("/.netlify/functions/dexter-pilot-session",{
    credentials:"same-origin",cache:"no-store"
  });
  if(!response.ok)return false;
  const body=await response.json().catch(()=>({}));
  return body.business_id===BUSINESS_ID;
}

async function checkInstagram(){
  try{
    const response=await fetch("/.netlify/functions/dexter-instagram-connection",{
      credentials:"same-origin",cache:"no-store"
    });
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error();
    const connected=body.state==="Connected";
    igDot.classList.toggle("ok",connected);
    igConnectButton.classList.toggle("hidden",connected);
    igConnectButton.textContent=body.state==="Not Connected"?"Connect Instagram":"Reconnect Instagram";
    igStatus.textContent=connected
      ? (body.account?.username?"Connected to @"+body.account.username:"Instagram connected")
      : (body.action||"Instagram needs your attention before posting.");
  }catch{
    igDot.classList.remove("ok");
    igConnectButton.classList.remove("hidden");
    igConnectButton.textContent="Reconnect Instagram";
    igStatus.textContent="Instagram connection could not be verified right now.";
  }
}

igConnectButton?.addEventListener("click",async()=>{
  igConnectButton.disabled=true;
  try{
    const response=await fetch("/.netlify/functions/dexter-instagram-oauth-start",{
      method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({business_id:BUSINESS_ID})
    });
    const body=await response.json().catch(()=>({}));
    if(!response.ok||typeof body.authorization_url!=="string"){
      throw new Error(body.error||"Instagram connection could not be started.");
    }
    const target=new URL(body.authorization_url);
    if(target.protocol!=="https:"||target.hostname!=="www.instagram.com"){
      throw new Error("Instagram connection response was rejected.");
    }
    location.assign(target.toString());
  }catch(error){
    igStatus.textContent=error.message||"Instagram connection could not be started.";
    igConnectButton.disabled=false;
  }
});

photoInput?.addEventListener("change",()=>{
  const file=photoInput.files?.[0];
  if(!file)return;
  if(!["image/jpeg","image/png"].includes(file.type)||file.size>7*1024*1024){
    show(draftStatus,"Choose a JPG or PNG photo under 7 MB.","error");
    return;
  }
  const reader=new FileReader();
  reader.onload=()=>{
    imageDataUrl=String(reader.result||"");
    photoPreview.src=imageDataUrl;
    photoPreview.classList.remove("hidden");
    draftButton.classList.remove("hidden");
    draftCard.classList.add("hidden");
    feedbackCard.classList.add("hidden");
    anotherButton.classList.add("hidden");
    reviewed.checked=false;
    publishButton.disabled=true;
    track("instagram_photo_selected");
  };
  reader.readAsDataURL(file);
});

draftButton?.addEventListener("click",async()=>{
  if(!imageDataUrl)return;
  draftButton.disabled=true;
  show(draftStatus,"Narleo is studying the photo and writing your caption…");
  try{
    const response=await fetch("/.netlify/functions/dexter-instagram-photo-draft",{
      method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({image_data_url:imageDataUrl})
    });
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(body.error||"Narleo could not create the draft.");
    productLabel.textContent=body.product_label||"Your Instagram draft";
    caption.value=body.caption||"";
    uncertainty.textContent=body.uncertainty_note||"";
    uncertainty.classList.toggle("hidden",!body.uncertainty_note);
    draftCard.classList.remove("hidden");
    draftCard.scrollIntoView({behavior:"smooth",block:"start"});
    show(draftStatus,"✓ Draft ready. Review it below.","ok");
    track("instagram_draft_created");
  }catch(error){
    show(draftStatus,error.message||"Narleo could not create the draft.","error");
  }finally{
    draftButton.disabled=false;
  }
});

function refreshPublish(){
  publishButton.disabled=!reviewed.checked||!caption.value.trim();
}
reviewed?.addEventListener("change",refreshPublish);
caption?.addEventListener("input",refreshPublish);

publishButton?.addEventListener("click",async()=>{
  if(!reviewed.checked||!caption.value.trim()||!imageDataUrl)return;
  publishButton.disabled=true;
  show(publishStatus,"Posting to Instagram…");
  try{
    const response=await fetch("/.netlify/functions/dexter-instagram-publish",{
      method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        business_id:BUSINESS_ID,reviewed:true,
        caption:caption.value.trim(),image_data_url:imageDataUrl
      })
    });
    const body=await response.json().catch(()=>({}));
    if(!response.ok){
      if(body.code==="INSTAGRAM_RECONNECT_REQUIRED"||body.code==="PUBLISHING_PERMISSION_REQUIRED"){
        throw new Error("Instagram needs to be reconnected before posting. Use the Reconnect Instagram button above.");
      }
      throw new Error(body.error||"Instagram did not confirm the post.");
    }
    show(publishStatus,body.account?.username?"✓ Posted to @"+body.account.username+".":"✓ Posted to Instagram.","ok");
    feedbackCard.classList.remove("hidden");
    anotherButton.classList.remove("hidden");
    track("instagram_publish_succeeded");
  }catch(error){
    show(publishStatus,error.message||"Instagram did not confirm the post.","error");
    feedbackCard.classList.remove("hidden");
    track("instagram_publish_failed");
  }
});

document.querySelectorAll("[data-result]").forEach((button)=>{
  button.addEventListener("click",()=>{
    feedbackResult=button.dataset.result;
    document.querySelectorAll("[data-result]").forEach((item)=>{
      item.classList.toggle("active",item===button);
    });
  });
});

feedbackButton?.addEventListener("click",async()=>{
  if(!feedbackResult){
    show(feedbackStatus,"Choose Worked or Needs improvement.","error");
    return;
  }
  feedbackButton.disabled=true;
  try{
    const response=await fetch("/.netlify/functions/dexter-pilot-feedback",{
      method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        feature:"instagram-post",result:feedbackResult,note:feedbackNote.value.trim()
      })
    });
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(body.error||"Feedback could not be saved.");
    show(feedbackStatus,"✓ Thanks. Feedback saved.","ok");
    track("feedback_submitted");
  }catch(error){
    show(feedbackStatus,error.message||"Feedback could not be saved.","error");
  }finally{
    feedbackButton.disabled=false;
  }
});

anotherButton?.addEventListener("click",()=>location.reload());

(async()=>{
  const invite=consumeInvite();
  if(invite)await exchangeInvite(invite);
  const hint=consumeInstagramHint();
  if(!await hasPilotSession()){
    show(sessionStatus,"This pilot link is invalid or expired. Ask Paul for a fresh Dexter pilot link.","error");
    return;
  }
  show(sessionStatus,"✓ Secure Dexter pilot active. This device will stay signed in for 30 days.","ok");
  app.classList.remove("hidden");
  if(hint==="connected")igStatus.textContent="Instagram connected. Verifying…";
  else if(hint==="cancelled")igStatus.textContent="Instagram connection was cancelled. You can try again anytime.";
  else if(hint==="attention")igStatus.textContent="Instagram needs attention. Try reconnecting.";
  track("pilot_opened");
  checkInstagram();
})();
