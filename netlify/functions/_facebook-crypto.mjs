import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const STATE_VERSION="v1";
const STATE_NONCE_BYTES=32;
const GCM_IV_BYTES=12;
const GCM_TAG_BYTES=16;
const SAFE_SEGMENT=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function fail(code){throw new Error(code);}
function requireSegment(value,code){
  if(typeof value!=="string"||!SAFE_SEGMENT.test(value))fail(code);
  return value;
}
function decodeBase64url(value,expectedBytes,code){
  if(typeof value!=="string"||!/^[A-Za-z0-9_-]+$/.test(value))fail(code);
  const decoded=Buffer.from(value,"base64url");
  if(decoded.length!==expectedBytes||decoded.toString("base64url")!==value)fail(code);
  return decoded;
}
function versions(configuration,{encryption=false,code}){
  if(!configuration||typeof configuration!=="object"||!configuration.current)fail(code);
  const entries=[configuration.current,...(configuration.previous??[])],seen=new Set();
  return entries.map((entry)=>{
    if(!entry||typeof entry!=="object")fail(code);
    const id=requireSegment(entry.id,code);
    if(id.length>64||seen.has(id))fail(code);
    seen.add(id);
    let key;
    if(encryption)key=decodeBase64url(entry.key,32,code);
    else{
      if(typeof entry.key!=="string"||entry.key.length<16)fail(code);
      key=Buffer.from(entry.key,"utf8");
    }
    return {id,key};
  });
}
function parseState(state){
  if(typeof state!=="string")fail("INVALID_STATE");
  const parts=state.split(".");
  if(parts.length!==3||parts[0]!==STATE_VERSION)fail("INVALID_STATE");
  return {
    nonce:decodeBase64url(parts[1],STATE_NONCE_BYTES,"INVALID_STATE"),
    nonceText:parts[1],
    tag:decodeBase64url(parts[2],32,"INVALID_STATE"),
  };
}
function nonceHash(nonce){return createHash("sha256").update(nonce).digest("base64url");}
function bindingValue(version,pageId){
  requireSegment(pageId,"INVALID_PAGE_CONTEXT");
  return `${version.id}.${createHmac("sha256",version.key).update(pageId,"utf8").digest("base64url")}`;
}
function aad(businessId,pageBindingKey){
  requireSegment(businessId,"INVALID_CREDENTIAL_CONTEXT");
  requireSegment(pageBindingKey,"INVALID_CREDENTIAL_CONTEXT");
  return Buffer.from(
    `growthwise-facebook-database\ncredential-v1\n${businessId}\nfacebook-page\n${pageBindingKey}`,
    "utf8",
  );
}

function selectionAad(businessId,selectionHash){
  requireSegment(businessId,"INVALID_SELECTION_CONTEXT");
  if(typeof selectionHash!=="string"||!/^[a-f0-9]{64}$/.test(selectionHash))fail("INVALID_SELECTION_CONTEXT");
  return Buffer.from(
    `growthwise-facebook-database\nselection-v1\n${businessId}\n${selectionHash}`,
    "utf8",
  );
}

