"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";

interface LinkData {
  id: string;
  name: string;
  slug: string;
  publicLink: { slug: string; token: string; status: string } | null;
  accentColor: string | null;
  bannerText: string | null;
  shareMessage: string | null;
  logoUrl: string | null;
}

export default function StoreLinkPanel() {
  const [data, setData] = useState<LinkData | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [accentColor, setAccentColor] = useState("#d94f2b");
  const [bannerText, setBannerText] = useState("");
  const [shareMessage, setShareMessage] = useState("");
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load store link settings");
      const d = await res.json();
      setData(d);
      setAccentColor(d.accentColor ?? "#d94f2b");
      setBannerText(d.bannerText ?? "");
      setShareMessage(d.shareMessage ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const link = data?.publicLink ? `${window.location.origin}/${data.slug}?token=${encodeURIComponent(data.publicLink.token)}` : null;

  useEffect(() => {
    if (!link) return;
    QRCode.toDataURL(link, { width: 220, margin: 1, color: { dark: "#000", light: "#fff" } })
      .then((url) => setQr(url))
      .catch(() => setQr(null));
  }, [link]);

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  const share = async () => {
    if (!link || !data) return;
    const text = shareMessage || `Order from ${data.name} — fresh favorites delivered to your door!`;
    const url = link;
    if (typeof navigator !== "undefined" && "share" in navigator) {
      try { await navigator.share({ title: data.name, text, url }); return; } catch { /* fall through */ }
    }
    await copy();
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/store-link`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({
          accentColor,
          bannerText: bannerText || null,
          shareMessage: shareMessage || null,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d?.message ?? "Save failed");
        return;
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const uploadLogo = async (file: File) => {
    if (file.size > 300 * 1024) { setError("Logo must be under 300 KB (we store small base64)."); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const b64 = String(reader.result);
      const res = await fetch(`${API_URL}/admin/store-link`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ logoUrl: b64 }),
      });
      if (res.ok) await load();
      else setError("Logo upload failed");
    };
    reader.readAsDataURL(file);
  };

  const rotate = async () => {
    if (!window.confirm("Rotate the store link? Everyone with the CURRENT link will need the new one.")) return;
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/store-link/rotate`, {
        method: "POST",
        headers: adminHeaders(),
      });
      if (!res.ok) { const d = await res.json(); setError(d?.message ?? "Rotate failed"); return; }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rotate failed");
    }
  };

  const revoke = async () => {
    if (!window.confirm("Revoke the store link? The storefront will stop loading until you regenerate it.")) return;
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/store-link/revoke`, {
        method: "POST",
        headers: adminHeaders(),
      });
      if (!res.ok) { const d = await res.json(); setError(d?.message ?? "Revoke failed"); return; }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revoke failed");
    }
  };

  return (
    <div>
      <h1 className="h4 mb-3"><i className="bi bi-link-45deg me-2"></i>Store Link</h1>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}
      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : !data ? (
        <p className="text-muted">Store not found.</p>
      ) : (
        <>
          <div className="row g-3">
            <div className={`${link ? "col-md-6" : "col-md-12"}`}>
              <div className="card h-100">
                <div className="card-body">
                  <h5 className="card-title small fw-bold text-uppercase text-muted">Public link</h5>
                  {link ? (
                    <>
                      <div className="input-group mb-2">
                        <input className="form-control form-control-sm" readOnly value={link} />
                        <button className="btn btn-outline-secondary btn-sm" onClick={copy}>
                          <i className={`bi ${copied ? "bi-check-lg" : "bi-clipboard"}`}></i>
                        </button>
                      </div>
                      <div className="d-flex gap-2">
                        <button className="btn btn-sm btn-primary" onClick={share}>
                          <i className="bi bi-share me-1"></i>Share
                        </button>
                        <a className="btn btn-sm btn-outline-secondary" href={link} target="_blank" rel="noreferrer">
                          <i className="bi bi-box-arrow-up-right me-1"></i>Open store
                        </a>
                      </div>
                      <div className="d-flex gap-2 mt-2">
                        <button className="btn btn-sm btn-outline-warning" onClick={rotate} title="Generate a new link token (old link stops working)">
                          <i className="bi bi-arrow-repeat me-1"></i>Regenerate link
                        </button>
                        <button className="btn btn-sm btn-outline-danger" onClick={revoke} title="Stop the storefront from loading">
                          <i className="bi bi-x-octagon me-1"></i>Revoke link
                        </button>
                      </div>
                      {data.publicLink?.status === "REVOKED" && (
                        <div className="alert alert-warning py-1 px-2 small mb-1 mt-2">
                          <i className="bi bi-exclamation-triangle me-1"></i>This link is <strong>revoked</strong> — regenerate to reopen the store.
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-muted small mb-0">No public link configured.</p>
                  )}
                </div>
              </div>
            </div>
            {link && qr && (
              <div className="col-md-6">
                <div className="card h-100">
                  <div className="card-body text-center">
                    <h5 className="card-title small fw-bold text-uppercase text-muted">QR code</h5>
                    <img src={qr} alt="Store QR" width="220" height="220" className="img-fluid" />
                    <p className="small text-muted mt-1 mb-0">Scan to open the store on any phone.</p>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="card mt-3">
            <div className="card-body">
              <h5 className="card-title h6">Branding</h5>
              <div className="row g-2">
                <div className="col-md-3">
                  <label className="form-label small">Accent color</label>
                  <div className="d-flex align-items-center gap-2">
                    <input type="color" className="form-control form-control-color" value={accentColor} onChange={(e) => setAccentColor(e.target.value)} style={{ width: 46 }} />
                    <input className="form-control form-control-sm" value={accentColor} onChange={(e) => setAccentColor(e.target.value)} />
                  </div>
                </div>
                <div className="col-md-4">
                  <label className="form-label small">Banner text (shown on storefront)</label>
                  <input className="form-control form-control-sm" value={bannerText} onChange={(e) => setBannerText(e.target.value)} placeholder="e.g. Free delivery over ₱500" />
                </div>
                <div className="col-md-5">
                  <label className="form-label small">Share message</label>
                  <input className="form-control form-control-sm" value={shareMessage} onChange={(e) => setShareMessage(e.target.value)} placeholder="e.g. Order from us — no app, no sign-up" />
                </div>
              </div>
              <div className="row g-2 mt-1">
                <div className="col-md-6">
                  <label className="form-label small">Logo</label>
                  <div className="d-flex align-items-center gap-2">
                    <input className="form-control form-control-sm" type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && uploadLogo(e.target.files[0])} />
                    {data.logoUrl && <img src={data.logoUrl} alt="logo" height="32" className="rounded" />}
                  </div>
                </div>
              </div>
              <div className="mt-3">
                <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
                  {saving ? "Saving…" : "Save branding"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}