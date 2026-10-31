/**
 * 「我在做」：机会详情页的参与区。
 *
 * 数据来自同域 API（/api/opportunity/:slug/doing），页面本身仍是静态产物：
 * 首屏先渲染骨架，脚本拉到数据后填充，未登录时按钮引导去 Google 登录并回跳本页。
 */

type DoingStatus = "doing" | "shipped" | "paused" | "dropped";

interface DoingUpdate {
  id: string;
  body: string;
  status: DoingStatus;
  createdAt: number;
}

interface DoingDoer {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
  status: DoingStatus;
  updateCount: number;
  lastAt: number;
  joinedAt: number;
}

interface DoingResponse {
  slug: string;
  count: number;
  doers: DoingDoer[];
  authenticated: boolean;
  me: { status: DoingStatus; joinedAt: number; updates: DoingUpdate[] } | null;
}

const STATUS_LABELS: Record<DoingStatus, string> = {
  doing: "在做",
  shipped: "已上线",
  paused: "暂停了",
  dropped: "放弃了",
};

const STATUS_CLASS: Record<DoingStatus, string> = {
  doing: "border-primary/30 bg-primary/10 text-primary",
  shipped: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500",
  paused: "border-amber-500/30 bg-amber-500/10 text-amber-500",
  dropped: "border-border bg-surface-2 text-ink-muted",
};

const MAX_AVATARS = 12;
const MAX_BODY = 280;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const initials = (name: string | null) => (name?.trim()?.[0] ?? "?").toUpperCase();

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ms).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function avatarHtml(url: string | null, name: string | null, size = "h-9 w-9"): string {
  if (url) {
    return `<img src="${esc(url)}" alt="${esc(name ?? "参与者")}" class="${size} rounded-full object-cover ring-1 ring-border" loading="lazy" referrerpolicy="no-referrer" />`;
  }
  return `<span class="${size} flex items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-ink-secondary ring-1 ring-border">${esc(initials(name))}</span>`;
}

