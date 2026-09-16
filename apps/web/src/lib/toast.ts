"use client";

// Tiny global toast helper — success flash messages. Usage: toast("Saved ✓")

let container: HTMLDivElement | null = null;

export function toast(message: string, tone: "success" | "danger" = "success") {
  if (typeof window === "undefined") return;
  if (!container) {
    container = document.createElement("div");
    container.className = "toast-container position-fixed top-0 end-0 p-3";
    container.style.zIndex = "1090";
    document.body.appendChild(container);
  }
  const el = document.createElement("div");
  el.className = "toast align-items-center text-bg-" + (tone === "success" ? "success" : "danger") + " border-0 show";
  el.setAttribute("role", "alert");
  el.innerHTML = `<div class="d-flex"><div class="toast-body"><i class="bi ${tone === "success" ? "bi-check-circle" : "bi-exclamation-triangle"} me-1"></i>${message}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
  container.appendChild(el);
  const dismiss = () => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); };
  el.querySelector("button")?.addEventListener("click", dismiss);
  setTimeout(dismiss, 2600);
}