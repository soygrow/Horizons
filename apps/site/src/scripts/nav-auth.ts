/**
 * 导航栏登录态：静态页面先渲染「登录」按钮，这里再按 /api/me 换成头像 + 用户名。
 *
 * 为什么不在服务端判断：站点是 static 产物，导航栏会进 CDN 缓存，
 * 按 cookie 渲染会把某一个人的头像缓存给所有人；一次同域 fetch 换 UI 最省事，
 * 请求失败或未登录就保持「登录」按钮不动。
 */

interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export function initNavAuth() {
  const loginLink = document.getElementById("nav-login");
  const userLink = document.getElementById("nav-user");
  if (!loginLink || !userLink) return;

  const avatar = document.getElementById("nav-user-avatar");
  const nameEl = document.getElementById("nav-user-name");

  fetch("/api/me", { headers: { accept: "application/json" }, credentials: "same-origin" })
    .then((res) => (res.ok ? (res.json() as Promise<{ user: SessionUser | null }>) : null))
    .then((data) => {
      const user = data?.user;
      if (!user) return;

      const label = (user.name ?? user.email.split("@")[0] ?? "").trim() || "我的账户";

      if (nameEl) nameEl.textContent = label;
      userLink.setAttribute("aria-label", `${label}（进入账户页）`);

      if (avatar) {
        if (user.avatarUrl) {
          const img = document.createElement("img");
          img.src = user.avatarUrl;
          img.alt = "";
          img.referrerPolicy = "no-referrer";
          img.className = "h-7 w-7 rounded-full object-cover";
          avatar.className = "shrink-0";
          avatar.replaceChildren(img);
        } else {
          avatar.textContent = (user.name ?? user.email).trim().charAt(0).toUpperCase();
        }
      }

      loginLink.hidden = true;
      userLink.hidden = false;
    })
    .catch(() => {
      /* 未登录或有跨域问题：保留「登录」按钮 */
    });
}