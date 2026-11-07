"use client";

// The product form's "Picture" field: take a photo with the tablet's camera or choose one from the
// gallery, see it as it will look, or take it off. The picture is shrunk on the tablet first
// (lib/product-photo.ts) and uploaded when the product is saved.

import { useRef, useState } from "react";
import { photoUrl, shrinkPhoto } from "../../lib/product-photo";

/** keep = no change; new = this picture (data: address) on Save; remove = take it off on Save. */
export type PhotoChange = { kind: "keep" } | { kind: "new"; dataUrl: string } | { kind: "remove" };

export default function PhotoPicker({ photoKey, value, onChange, disabled = false }: {
  /** The picture the product has now. */
  photoKey?: string | null;
  value: PhotoChange;
  onChange: (v: PhotoChange) => void;
  disabled?: boolean;
}) {
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const shown = value.kind === "new" ? value.dataUrl : value.kind === "remove" ? null : photoUrl(photoKey);

  const picked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // the same picture can be picked again
    if (!file) return;
    setErr(null);
    setBusy(true);
    try {
      onChange({ kind: "new", dataUrl: await shrinkPhoto(file) });
    } catch (x) {
      setErr(x instanceof Error ? x.message : "This picture cannot be used — try another one");
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="photo-picker mb-3" disabled={disabled || busy}>
      <legend className="form-label mb-1">Picture <span className="text-muted fw-normal">(optional — helps find it on POS and Pre-order)</span></legend>
      <div className="d-flex align-items-center gap-3 flex-wrap">
        <div className="photo-preview" aria-live="polite">
          {shown ? <img src={shown} alt="The product's picture" /> : <span className="text-muted text-center"><i className="bi bi-image d-block fs-3" aria-hidden="true"></i>No picture</span>}
        </div>
        <div className="d-flex flex-column gap-2">
          <button type="button" className="btn btn-outline-primary" onClick={() => camera.current?.click()}>
            <i className="bi bi-camera me-1" aria-hidden="true"></i>{busy ? "Getting the picture…" : "Take photo"}
          </button>
          <button type="button" className="btn btn-outline-primary" onClick={() => gallery.current?.click()}>
            <i className="bi bi-images me-1" aria-hidden="true"></i>Choose picture
          </button>
          {shown && (
            <button type="button" className="btn btn-outline-danger" onClick={() => onChange(photoKey ? { kind: "remove" } : { kind: "keep" })}>
              <i className="bi bi-trash me-1" aria-hidden="true"></i>Remove picture
            </button>
          )}
          {value.kind === "remove" && photoKey && (
            <button type="button" className="btn btn-outline-dark" onClick={() => onChange({ kind: "keep" })}>Keep the old picture</button>
          )}
        </div>
      </div>
      {value.kind !== "keep" && <div className="form-text">Saved when you tap Save.</div>}
      {err && <div className="text-danger mt-1" role="alert">{err}</div>}
      <input ref={camera} type="file" accept="image/*" capture="environment" className="d-none" onChange={picked} tabIndex={-1} aria-hidden="true" />
      <input ref={gallery} type="file" accept="image/*" className="d-none" onChange={picked} tabIndex={-1} aria-hidden="true" />
    </fieldset>
  );
}