export function createFacebookCrypto({
  stateSecrets,
  bindingSecrets,
  credentialKeys,
  randomBytesImpl=randomBytes,
}){
  const states=versions(stateSecrets,{code:"INVALID_STATE_CONFIGURATION"});
  const bindings=versions(bindingSecrets,{code:"INVALID_BINDING_CONFIGURATION"});
  const credentials=versions(credentialKeys,{encryption:true,code:"INVALID_CREDENTIAL_CONFIGURATION"});
  if(typeof randomBytesImpl!=="function")fail("INVALID_RANDOM_SOURCE");

  function verifyState(state){
    const parsed=parseState(state);
    const signed=Buffer.from(`${STATE_VERSION}.${parsed.nonceText}`,"utf8");
    for(const version of states){
      const expected=createHmac("sha256",version.key).update(signed).digest();
      if(timingSafeEqual(parsed.tag,expected)){
        return {nonceHash:nonceHash(parsed.nonce),keyVersion:version.id};
      }
    }
    fail("INVALID_STATE");
  }
  function pageBindingKeys(pageId){return bindings.map((version)=>bindingValue(version,pageId));}

  return {
    createState(){
      const nonce=Buffer.from(randomBytesImpl(STATE_NONCE_BYTES));
      if(nonce.length!==STATE_NONCE_BYTES)fail("INVALID_RANDOM_SOURCE");
      const nonceText=nonce.toString("base64url");
      const unsigned=`${STATE_VERSION}.${nonceText}`;
      const tag=createHmac("sha256",states[0].key).update(unsigned,"utf8").digest("base64url");
      return {state:`${unsigned}.${tag}`,nonceHash:nonceHash(nonce),keyVersion:states[0].id};
    },
    verifyState,
    transactionKey(state){return verifyState(state).nonceHash;},
    pageBindingKey(pageId){return pageBindingKeys(pageId)[0];},
    pageBindingKeys,
    encryptCredential({businessId,pageId,payload}){
      const pageBindingKey=pageBindingKeys(pageId)[0];
      const iv=Buffer.from(randomBytesImpl(GCM_IV_BYTES));
      if(iv.length!==GCM_IV_BYTES)fail("INVALID_RANDOM_SOURCE");
      let plaintext;
      try{plaintext=Buffer.from(JSON.stringify(payload),"utf8");}catch{fail("INVALID_CREDENTIAL_PAYLOAD");}
      const cipher=createCipheriv("aes-256-gcm",credentials[0].key,iv);
      cipher.setAAD(aad(businessId,pageBindingKey));
      const encrypted=Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]);
      return {
        algorithm:"A256GCM",key_version:credentials[0].id,
        iv:iv.toString("base64url"),ciphertext:encrypted.toString("base64url"),
      };
    },
    decryptCredential({businessId,pageId,pageBindingKey:storedBindingKey,encryptedToken}){
      if(!encryptedToken||encryptedToken.algorithm!=="A256GCM")fail("CREDENTIAL_DECRYPT_FAILED");
      const version=credentials.find(({id})=>id===encryptedToken.key_version);
      if(!version)fail("UNKNOWN_CREDENTIAL_KEY");
      try{
        const iv=decodeBase64url(encryptedToken.iv,GCM_IV_BYTES,"CREDENTIAL_DECRYPT_FAILED");
        if(typeof encryptedToken.ciphertext!=="string"||!/^[A-Za-z0-9_-]+$/.test(encryptedToken.ciphertext))fail("CREDENTIAL_DECRYPT_FAILED");
        const combined=Buffer.from(encryptedToken.ciphertext,"base64url");
        if(combined.length<=GCM_TAG_BYTES||combined.toString("base64url")!==encryptedToken.ciphertext)fail("CREDENTIAL_DECRYPT_FAILED");
        const body=combined.subarray(0,-GCM_TAG_BYTES),tag=combined.subarray(-GCM_TAG_BYTES);
        const candidates=storedBindingKey===undefined?pageBindingKeys(pageId):[requireSegment(storedBindingKey,"INVALID_CREDENTIAL_CONTEXT")];
        for(const pageBindingKey of candidates){
          try{
            const decipher=createDecipheriv("aes-256-gcm",version.key,iv);
            decipher.setAAD(aad(businessId,pageBindingKey));
            decipher.setAuthTag(tag);
            return JSON.parse(Buffer.concat([decipher.update(body),decipher.final()]).toString("utf8"));
          }catch{}
        }
        fail("CREDENTIAL_DECRYPT_FAILED");
      }catch(error){
        if(error?.message==="UNKNOWN_CREDENTIAL_KEY")throw error;
        fail("CREDENTIAL_DECRYPT_FAILED");
      }
    },

    encryptSelection({businessId,selectionHash,pages}){
      if(!Array.isArray(pages)||pages.length<2||pages.length>100)fail("INVALID_SELECTION_PAYLOAD");
      const iv=Buffer.from(randomBytesImpl(GCM_IV_BYTES));
      if(iv.length!==GCM_IV_BYTES)fail("INVALID_RANDOM_SOURCE");
      let plaintext;
      try{plaintext=Buffer.from(JSON.stringify(pages),"utf8");}catch{fail("INVALID_SELECTION_PAYLOAD");}
      const cipher=createCipheriv("aes-256-gcm",credentials[0].key,iv);
      cipher.setAAD(selectionAad(businessId,selectionHash));
      const encrypted=Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]);
      return {
        algorithm:"A256GCM",key_version:credentials[0].id,
        iv:iv.toString("base64url"),ciphertext:encrypted.toString("base64url"),
      };
    },

    decryptSelection({businessId,selectionHash,encryptedSelection}){
      if(!encryptedSelection||encryptedSelection.algorithm!=="A256GCM")fail("SELECTION_DECRYPT_FAILED");
      const version=credentials.find(({id})=>id===encryptedSelection.key_version);
      if(!version)fail("UNKNOWN_CREDENTIAL_KEY");
      try{
        const iv=decodeBase64url(encryptedSelection.iv,GCM_IV_BYTES,"SELECTION_DECRYPT_FAILED");
        if(typeof encryptedSelection.ciphertext!=="string"||!/^[A-Za-z0-9_-]+$/.test(encryptedSelection.ciphertext)){
          fail("SELECTION_DECRYPT_FAILED");
        }
        const combined=Buffer.from(encryptedSelection.ciphertext,"base64url");
        if(combined.length<=GCM_TAG_BYTES||combined.toString("base64url")!==encryptedSelection.ciphertext){
          fail("SELECTION_DECRYPT_FAILED");
        }
        const body=combined.subarray(0,-GCM_TAG_BYTES),tag=combined.subarray(-GCM_TAG_BYTES);
        const decipher=createDecipheriv("aes-256-gcm",version.key,iv);
        decipher.setAAD(selectionAad(businessId,selectionHash));
        decipher.setAuthTag(tag);
        const parsed=JSON.parse(Buffer.concat([decipher.update(body),decipher.final()]).toString("utf8"));
        if(!Array.isArray(parsed))fail("SELECTION_DECRYPT_FAILED");
        return parsed;
      }catch(error){
        if(error?.message==="UNKNOWN_CREDENTIAL_KEY")throw error;
        fail("SELECTION_DECRYPT_FAILED");
      }
    },
  };
}
