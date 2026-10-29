/**
 * 工具详情页交互：复制 Markdown、收藏、截屏放大。
 * 均无第三方依赖，纯 localStorage / Clipboard / DOM。
 */

const FAV_KEY = "horizons:favorites";

const readFavs = (): string[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
};

const writeFavs = (list: string[]) => {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式下忽略 */
  }
};

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

  // 收藏（localStorage）
  const favs = new Set(readFavs());
  document.querySelectorAll<HTMLButtonElement>("[data-fav]").forEach((btn) => {
    const domain = btn.dataset.fav || "";
    const paint = () => {
      const on = favs.has(domain);
      btn.textContent = on ? "已收藏" : "收藏";
      btn.className = on ? FAV_ON : FAV_OFF;
    };
    paint();
    btn.addEventListener("click", () => {
      if (favs.has(domain)) favs.delete(domain);
      else favs.add(domain);
      writeFavs([...favs]);
      paint();
    });
  });

  // 截图放大
  document.querySelectorAll<HTMLButtonElement>("[data-lightbox]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const src = btn.dataset.lightbox || "";
      const overlay = document.createElement("div");
      overlay.className =
        "fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-6";
      const img = document.createElement("img");
      img.src = src;
      img.alt = "";
      img.className = "max-h-full max-w-full rounded-lg object-contain";
      overlay.appendChild(img);
      const close = () => {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") close();
      };
      overlay.addEventListener("click", close);
      document.addEventListener("keydown", onKey);
      document.body.appendChild(overlay);
    });
  });
}