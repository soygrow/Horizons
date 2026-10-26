import { hmacSign, hmacVerify, randomBytesBase64 } from "./crypto";

/** 构造 Google 授权页 URL */
export function buildAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
    access_type: "online",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** 生成防 CSRF 的 state（HMAC 签名，免存储） */
export async function createState(secret: string): Promise<string> {
  const nonce = randomBytesBase64(16);
  const sig = await hmacSign(secret, nonce);
  return `${nonce}.${sig}`;
}

/** 校验 state 签名 */
export async function verifyState(state: string, secret: string): Promise<boolean> {
  const idx = state.lastIndexOf(".");
  if (idx <= 0) return false;
  const nonce = state.slice(0, idx);
  const sig = state.slice(idx + 1);
  return hmacVerify(secret, nonce, sig);
}

export interface GoogleTokenResponse {
  access_token: string;
  id_token?: string;
}

export interface GoogleUserInfo {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

/** 用授权码换取 access_token */
export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<GoogleTokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  return (await res.json()) as GoogleTokenResponse;
}

/** 用 access_token 拉取用户信息 */
export async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`userinfo failed: ${res.status}`);
  return (await res.json()) as GoogleUserInfo;
}
