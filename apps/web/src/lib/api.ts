import type { SessionUser } from "@horizons/shared";

export type { SessionUser };

/** 获取当前登录用户；未登录返回 null */
export async function fetchMe(): Promise<SessionUser | null> {
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    if (!res.ok) return null;
    const data = (await res.json()) as { user: SessionUser | null };
    return data.user ?? null;
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
  });
}
