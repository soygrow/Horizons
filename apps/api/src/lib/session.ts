import type { SessionUser } from "@horizons/shared";
import { base64UrlDecode, base64UrlEncode, hmacSign, hmacVerify } from "./crypto";

interface SessionPayload extends SessionUser {
  exp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SESSION_COOKIE = "hzn_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 天

/** 签发无状态 JWT（HS256）会话 */
export async function createSession(
  user: SessionUser,
  secret: string,
  ttlSeconds = SESSION_TTL_SECONDS,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { ...user, exp: now + ttlSeconds };

  const h = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const p = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, `${h}.${p}`);
  return `${h}.${p}.${sig}`;
}

/** 校验会话并返回用户；无效或过期返回 null */
export async function verifySession(
  token: string,
  secret: string,
): Promise<SessionUser | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  if (!(await hmacVerify(secret, `${h}.${p}`, sig))) return null;
  try {
    const payload = JSON.parse(decoder.decode(base64UrlDecode(p))) as SessionPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return {
      id: payload.id,
      email: payload.email,
      name: payload.name,
      avatarUrl: payload.avatarUrl,
    };
  } catch {
    return null;
  }
}
