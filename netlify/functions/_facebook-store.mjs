const INSERT_TRANSACTION=`
  INSERT INTO facebook_oauth_transactions
    (transaction_key,business_id,status,expires_at)
  VALUES ($1,$2,'pending',$3)
  RETURNING transaction_key,business_id,status,expires_at,created_at
`;
const CLAIM_TRANSACTION=`
  UPDATE facebook_oauth_transactions
     SET status='processing',processing_started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
   WHERE transaction_key=$1
     AND status='pending'
     AND expires_at>CURRENT_TIMESTAMP
  RETURNING transaction_key,business_id,status,expires_at,created_at
`;
const FINISH_TRANSACTION=`
  UPDATE facebook_oauth_transactions
     SET status=$2,consumed_at=$3,updated_at=CURRENT_TIMESTAMP
   WHERE transaction_key=$1
     AND status='processing'
  RETURNING transaction_key,status
`;
const CONNECT_CREDENTIAL=`
  INSERT INTO facebook_page_credentials
    (business_id,page_binding_key,encrypted_credential,encryption_key_version,
     status,page_name,last_verified_at)
  VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7)
  ON CONFLICT (business_id) DO UPDATE SET
    page_binding_key=EXCLUDED.page_binding_key,
    encrypted_credential=EXCLUDED.encrypted_credential,
    encryption_key_version=EXCLUDED.encryption_key_version,
    status=EXCLUDED.status,
    page_name=EXCLUDED.page_name,
    last_verified_at=EXCLUDED.last_verified_at,
    updated_at=CURRENT_TIMESTAMP
  WHERE facebook_page_credentials.page_binding_key=ANY($8::text[])
  RETURNING business_id,page_binding_key,encrypted_credential,encryption_key_version,
    status,page_name,last_verified_at,created_at,updated_at
`;
const FINALIZE_CONNECTED=`
  UPDATE facebook_oauth_transactions
     SET status='consumed_success',consumed_at=$3,updated_at=CURRENT_TIMESTAMP
   WHERE transaction_key=$1
     AND business_id=$2
     AND status='processing'
  RETURNING transaction_key
`;
const READ_CREDENTIAL=`
  SELECT business_id,page_binding_key,encrypted_credential,encryption_key_version,
    status,page_name,last_verified_at,created_at,updated_at
    FROM facebook_page_credentials
   WHERE business_id=$1
`;
const UPDATE_HEALTH=`
  UPDATE facebook_page_credentials
     SET status=$2,page_name=$3,last_verified_at=$4,updated_at=CURRENT_TIMESTAMP
   WHERE business_id=$1
  RETURNING business_id,status,page_name,last_verified_at
`;
const DELETE_CREDENTIAL=`
  DELETE FROM facebook_page_credentials
   WHERE business_id=$1
  RETURNING business_id
`;
const FIND_BUSINESS_BY_BINDING=`
  SELECT business_id,page_binding_key
    FROM facebook_page_credentials
   WHERE page_binding_key=ANY($1::text[])
     AND status='active'
   ORDER BY business_id
   LIMIT 2
`;

async function netlifyPool(){
  const {getDatabase}=await import("@netlify/database");
  return getDatabase().pool;
}
function failure(code,cause){
  const error=new Error(code);
  if(cause)error.cause=cause;
  return error;
}
function businessId(value){
  const clean=typeof value==="string"?value.trim():"";
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clean)||clean.length>80)throw failure("INVALID_BUSINESS_ID");
  return clean;
}
function transactionKey(value){
  const clean=typeof value==="string"?value.trim():"";
  if(!clean||clean.length>200)throw failure("INVALID_OAUTH_TRANSACTION");
  return clean;
}
function date(value,code){
  const parsed=value instanceof Date?new Date(value):new Date(value);
  if(!Number.isFinite(parsed.getTime()))throw failure(code);
  return parsed;
}

