/**
 * 统一确认弹框：替代 window.confirm。
 *
 * 原生 confirm 是浏览器画的框，样式、按钮文案、危险色全都不可控，在站内
 * 圆角卡片 + 品牌渐变的视觉里显得格格不入。这里复刻 LoginDialog 的语言
 * （顶部品牌渐变细条、浅色描边、半透明遮罩），动态插入一个 <dialog> 并复用，
 * 返回 Promise<boolean>，调用方照旧写 `if (!(await confirmAction(...))) return`。
 *
 *   const ok = await confirmAction({
 *     title: "取消参与？",
 *     description: "你在这条机会下的留言也会一起删除。",
 *     confirmText: "取消参与",
 *     tone: "danger",
 *   });
 */

export interface ConfirmOptions {
  /** 一句话问句，例如「取消参与？」 */
  title: string;
  /** 补充说明，把后果讲清楚 */
  description?: string;
  /** 确认按钮文案，默认「确定」 */
  confirmText?: string;
  /** 取消按钮文案，默认「再想想」，比「取消」更不容易误点 */
  cancelText?: string;
  /** danger 用红色确认按钮，用于删除这类不可逆操作 */
  tone?: "default" | "danger";
}

const DIALOG_ID = "hzn-confirm";

let dlg: HTMLDialogElement | null = null;
let settle: ((ok: boolean) => void) | null = null;

const OK_BUTTON =
  "inline-flex h-9 items-center justify-center rounded-xl px-4 text-[13px] font-semibold text-white transition focus:outline-none focus-visible:ring-4";

/** 类名必须是完整字面量，Tailwind 才扫得到 */
const OK_TONE: Record<NonNullable<ConfirmOptions["tone"]>, string> = {
  default: `${OK_BUTTON} bg-primary hover:bg-primary-hover focus-visible:ring-primary/25`,
  danger: `${OK_BUTTON} bg-rose-600 hover:bg-rose-500 focus-visible:ring-rose-500/25`,
};

/** 入场动画没法用 Tailwind 表达（需要 keyframes），单独注入一次 */
function injectStyle() {
  if (document.getElementById(`${DIALOG_ID}-style`)) return;
  const style = document.createElement("style");
  style.id = `${DIALOG_ID}-style`;
  style.textContent = `
    #${DIALOG_ID}[open] > div { animation: hzn-confirm-in 160ms cubic-bezier(0.2, 0.8, 0.2, 1); }
    @keyframes hzn-confirm-in {
      from { opacity: 0; transform: translateY(8px) scale(0.985); }
    }
    @media (prefers-reduced-motion: reduce) {
      #${DIALOG_ID}[open] > div { animation: none; }
    }`;
  document.head.appendChild(style);
}

function ensureDialog(): HTMLDialogElement {
  if (dlg) return dlg;

  const el = document.createElement("dialog");
  el.id = DIALOG_ID;
  el.setAttribute("aria-labelledby", `${DIALOG_ID}-title`);
  el.setAttribute("aria-describedby", `${DIALOG_ID}-desc`);
  // 原生 dialog 自带 padding/border，视觉全部交给内层卡片
  el.className =
    "fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[26rem] overflow-visible border-0 bg-transparent p-0 text-ink backdrop:bg-black/50";
  el.innerHTML = `
    <div class="relative overflow-hidden rounded-[20px] border border-border bg-surface shadow-[0_30px_80px_-32px_rgba(12,31,80,0.5)]">
      <div class="h-1 w-full" style="background-image: var(--brand-gradient);"></div>
      <div class="px-6 pb-5 pt-5">
        <h2 id="${DIALOG_ID}-title" data-confirm-title class="text-[15px] font-semibold leading-6 tracking-tight text-ink"></h2>
        <p id="${DIALOG_ID}-desc" data-confirm-desc class="mt-2 text-[13px] leading-6 text-ink-secondary"></p>
        <div class="mt-5 flex items-center justify-end gap-2.5">
          <button
            type="button"
            data-confirm-cancel
            class="inline-flex h-9 items-center justify-center rounded-xl border border-border px-4 text-[13px] font-medium text-ink-secondary transition hover:border-border-strong hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-4 focus-visible:ring-primary/20"
          >取消</button>
          <button type="button" data-confirm-ok class="${OK_TONE.default}">确定</button>
        </div>
      </div>
    </div>`;

  const finish = (ok: boolean) => {
    const resume = settle;
    settle = null;
    if (el.open) el.close();
    resume?.(ok);
  };

  el.querySelector("[data-confirm-ok]")?.addEventListener("click", () => finish(true));
  el.querySelector("[data-confirm-cancel]")?.addEventListener("click", () => finish(false));
  // 点遮罩关闭：只有点在 dialog 自身（而不是内层卡片）时成立
  el.addEventListener("click", (e) => {
    if (e.target === el) finish(false);
  });
  // ESC：拦下默认 close，走同一条收尾路径，Promise 不会悬着
  el.addEventListener("cancel", (e) => {
    e.preventDefault();
    finish(false);
  });

  document.body.appendChild(el);
  injectStyle();
  dlg = el;
  return el;
}

/**
 * 弹出确认框，确认返回 true，取消 / 关闭 / ESC 返回 false。
 * 同一时刻只存在一个弹框，重复调用会把上一个按「取消」处理。
 */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  if (typeof document === "undefined") return Promise.resolve(false);

  const el = ensureDialog();

  // 上一个还没答复就被新调用顶掉：先关掉旧弹框再按取消收尾，
  // 否则下面 showModal() 会因为 dialog 已经 open 而抛 InvalidStateError
  if (settle) {
    const previous = settle;
    settle = null;
    if (el.open) el.close();
    previous(false);
  }

  const title = el.querySelector<HTMLElement>("[data-confirm-title]");
  const desc = el.querySelector<HTMLElement>("[data-confirm-desc]");
  const ok = el.querySelector<HTMLButtonElement>("[data-confirm-ok]");
  const cancel = el.querySelector<HTMLButtonElement>("[data-confirm-cancel]");

  if (title) title.textContent = opts.title;
  if (desc) {
    desc.textContent = opts.description ?? "";
    desc.classList.toggle("hidden", !opts.description);
  }
  if (ok) {
    ok.textContent = opts.confirmText ?? "确定";
    ok.className = OK_TONE[opts.tone ?? "default"];
  }
  if (cancel) cancel.textContent = opts.cancelText ?? "再想想";

  return new Promise<boolean>((resolve) => {
    settle = resolve;
    el.showModal();
    // 默认焦点落在「取消」上：危险操作不该被回车顺手确认掉
    cancel?.focus();
  });
}