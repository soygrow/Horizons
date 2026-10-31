/**
 * 机会列表页的「N 人在做」角标：一次请求拿回本页所有机会的人数。
 * 没人参与的机会保持隐藏，避免"0 人在做"制造冷清感。
 */
export function initDoingCounts() {
  const els = Array.from(document.querySelectorAll<HTMLElement>("[data-doing-count]"));
  if (!els.length) return;

  const slugs = Array.from(new Set(els.map((el) => el.dataset.doingCount || "").filter(Boolean)));
  if (!slugs.length) return;

  fetch(`/api/opportunity/doing/counts?slugs=${encodeURIComponent(slugs.join(","))}`, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
  })
    .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
    .then((data: { counts?: Record<string, number> }) => {
      const counts = data.counts ?? {};
      for (const el of els) {
        const n = counts[el.dataset.doingCount || ""] ?? 0;
        if (n > 0) {
          el.textContent = `${n} 人在做`;
          el.classList.remove("hidden");
        }
      }
    })
    .catch(() => {
      /* 计数只是锦上添花，失败就静默 */
    });
}