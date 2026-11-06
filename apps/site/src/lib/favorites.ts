/**
 * 收藏：登录态走 D1（/api/favorites），未登录先存 localStorage。
 *
 * 为什么保留本地档：详情页是主要流量入口，强制登录会直接把这次收藏丢掉。
 * 但账户页只认 D1，所以登录后必须把本地那份补上去（merge，幂等），
 * 补完立刻清空本地，避免两台设备各存一份对不上。
 */
export const FAV_KEY = "horizons:favorites";

export function readLocalFavorites(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

export function writeLocalFavorites(list: string[]): void {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式下忽略 */
  }
}

interface FavPayload {
  favorites?: { domain: string; createdAt: number }[];
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** 服务端收藏；未登录（401）或网络异常返回 null，调用方回落到本地 */
export async function fetchRemoteFavorites(): Promise<Set<string> | null> {
  const data = await getJson<FavPayload>("/api/favorites");
  if (!data || !Array.isArray(data.favorites)) return null;
  return new Set(data.favorites.map((f) => f.domain));
}

/**
 * 把本地收藏并进账号，成功后清空本地。
 * 返回合并后的完整集合；失败（离线、超限）时保留本地并返回原集合。
 */
export async function mergeLocalFavorites(remote: Set<string>): Promise<Set<string>> {
  const local = readLocalFavorites();
  const missing = local.filter((d) => !remote.has(d));
  if (!missing.length) {
    if (local.length) writeLocalFavorites([]);
    return remote;
  }

  try {
    const res = await fetch("/api/favorites/merge", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ domains: missing }),
    });
    if (!res.ok) return remote;

    const data = (await res.json()) as FavPayload;
    if (!Array.isArray(data.favorites)) return remote;

    writeLocalFavorites([]);
    return new Set(data.favorites.map((f) => f.domain));
  } catch {
    return remote;
  }
}

/** 收藏；返回是否成功（未登录也会返回 false，由调用方决定回落到本地） */
export async function addFavorite(domain: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/favorites/${encodeURIComponent(domain)}`, {
      method: "PUT",
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function removeFavorite(domain: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/favorites/${encodeURIComponent(domain)}`, {
      method: "DELETE",
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
    return res.ok;
  } catch {
    return false;
  }
}