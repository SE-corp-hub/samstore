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
  // Built with DOM nodes + textContent: the message often contains names people
  // typed (stores, products, customers), so it must never be parsed as HTML.
  const row = document.createElement("div");
  row.className = "d-flex";
  const body = document.createElement("div");
  body.className = "toast-body";
  const icon = document.createElement("i");
  icon.className = `bi ${tone === "success" ? "bi-check-circle" : "bi-exclamation-triangle"} me-1`;
  icon.setAttribute("aria-hidden", "true");
  body.append(icon, document.createTextNode(String(message)));
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn-close btn-close-white me-2 m-auto";
  close.setAttribute("aria-label", "Close");
  row.append(body, close);
  el.appendChild(row);
  container.appendChild(el);
  const dismiss = () => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); };
  el.querySelector("button")?.addEventListener("click", dismiss);
  setTimeout(dismiss, 2600);
}