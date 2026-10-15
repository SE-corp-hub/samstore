"use client";

// Rice Ops M10 — the Taglish / English switch. Taglish is the default (the staff's own
// words); English is one tap away. One name per action everywhere (plan "Words used").
// The choice is remembered on this phone only.

import { useCallback, useEffect, useState } from "react";

export type Lang = "tl" | "en";
const KEY = "rice-lang";
const EVENT = "rice-lang";

const WORDS: Record<string, [tl: string, en: string]> = {
  // navigation
  "nav.benta": ["Benta", "Sell"],
  "nav.utangrice": ["Utang", "Credit"],
  "nav.agentorders": ["Order ng agent", "Agent orders"],
  "nav.agent": ["Bagong order (agent)", "New order (agent)"],
  "nav.approvals": ["Para sa iyo", "For your approval"],
  "nav.trips": ["Lipat at Ilabas", "Transfers & releases"],
  "nav.resack": ["Resack", "Resack"],
  "nav.pasok": ["Pasok at Susuriin", "Stock in & review"],
  "nav.bilangin": ["Bilangin", "Count"],
  "nav.ulat": ["Ulat at Pagsasara", "Reports & closing"],
  "nav.drafts": ["Tapusin", "To finish"],
  "nav.kargadors": ["Kargadors", "Porters"],
  // shared steps
  "step.of": ["Hakbang {n} sa {total}", "Step {n} of {total}"],
  "btn.back": ["Bumalik", "Back"],
  "btn.next": ["Susunod", "Next"],
  "btn.done": ["Tapos", "Done"],
  "btn.wait": ["Sandali…", "Please wait…"],
  "btn.yesSign": ["Oo, pipirma", "Yes, sign"],
  "sign.of": ["Pirma ni {who}", "Signature of {who}"],
  "sign.clear": ["Burahin", "Clear"],
  "sign.readBack": ["Tama ba? Pipirma ang {who} sa phone na ito.", "Is this right? {who} will sign on this phone."],
  "sign.noCustomer": ["Walang pirma ng customer (nasa papel)", "No customer signature (on the paper slip)"],
  "count.question": ["May natira pa ba?", "Is there any left?"],
  "count.none": ["Wala na talaga", "None left"],
  "count.save": ["I-save ang bilang", "Save the count"],
  // weak signal
  "queue.waiting": ["Naghihintay ipadala", "Waiting to send"],
  "queue.failed": ["Hindi naipadala", "Not sent"],
  "queue.sendNow": ["Ipadala ngayon", "Send now"],
  "queue.clear": ["Alisin sa listahan", "Clear the list"],
  "queue.queuedToast": ["Walang signal — naka-save sa phone, ipapadala pagbalik ng signal", "No signal — saved on this phone, it will be sent when the signal returns"],
  "lang.switch": ["English", "Taglish"],
};

function current(): Lang {
  try {
    return window.localStorage.getItem(KEY) === "en" ? "en" : "tl";
  } catch {
    return "tl";
  }
}

/** The word for a key in a language, with {placeholders} filled. Unknown keys show the key. */
export function word(lang: Lang, key: string, vars: Record<string, string | number> = {}): string {
  const w = WORDS[key];
  let text = w ? w[lang === "en" ? 1 : 0] : key;
  for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v));
  return text;
}

export function useLang() {
  const [lang, setLang] = useState<Lang>("tl");
  useEffect(() => {
    setLang(current());
    const on = () => setLang(current());
    window.addEventListener(EVENT, on);
    window.addEventListener("storage", on);
    return () => { window.removeEventListener(EVENT, on); window.removeEventListener("storage", on); };
  }, []);
  const toggle = useCallback(() => {
    const next: Lang = current() === "en" ? "tl" : "en";
    try { window.localStorage.setItem(KEY, next); } catch { /* per-phone convenience only */ }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  const t = useCallback((key: string, vars?: Record<string, string | number>) => word(lang, key, vars), [lang]);
  return { lang, t, toggle };
}

export const LANG_WORDS = WORDS;
