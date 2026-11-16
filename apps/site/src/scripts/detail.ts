/**
 * 工具详情页交互：复制 Markdown、收藏、截屏放大。
 * 收藏：登录后写 D1（跨设备），未登录先存 localStorage，登录时自动合并。
 */
import {
  addFavorite,
  fetchRemoteFavorites,
  mergeLocalFavorites,
  readLocalFavorites,
  removeFavorite,
  writeLocalFavorites,
} from "../lib/favorites";

const FAV_OFF =
  "inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium text-ink-secondary transition hover:border-primary/40 hover:text-ink";
const FAV_ON =
  "inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-primary bg-primary-soft px-4 text-sm font-medium text-primary transition";

export function initToolDetail() {
  // 复制 Markdown
  document.querySelectorAll<HTMLButtonElement>("[data-copy-markdown]").forEach((btn) => {
    const label = btn.textContent || "复制数据";
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copyMarkdown || "");
        btn.textContent = "已复制";
        window.setTimeout(() => {
          btn.textContent = label;
        }, 1600);
      } catch {
        btn.textContent = "复制失败";
      }
    });
  });

  // 收藏：先用本地立即上色，再按登录态切到服务端（跨设备）
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-fav]")];
  if (buttons.length) {
    let favs = new Set(readLocalFavorites());
    /** null = 未登录，走本地；Set = 已登录，走 /api/favorites */
    let remote: Set<string> | null = null;
    let busy = false;

    const paint = (btn: HTMLButtonElement) => {
      const on = favs.has(btn.dataset.fav || "");
      btn.textContent = on ? "已收藏" : "收藏";
      btn.className = on ? FAV_ON : FAV_OFF;
    };
    buttons.forEach(paint);

    (async () => {
      const fetched = await fetchRemoteFavorites();
      if (!fetched) return; // 未登录：保持本地态
      remote = await mergeLocalFavorites(fetched);
      favs = new Set(remote);
      buttons.forEach(paint);
    })();

    buttons.forEach((btn) => {
      const domain = btn.dataset.fav || "";
      if (!domain) return;

      btn.addEventListener("click", async () => {
        if (busy) return;
        busy = true;
        try {
          if (remote) {
            const on = !favs.has(domain);
            const ok = on ? await addFavorite(domain) : await removeFavorite(domain);
            if (ok) {
              if (on) favs.add(domain);
              else favs.delete(domain);
              paint(btn);
            } else {
              btn.textContent = "操作失败";
              window.setTimeout(() => paint(btn), 1600);
            }
          } else {
            if (favs.has(domain)) favs.delete(domain);
            else favs.add(domain);
            writeLocalFavorites([...favs]);
            paint(btn);
          }
        } finally {
          busy = false;
        }
      });
    });
  }

  /**
   * 品类标签折叠：点 +N 展开其余标签，再点收起。
   * 之前 +N 只是个 span，最多挂个 title —— 长得像按钮却点不动，
   * 触屏上更是连提示都没有，等于把 7 个标签藏了起来。
   */
  document.querySelectorAll<HTMLElement>("[data-tag-collapse]").forEach((box) => {
    const btn = box.querySelector<HTMLButtonElement>("[data-tag-more]");
    if (!btn) return;
    const rest = [...box.querySelectorAll<HTMLElement>("[data-tag-rest]")];
    const total = rest.length;
    let open = false;

    const paint = () => {
      for (const el of rest) el.classList.toggle("hidden", !open);
      btn.textContent = open ? "收起" : `+${total}`;
      btn.setAttribute("aria-expanded", String(open));
      // 展开后完整列表已在眼前，tooltip 反而挡住标签，收起时再挂回去
      if (open) btn.removeAttribute("title");
      else btn.title = rest.map((el) => (el.textContent || "").trim()).filter(Boolean).join("、");
    };

    btn.addEventListener("click", () => {
      open = !open;
      paint();
    });
  });

  // 截图放大：点击缩略图查看原图
  document.querySelectorAll<HTMLButtonElement>("[data-lightbox]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const src = btn.dataset.lightbox || "";
      if (!src) return;

      const prevOverflow = document.body.style.overflow;
      const overlay = document.createElement("div");
      overlay.className =
        "fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-4 sm:p-8";
      overlay.style.opacity = "0";
      overlay.style.transition = "opacity 150ms ease-out";

      const img = document.createElement("img");
      img.src = src;
      img.alt = btn.getAttribute("aria-label") || "";
      img.className = "max-h-full max-w-full rounded-lg object-contain shadow-2xl";
      overlay.appendChild(img);

      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") close();
      };
      const close = () => {
        overlay.style.opacity = "0";
        document.removeEventListener("keydown", onKey);
        document.body.style.overflow = prevOverflow;
        window.setTimeout(() => overlay.remove(), 150);
      };

      overlay.addEventListener("click", close);
      document.addEventListener("keydown", onKey);
      document.body.style.overflow = "hidden";
      document.body.appendChild(overlay);
      requestAnimationFrame(() => (overlay.style.opacity = "1"));
    });
  });
}