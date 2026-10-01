import { createHash, randomBytes } from "node:crypto";

const PREFIX="gw_fbsel_";
export const facebookSelectionTokenPattern=/^gw_fbsel_[A-Za-z0-9_-]{43}$/;

export function generateFacebookSelectionToken(){
  return `${PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashFacebookSelectionToken(value){
  const token=String(value??"");
  if(!facebookSelectionTokenPattern.test(token))throw new Error("INVALID_FACEBOOK_SELECTION_TOKEN");
  return createHash("sha256").update(token,"utf8").digest("hex");
}