export function initDoing() {
  const root = document.querySelector<HTMLElement>("[data-doing]");
  if (!root) return;

  const slug = root.dataset.doingSlug || "";
  if (!slug) return;

  const api = `/api/opportunity/${encodeURIComponent(slug)}/doing`;

  const els = {
    count: root.querySelector<HTMLElement>("[data-doing-count]"),
    avatars: root.querySelector<HTMLElement>("[data-doing-avatars]"),
    empty: root.querySelector<HTMLElement>("[data-doing-empty]"),
    join: root.querySelector<HTMLButtonElement>("[data-doing-join]"),
    joinLabel: root.querySelector<HTMLElement>("[data-doing-join-label]"),
  };

  const dialog = document.querySelector<HTMLDialogElement>("[data-doing-dialog]");
  const viewer = document.querySelector<HTMLDialogElement>("[data-doing-viewer]");
  if (!dialog || !viewer) return;

  const form = dialog.querySelector<HTMLFormElement>("[data-doing-form]");
  const textarea = dialog.querySelector<HTMLTextAreaElement>("[data-doing-text]");
  const counter = dialog.querySelector<HTMLElement>("[data-doing-counter]");
  const statusBox = dialog.querySelector<HTMLElement>("[data-doing-status]");
  const errorEl = dialog.querySelector<HTMLElement>("[data-doing-error]");
  const historyEl = dialog.querySelector<HTMLElement>("[data-doing-history]");
  const submitBtn = dialog.querySelector<HTMLButtonElement>("[data-doing-submit]");
  const leaveBtn = dialog.querySelector<HTMLButtonElement>("[data-doing-leave]");
  const dialogTitle = dialog.querySelector<HTMLElement>("[data-doing-title]");

  let state: DoingResponse | null = null;
  let status: DoingStatus = "doing";

  const setStatus = (next: DoingStatus) => {
    status = next;
    statusBox?.querySelectorAll<HTMLButtonElement>("[data-status]").forEach((btn) => {
      const active = btn.dataset.status === next;
      btn.className = active
        ? `rounded-full border px-2.5 py-1 text-[11px] font-medium ${STATUS_CLASS[next]}`
        : "rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] text-ink-secondary transition hover:border-primary/40 hover:text-ink";
    });
  };

  const showError = (msg: string) => {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.classList.toggle("hidden", !msg);
  };

  const requireLogin = () => {
    // 带 doing=1 回来，登录成功后自动弹出编辑框，省掉再点一次
    const next = `${window.location.pathname}?doing=1`;
    window.location.href = `/api/auth/google?next=${encodeURIComponent(next)}`;
  };

  const renderAvatars = () => {
    if (!state || !els.avatars) return;
    const shown = state.doers.slice(0, MAX_AVATARS);
    els.avatars.innerHTML = shown
      .map(
        (d) => `
        <button
          type="button"
          data-user="${esc(d.userId)}"
          title="${esc(d.name ?? "匿名用户")} · ${STATUS_LABELS[d.status]}${d.updateCount ? ` · ${d.updateCount} 条留言` : ""}"
          class="group relative -ml-2 first:ml-0 rounded-full transition hover:z-10 hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >${avatarHtml(d.avatarUrl, d.name)}
          <span class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${
            d.status === "shipped" ? "bg-emerald-500" : d.status === "doing" ? "bg-primary" : d.status === "paused" ? "bg-amber-500" : "bg-ink-muted/40"
          }"></span>
        </button>`,
      )
      .join("");

    if (state.count > shown.length) {
      els.avatars.insertAdjacentHTML(
        "beforeend",
        `<span class="-ml-2 flex h-9 items-center rounded-full bg-surface-2 px-2 text-[11px] text-ink-muted ring-1 ring-border">+${state.count - shown.length}</span>`,
      );
    }

    els.avatars.classList.toggle("hidden", state.count === 0);
    els.empty?.classList.toggle("hidden", state.count > 0);
    if (els.count) els.count.textContent = state.count > 0 ? `${state.count} 人在做` : "还没人动手";

    const joined = !!state.me;
    if (els.joinLabel) {
      els.joinLabel.textContent = joined
        ? "更新进展"
        : state.authenticated
          ? "我在做"
          : "登录后加入";
    }
  };

  const renderHistory = () => {
    if (!historyEl) return;
    const updates = state?.me?.updates ?? [];
    if (!updates.length) {
      historyEl.innerHTML = "";
      historyEl.classList.add("hidden");
      leaveBtn?.classList.add("hidden");
      return;
    }
    historyEl.classList.remove("hidden");
    leaveBtn?.classList.remove("hidden");
    historyEl.innerHTML = updates
      .map(
        (u) => `
        <li class="rounded-lg border border-border bg-canvas/40 px-3 py-2">
          <div class="flex items-center gap-2 text-[10px] text-ink-muted">
            <span class="rounded border px-1 py-0.5 ${STATUS_CLASS[u.status]}">${STATUS_LABELS[u.status]}</span>
            <span>${timeAgo(u.createdAt)}</span>
          </div>
          <p class="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink-secondary">${esc(u.body)}</p>
        </li>`,
      )
      .join("");
  };

  const openEditor = () => {
    if (!state) return;
    if (!state.authenticated) return requireLogin();
    setStatus(state.me?.status ?? "doing");
    if (textarea) textarea.value = "";
    if (counter) counter.textContent = `0 / ${MAX_BODY}`;
    showError("");
    renderHistory();
    if (dialogTitle) dialogTitle.textContent = state.me ? "更新进展" : "标记我在做";
    dialog.showModal();
    window.setTimeout(() => textarea?.focus(), 30);
  };

  const load = async () => {
    try {
      const res = await fetch(api, { headers: { accept: "application/json" }, credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      state = (await res.json()) as DoingResponse;
      renderAvatars();

      // 登录回跳：?doing=1 自动打开编辑框，然后清掉参数
      const url = new URL(window.location.href);
      if (url.searchParams.get("doing") === "1") {
        url.searchParams.delete("doing");
        window.history.replaceState({}, "", url.pathname + url.search + url.hash);
        if (state.authenticated) openEditor();
      }
    } catch {
      if (els.count) els.count.textContent = "参与数据暂不可用";
    }
  };

  /* --------------------------- 事件 --------------------------- */

  els.join?.addEventListener("click", openEditor);

  els.avatars?.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-user]");
    if (!btn) return;
    const userId = btn.dataset.user!;
    const body = viewer.querySelector<HTMLElement>("[data-viewer-body]");
    const head = viewer.querySelector<HTMLElement>("[data-viewer-head]");
    if (body) body.innerHTML = `<p class="text-xs text-ink-muted">加载中…</p>`;
    viewer.showModal();

    try {
      const res = await fetch(`${api}/${encodeURIComponent(userId)}`, {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        user: { name: string | null; avatarUrl: string | null; status: DoingStatus };
        updates: DoingUpdate[];
      };
      if (head) {
        head.innerHTML = `
          ${avatarHtml(data.user.avatarUrl, data.user.name, "h-10 w-10")}
          <div class="min-w-0">
            <div class="truncate text-sm font-medium text-ink">${esc(data.user.name ?? "匿名用户")}</div>
            <div class="mt-0.5 flex items-center gap-2 text-[11px] text-ink-muted">
              <span class="rounded border px-1.5 py-0.5 ${STATUS_CLASS[data.user.status]}">${STATUS_LABELS[data.user.status]}</span>
              <span>${data.updates.length} 条留言</span>
            </div>
          </div>`;
      }
      if (body) {
        body.innerHTML = data.updates.length
          ? `<ul class="space-y-2">${data.updates
              .map(
                (u) => `
              <li class="rounded-lg border border-border bg-canvas/40 px-3 py-2">
                <div class="flex items-center gap-2 text-[10px] text-ink-muted">
                  <span class="rounded border px-1 py-0.5 ${STATUS_CLASS[u.status]}">${STATUS_LABELS[u.status]}</span>
                  <span>${timeAgo(u.createdAt)}</span>
                </div>
                <p class="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink-secondary">${esc(u.body)}</p>
              </li>`,
              )
              .join("")}</ul>`
          : `<p class="text-xs text-ink-muted">这个人只点了「我在做」，还没写进展。</p>`;
      }
    } catch {
      if (body) body.innerHTML = `<p class="text-xs text-ink-muted">留言加载失败，请稍后再试。</p>`;
    }
  });

  statusBox?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-status]");
    if (btn?.dataset.status) setStatus(btn.dataset.status as DoingStatus);
  });

  textarea?.addEventListener("input", () => {
    const n = textarea.value.length;
    if (n > MAX_BODY) textarea.value = textarea.value.slice(0, MAX_BODY);
    if (counter) counter.textContent = `${Math.min(n, MAX_BODY)} / ${MAX_BODY}`;
  });

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = (textarea?.value ?? "").trim();
    submitBtn?.setAttribute("disabled", "true");
    showError("");
    try {
      const res = await fetch(api, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ status, body: text }),
      });
      if (res.status === 401) return requireLogin();
      if (res.status === 429) {
        showError("提交太快了，等半分钟再发。");
        return;
      }
      if (!res.ok) {
        showError("提交失败，请稍后重试。");
        return;
      }
      dialog.close();
      await load();
    } catch {
      showError("网络异常，请稍后重试。");
    } finally {
      submitBtn?.removeAttribute("disabled");
    }
  });

  leaveBtn?.addEventListener("click", async () => {
    if (!window.confirm("退出后，你在这条机会下的留言也会一起删除，确定吗？")) return;
    leaveBtn.setAttribute("disabled", "true");
    try {
      const res = await fetch(api, { method: "DELETE", credentials: "same-origin" });
      if (res.status === 401) return requireLogin();
      if (!res.ok) return showError("退出失败，请稍后重试。");
      dialog.close();
      await load();
    } finally {
      leaveBtn.removeAttribute("disabled");
    }
  });

  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  viewer.addEventListener("click", (e) => {
    if (e.target === viewer) viewer.close();
  });

  void load();
}