/**
 * 轻量提示条：fixed 定位在视口顶部，不依赖页面里是否存在提示容器。
 *
 * 页面内的 #pricing-notice / #acct-notice 在按钮下方，用户点完按钮视线还在按钮上，
 * 很容易整条提示落在屏幕外，所以下单相关的反馈统一走这里。
 */

let hideTimer = 0;

function dismiss(el: HTMLElement) {
  el.style.opacity = "0";
  el.style.transform = "translateX(-50%) translateY(-8px)";
}

export function showToast(text: string, duration = 6000) {
  if (typeof document === "undefined") return;

  let host = document.getElementById("hzn-toast");
  if (!host) {
    const el = document.createElement("div");
    el.id = "hzn-toast";
    el.setAttribute("role", "alert");
    el.setAttribute("aria-live", "assertive");
    const s = el.style;
    s.position = "fixed";
    s.top = "16px";
    s.left = "50%";
    s.transform = "translateX(-50%) translateY(-8px)";
    s.zIndex = "9999";
    s.maxWidth = "min(92vw, 560px)";
    s.padding = "10px 18px";
    s.borderRadius = "10px";
    s.background = "rgba(17, 24, 39, 0.95)";
    s.color = "#fff";
    s.fontSize = "14px";
    s.lineHeight = "1.6";
    s.textAlign = "center";
    s.boxShadow = "0 12px 32px rgba(0, 0, 0, 0.28)";
    s.opacity = "0";
    s.transition = "opacity .18s ease, transform .18s ease";
    s.cursor = "pointer";
    el.addEventListener("click", () => dismiss(el));
    document.body.appendChild(el);
    host = el;
  }

  host.textContent = text;
  const target = host;
  requestAnimationFrame(() => {
    target.style.opacity = "1";
    target.style.transform = "translateX(-50%) translateY(0)";
  });

  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    const el = document.getElementById("hzn-toast");
    if (el) dismiss(el);
  }, duration);
}

/** 立即收起（切换页面或开始新操作时清理残留） */
export function hideToast() {
  const el = document.getElementById("hzn-toast");
  if (el) dismiss(el);
}