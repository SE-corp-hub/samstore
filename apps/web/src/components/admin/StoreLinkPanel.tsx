"use client";

// Store Link: the customers' shop address and its QR code. One state at a time — the link is ON (share it,
// print the QR) or it is OFF (one button switches it on with a new link). Plain words: no "token", "rotate" or "revoke".
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { askConfirm } from "../../lib/ask";
import { shopLinkOn, shopLinkUrl } from "../../lib/shop-link";

interface LinkData {
  id: string;
  name: string;
  slug: string;
  publicLink: { slug: string; token: string; status: string } | null;
  accentColor: string | null;
  bannerText: string | null;
  shareMessage: string | null;
  logoUrl: string | null;
  settings?: { allowGuestOrders?: boolean; orderingPaused?: boolean };
}

const DEFAULT_COLOR = "#d94f2b";

async function messageOf(res: Response, fallback: string): Promise<string> {
  try { const d = await res.json(); return typeof d?.message === "string" ? d.message : fallback; } catch { return fallback; }
}

export default function StoreLinkPanel() {
  const [data, setData] = useState<LinkData | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "save" | "link" | "logo">("");
  const [accentColor, setAccentColor] = useState(DEFAULT_COLOR);
  const [bannerText, setBannerText] = useState("");
  const [shareMessage, setShareMessage] = useState("");

  const load = async () => {
    try {
      const res = await fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Could not load the shop link. Check the internet and try again.");
      const d: LinkData = await res.json();
      setData(d);
      setAccentColor(d.accentColor ?? DEFAULT_COLOR);
      setBannerText(d.bannerText ?? "");
      setShareMessage(d.shareMessage ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the shop link.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const on = shopLinkOn(data?.publicLink);
  const link = data?.publicLink && on ? shopLinkUrl(data.publicLink) : null;

  useEffect(() => {
    if (!link) { setQr(null); return; }
    QRCode.toDataURL(link, { width: 440, margin: 2, color: { dark: "#000", light: "#fff" } })
      .then((url) => setQr(url))
      .catch(() => setQr(null));
  }, [link]);

  const say = (text: string) => { setNotice(text); window.setTimeout(() => setNotice((n) => (n === text ? null : n)), 4000); };

  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); say("Link copied. Paste it in Messenger or a text."); }
    catch { setError("Could not copy. Press and hold the link above, then choose Copy."); }
  };

  const share = async () => {
    if (!link || !data) return;
    const text = shareMessage || `Order rice from ${data.name}. No app needed.`;
    if (typeof navigator !== "undefined" && "share" in navigator) {
      try { await navigator.share({ title: data.name, text, url: link }); return; } catch { /* closed or not allowed: copy instead */ }
    }
    await copy();
  };

  const patch = async (body: Record<string, unknown>, what: "save" | "logo", done: string) => {
    setBusy(what);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/store-link`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify(body),
      });
      if (!res.ok) { setError(await messageOf(res, "Could not save. Try again.")); return; }
      await load();
      say(done);
    } catch {
      setError("Could not save. Check the internet and try again.");
    } finally {
      setBusy("");
    }
  };

  const save = () => patch({ accentColor, bannerText: bannerText.trim() || null, shareMessage: shareMessage.trim() || null }, "save", "Saved. The shop shows it now.");

  const uploadLogo = (file: File) => {
    if (file.size > 300 * 1024) { setError("That picture is too big. Choose a small logo (under 300 KB)."); return; }
    const reader = new FileReader();
    reader.onload = () => { void patch({ logoUrl: String(reader.result) }, "logo", "Logo saved."); };
    reader.onerror = () => setError("Could not read that picture. Choose another one.");
    reader.readAsDataURL(file);
  };

  const linkAction = async (path: "rotate" | "revoke", done: string) => {
    setBusy("link");
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/store-link/${path}`, { method: "POST", headers: adminHeaders() });
      if (!res.ok) { setError(await messageOf(res, "That did not work. Try again.")); return; }
      await load();
      say(done);
    } catch {
      setError("That did not work. Check the internet and try again.");
    } finally {
      setBusy("");
    }
  };

  const switchOn = () => linkAction("rotate", "The shop link is on. Share the new link and print the new QR code.");

  const makeNew = async () => {
    if (!(await askConfirm("Make a new shop link? The old link and every printed QR code stop working. You will need to share the new link again.", { ok: "Make a new link", cancel: "Keep this link" }))) return;
    await linkAction("rotate", "New link made. Share it again and print the new QR code.");
  };

  const switchOff = async () => {
    if (!(await askConfirm("Switch the shop link off? Customers who open the link or scan the QR code will see \"Store not found\" until you switch it on again.", { ok: "Switch it off", cancel: "Keep it on", danger: true }))) return;
    await linkAction("revoke", "The shop link is off.");
  };

  const changed = !!data && (accentColor !== (data.accentColor ?? DEFAULT_COLOR) || bannerText !== (data.bannerText ?? "") || shareMessage !== (data.shareMessage ?? ""));
  const closedNow = !!data?.settings?.orderingPaused;
  const guestsOff = data?.settings?.allowGuestOrders === false;

  return (
    <div className="store-link">
      <h1 className="h3 mb-1">Store Link</h1>
      <p className="mb-3">The web address and QR code your customers use to order from their own phone.</p>
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      <div role="status" aria-live="polite">{notice && <div className="alert alert-success">{notice}</div>}</div>
      {loading ? (
        <p role="status">Loading…</p>
      ) : !data ? null : !data.publicLink ? (
        <div className="alert alert-warning">This store has no shop link yet. Ask for one to be set up.</div>
      ) : !on ? (
        <div className="border rounded-3 p-3 mb-3" style={{ background: "#FFF3D6", borderColor: "#8A5A00" }}>
          <h2 className="h5 mb-1"><i className="bi bi-pause-circle me-2" aria-hidden="true"></i>The shop link is switched off</h2>
          <p className="mb-3">Customers who open the old link or scan an old QR code see “Store not found”. Switching it on makes a new link: share the new one and print the new QR code.</p>
          <button type="button" className="btn btn-success btn-lg" onClick={() => void switchOn()} disabled={busy !== ""}>
            <i className="bi bi-play-circle me-2" aria-hidden="true"></i>{busy === "link" ? "Switching on…" : "Switch the shop link on"}
          </button>
        </div>
      ) : (
        <>
          {(closedNow || guestsOff) && (
            <div className="alert alert-warning" role="status">
              <strong>The link works, but customers cannot order right now.</strong>{" "}
              {closedNow ? "“Close the shop for now” is on." : "“Customers can order without an account” is off."} Change it in Settings, Online shop.
            </div>
          )}
          <div className="row g-3 mb-3">
            <div className="col-12 col-md-7">
              <div className="border rounded-3 p-3 bg-white h-100">
                <h2 className="h5 mb-2">Your shop link <span className="badge text-bg-success ms-1">On</span></h2>
                <label className="form-label" htmlFor="shop-link-box">Send this to customers</label>
                <input id="shop-link-box" className="form-control form-control-lg mb-3" style={{ fontSize: "1rem" }} readOnly value={link ?? ""} onFocus={(e) => e.currentTarget.select()} />
                <div className="d-flex flex-wrap gap-2">
                  <button type="button" className="btn btn-success btn-lg" onClick={() => void share()}>
                    <i className="bi bi-share me-2" aria-hidden="true"></i>Share link
                  </button>
                  <button type="button" className="btn btn-outline-primary" onClick={() => void copy()}>
                    <i className="bi bi-clipboard me-2" aria-hidden="true"></i>Copy link
                  </button>
                  <a className="btn btn-outline-primary d-inline-flex align-items-center" href={link ?? "#"} target="_blank" rel="noreferrer">
                    <i className="bi bi-box-arrow-up-right me-2" aria-hidden="true"></i>Open shop
                  </a>
                </div>
              </div>
            </div>
            <div className="col-12 col-md-5">
              <div className="border rounded-3 p-3 bg-white h-100 text-center">
                <h2 className="h5 mb-2">QR code</h2>
                {qr ? (
                  <>
                    <img src={qr} alt="QR code of the shop link" width={220} height={220} className="img-fluid" />
                    <p className="mb-2">Customers point their phone camera at it.</p>
                    <a className="btn btn-outline-primary d-inline-flex align-items-center" href={qr} download={`${data.slug}-shop-qr.png`}>
                      <i className="bi bi-download me-2" aria-hidden="true"></i>Save QR picture
                    </a>
                  </>
                ) : <p role="status">Making the QR code…</p>}
              </div>
            </div>
          </div>

          <div className="border rounded-3 p-3 bg-white mb-3">
            <h2 className="h5 mb-3">How the shop looks</h2>
            <div className="row g-3">
              <div className="col-12 col-md-6">
                <label className="form-label" htmlFor="shop-banner">Line at the top of the shop <span className="text-muted">(not needed)</span></label>
                <input id="shop-banner" className="form-control form-control-lg" maxLength={120} value={bannerText} onChange={(e) => setBannerText(e.target.value)} placeholder="Example: Free delivery in Lipa" />
              </div>
              <div className="col-12 col-md-6">
                <label className="form-label" htmlFor="shop-share">Message sent with the link <span className="text-muted">(not needed)</span></label>
                <input id="shop-share" className="form-control form-control-lg" maxLength={200} value={shareMessage} onChange={(e) => setShareMessage(e.target.value)} placeholder="Example: Order rice from us, no app needed" />
              </div>
              <div className="col-12 col-md-6">
                <label className="form-label" htmlFor="shop-color">Shop colour</label>
                <div className="d-flex align-items-center gap-2">
                  <input id="shop-color" type="color" className="form-control form-control-color" value={accentColor} onChange={(e) => setAccentColor(e.target.value)} style={{ width: 64, height: 48 }} />
                  <span className="text-muted">Tap the box to choose. It colours the buttons and the top line.</span>
                </div>
              </div>
              <div className="col-12 col-md-6">
                <label className="form-label" htmlFor="shop-logo">Logo <span className="text-muted">(small picture)</span></label>
                <div className="d-flex align-items-center gap-2">
                  <input id="shop-logo" className="form-control form-control-lg" style={{ fontSize: "1rem" }} type="file" accept="image/*" disabled={busy !== ""} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo(f); e.target.value = ""; }} />
                  {data.logoUrl && <img src={data.logoUrl} alt="Logo now" height={48} className="rounded border" />}
                </div>
                {busy === "logo" && <div role="status" className="mt-1">Saving the logo…</div>}
              </div>
            </div>
            <button type="button" className="btn btn-primary btn-lg mt-3" onClick={() => void save()} disabled={!changed || busy !== ""}>
              {busy === "save" ? "Saving…" : changed ? "Save changes" : "Nothing to save"}
            </button>
          </div>

          <details className="border rounded-3 bg-white">
            <summary className="p-3 fw-semibold" style={{ minHeight: 48 }}>Stop or replace the link</summary>
            <div className="px-3 pb-3">
              <p>Use these only when the link went to the wrong people, or you want to stop online orders from this link. To pause orders for a day, use “Close the shop for now” in Settings, Online shop instead: the link stays the same.</p>
              <div className="d-flex flex-wrap gap-2">
                <button type="button" className="btn btn-outline-dark" onClick={() => void makeNew()} disabled={busy !== ""}>
                  <i className="bi bi-arrow-repeat me-2" aria-hidden="true"></i>Make a new link
                </button>
                <button type="button" className="btn btn-outline-danger" onClick={() => void switchOff()} disabled={busy !== ""}>
                  <i className="bi bi-x-octagon me-2" aria-hidden="true"></i>Switch the link off
                </button>
              </div>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