export function createFacebookStore({getPool=netlifyPool,crypto}={}){
  async function query(text,values){return (await getPool()).query(text,values);}

  async function createTransaction({transactionKey:key,businessId:id,expiresAt}={}){
    const values=[transactionKey(key),businessId(id),date(expiresAt,"INVALID_OAUTH_TRANSACTION")];
    try{return (await query(INSERT_TRANSACTION,values)).rows[0];}
    catch(error){
      if(error?.code==="23505")throw failure("OAUTH_TRANSACTION_COLLISION",error);
      throw failure("OAUTH_TRANSACTION_CREATE_FAILED",error);
    }
  }

  async function createTransactionWithFreshState({createState,businessId:id,expiresAt,maxAttempts=3}={}){
    if(typeof createState!=="function"||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>10){
      throw failure("INVALID_OAUTH_TRANSACTION");
    }
    for(let attempt=0;attempt<maxAttempts;attempt+=1){
      const generated=createState();
      if(!generated||typeof generated.state!=="string"||!generated.state
        ||typeof generated.nonceHash!=="string"||!generated.nonceHash){
        throw failure("INVALID_OAUTH_TRANSACTION");
      }
      try{
        await createTransaction({transactionKey:generated.nonceHash,businessId:id,expiresAt});
        return {state:generated.state};
      }catch(error){
        if(error.message!=="OAUTH_TRANSACTION_COLLISION")throw error;
      }
    }
    throw failure("OAUTH_TRANSACTION_CREATE_FAILED");
  }

  async function claimTransaction({transactionKey:key}={}){
    try{return (await query(CLAIM_TRANSACTION,[transactionKey(key)])).rows[0]??null;}
    catch(error){throw failure("OAUTH_TRANSACTION_CLAIM_FAILED",error);}
  }

  async function finishTransaction({transactionKey:key,status,now=new Date()}={}){
    if(!["consumed_success","consumed_failed","consumed_denied"].includes(status)){
      throw failure("INVALID_OAUTH_TRANSACTION");
    }
    const values=[transactionKey(key),status,date(now,"INVALID_OAUTH_TRANSACTION")];
    try{
      const row=(await query(FINISH_TRANSACTION,values)).rows[0];
      if(!row)throw failure("OAUTH_TRANSACTION_FINISH_FAILED");
      return row;
    }catch(error){
      if(error?.message==="OAUTH_TRANSACTION_FINISH_FAILED")throw error;
      throw failure("OAUTH_TRANSACTION_FINISH_FAILED",error);
    }
  }

  async function connectCredential({
    businessId:id,pageId,payload,status="active",pageName=null,lastVerifiedAt=null,
    transactionKey:key,consumedAt,
  }={}){
    if(!crypto?.pageBindingKey||!crypto?.pageBindingKeys||!crypto?.encryptCredential){
      throw failure("CREDENTIAL_CONFIGURATION_FAILED");
    }
    const cleanBusiness=businessId(id);
    if(typeof pageId!=="string"||!pageId.trim())throw failure("INVALID_CREDENTIAL");
    if(!payload||typeof payload!=="object"||Array.isArray(payload))throw failure("INVALID_CREDENTIAL");
    if(!["active","needs_attention","revoked"].includes(status))throw failure("INVALID_CREDENTIAL");
    const binding=crypto.pageBindingKey(pageId);
    const bindings=crypto.pageBindingKeys(pageId);
    const encrypted=crypto.encryptCredential({businessId:cleanBusiness,pageId,payload});
    const pool=await getPool();
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      const row=(await client.query(CONNECT_CREDENTIAL,[
        cleanBusiness,binding,JSON.stringify(encrypted),encrypted.key_version,status,
        pageName,lastVerifiedAt,bindings,
      ])).rows[0];
      if(!row)throw failure("PAGE_REBIND_FORBIDDEN");
      if(key!==undefined){
        const finished=(await client.query(FINALIZE_CONNECTED,[
          transactionKey(key),cleanBusiness,date(consumedAt,"INVALID_CREDENTIAL"),
        ])).rows[0];
        if(!finished)throw failure("OAUTH_TRANSACTION_FINISH_FAILED");
      }
      await client.query("COMMIT");
      return row;
    }catch(error){
      try{await client.query("ROLLBACK");}catch{}
      if(["PAGE_REBIND_FORBIDDEN","OAUTH_TRANSACTION_FINISH_FAILED"].includes(error?.message))throw error;
      throw failure("CREDENTIAL_CONNECT_FAILED",error);
    }finally{client.release();}
  }

  async function readCredential({businessId:id}={}){
    try{return (await query(READ_CREDENTIAL,[businessId(id)])).rows[0]??null;}
    catch(error){throw failure("CREDENTIAL_READ_FAILED",error);}
  }

  async function readDecryptedCredential({businessId:id}={}){
    if(!crypto?.decryptCredential)throw failure("CREDENTIAL_CONFIGURATION_FAILED");
    const row=await readCredential({businessId:id});
    if(!row)return null;
    const payload=crypto.decryptCredential({
      businessId:row.business_id,
      pageId:String(row.encrypted_credential?.page_id||""),
      pageBindingKey:row.page_binding_key,
      encryptedToken:row.encrypted_credential,
    });
    return {...row,payload};
  }

  async function updateCredentialHealth({businessId:id,status,pageName=null,lastVerifiedAt=null}={}){
    if(!["active","needs_attention"].includes(status))throw failure("INVALID_CREDENTIAL");
    try{
      const row=(await query(UPDATE_HEALTH,[
        businessId(id),status,pageName,lastVerifiedAt,
      ])).rows[0];
      if(!row)throw failure("CREDENTIAL_UPDATE_FAILED");
      return row;
    }catch(error){
      if(error?.message==="CREDENTIAL_UPDATE_FAILED")throw error;
      throw failure("CREDENTIAL_UPDATE_FAILED",error);
    }
  }

  async function disconnectCredential({businessId:id}={}){
    try{return (await query(DELETE_CREDENTIAL,[businessId(id)])).rows[0]??null;}
    catch(error){throw failure("CREDENTIAL_DELETE_FAILED",error);}
  }

  async function resolveBusinessByPageId({pageId}={}){
    if(!crypto?.pageBindingKeys)throw failure("CREDENTIAL_CONFIGURATION_FAILED");
    if(typeof pageId!=="string"||!pageId.trim())throw failure("INVALID_PAGE_CONTEXT");
    try{
      const rows=(await query(FIND_BUSINESS_BY_BINDING,[crypto.pageBindingKeys(pageId)])).rows;
      return rows.length===1?rows[0].business_id:null;
    }catch(error){
      if(["CREDENTIAL_CONFIGURATION_FAILED","INVALID_PAGE_CONTEXT"].includes(error?.message))throw error;
      throw failure("CREDENTIAL_READ_FAILED",error);
    }
  }

  return {
    createTransaction,createTransactionWithFreshState,claimTransaction,finishTransaction,
    connectCredential,readCredential,readDecryptedCredential,updateCredentialHealth,
    disconnectCredential,resolveBusinessByPageId,
  };
}

export const facebookDatabase=createFacebookStore;
