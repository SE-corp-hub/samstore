"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import LabelSheet from "./LabelSheet";
import VariantEditor from "./VariantEditor";

export interface AdminProduct {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  barcode: string | null;
  unit: string | null;
  soldByWeight: boolean;
  priceMinor: number;
  costMinor: number;
  isActive: boolean;
  taxExempt: boolean;
  featured: boolean;
  tags: string[];
  related: { id: string; name: string; priceMinor: number; isActive: boolean }[];
  upsell: { id: string; name: string; priceMinor: number; isActive: boolean }[];
  category: { id: string; name: string; slug: string } | null;
  quantityOnHand: number;
  quantityReserved: number;
  availableQuantity: number;
  reorderThreshold: number;
  variants?: { id: string; name: string; sku: string; priceMinor: number; quantityOnHand: number; availableQuantity: number; isActive: boolean }[];
  addons?: { id: string; name: string; required: boolean; options: { id: string; name: string; priceMinor: number; isActive: boolean }[] }[];
}

interface ProductForm {
  name: string;
  sku: string;
  barcode: string;
  unit: string;
  soldByWeight: boolean;
  priceMinor: string; // pesos input, converted to minor units
  costMinor: string; // acquisition cost in pesos, converted to minor units
  stock: string;
  categorySlug: string;
  categoryName: string;
  description: string;
  /** M4: VAT-exempt product (basic/zero-rated goods). */
  taxExempt: boolean;
  /** P3d: merchandising — featured flag, tags (comma input), related/upsell id lists. */
  featured: boolean;
  tags: string;
  related: string[];
  upsell: string[];
  /** P3f: quantity-on-hand at/below which the item is flagged LOW stock. */
  reorderThreshold: string;
}

const EMPTY_FORM: ProductForm = { name: "", sku: "", barcode: "", unit: "", soldByWeight: false, priceMinor: "", costMinor: "", stock: "", categorySlug: "", categoryName: "", description: "", taxExempt: false, featured: false, tags: "", related: [], upsell: [], reorderThreshold: "" };

export default function ProductsPanel() {
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [categories, setCategories] = useState<{ id: string; slug: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<{ open: boolean; editing: AdminProduct | null }>({ open: false, editing: null });
  const [form, setForm] = useState<ProductForm>(EMPTY_FORM);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [saving, setSaving] = useState(false);
  // P7 filters
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [active, setActive] = useState("");
  const [sort, setSort] = useState<"created" | "name" | "price" | "stock">("created");
  // M3: batch label printing — the selected product ids open the 57 × 40 mm label sheet.
  const [selected, setSelected] = useState<string[]>([]);
  const [labelOpen, setLabelOpen] = useState(false);
  // P2c: variant + add-on management modal
  const [optionsFor, setOptionsFor] = useState<AdminProduct | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (search) q.set("search", search);
      if (categoryId) q.set("categoryId", categoryId);
      if (minPrice) q.set("minPrice", minPrice);
      if (maxPrice) q.set("maxPrice", maxPrice);
      if (active) q.set("active", active);
      const [pRes, cRes] = await Promise.all([
        fetch(`${API_URL}/admin/products?${q.toString()}`, { headers: adminHeaders() }),
                fetch(`${API_URL}/admin/products/categories`, { headers: adminHeaders() }),
      ]);
      if (!pRes.ok) throw new Error("Failed to load products");
      const p = await pRes.json();
      const c = await cRes.json();
      let rows: AdminProduct[] = p.products;
      if (sort === "name") rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
      else if (sort === "price") rows = [...rows].sort((a, b) => a.priceMinor - b.priceMinor);
      else if (sort === "stock") rows = [...rows].sort((a, b) => b.availableQuantity - a.availableQuantity);
      setProducts(rows);
      setCategories(c.categories);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [search, categoryId, minPrice, maxPrice, active, sort]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setCreatingCategory(false);
    setModal({ open: true, editing: null });
  };

  const openEdit = (p: AdminProduct) => {
    setForm({
      name: p.name,
      sku: p.sku,
      barcode: p.barcode ?? "",
      unit: p.unit ?? "",
      soldByWeight: p.soldByWeight ?? false,
      priceMinor: (p.priceMinor / 100).toString(),
      costMinor: (p.costMinor / 100).toString(),
      stock: p.quantityOnHand.toString(),
      categorySlug: p.category?.slug ?? "",
      categoryName: "",
      description: p.description ?? "",
      taxExempt: p.taxExempt ?? false,
      featured: p.featured ?? false,
      tags: (p.tags ?? []).join(", "),
      related: p.related?.filter((r) => r.isActive).map((r) => r.id) ?? [],
      upsell: p.upsell?.filter((r) => r.isActive).map((r) => r.id) ?? [],
      reorderThreshold: (p.reorderThreshold || 0).toString(),
    });
    setCreatingCategory(false);
    setModal({ open: true, editing: p });
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const priceMinor = Math.round(parseFloat(form.priceMinor) * 100);
      const payload = {
        name: form.name,
        sku: form.sku,
        barcode: form.barcode.trim() || null,
        unit: form.unit.trim() || null,
        soldByWeight: form.soldByWeight,
        priceMinor,
        costMinor: form.costMinor.trim() === "" ? undefined : Math.round(parseFloat(form.costMinor) * 100),
        stock: form.stock === "" ? undefined : parseInt(form.stock, 10),
        categorySlug: creatingCategory ? undefined : form.categorySlug || undefined,
        categoryName: !modal.editing && creatingCategory ? form.categoryName.trim() || undefined : undefined,
        description: form.description || undefined,
        taxExempt: form.taxExempt,
        featured: form.featured,
        tags: form.tags.split(",").map((t) => t.trim()).filter((t) => t.length > 0),
        reorderThreshold: form.reorderThreshold === "" ? undefined : parseInt(form.reorderThreshold, 10),
        ...(modal.editing
          ? { relatedProductIds: form.related, upsellProductIds: form.upsell }
          : {}),
      };
      const res = await fetch(
        `${API_URL}/admin/products${modal.editing ? `/${modal.editing.id}` : ""}`,
        {
          method: modal.editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json", ...adminHeaders() },
                    body: JSON.stringify(payload),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data?.errors?.join(", ") ?? data?.message ?? "Save failed");
        return;
      }
      setModal({ open: false, editing: null });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (p: AdminProduct) => {
    await fetch(`${API_URL}/admin/products/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
            body: JSON.stringify({ isActive: !p.isActive }),
    });
    await load();
  };

  const toPesos = (minor: number) => `₱${(minor / 100).toFixed(2)}`;

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h1 className="h4 mb-0">Products</h1>
                <div className="d-flex gap-2">
                  {selected.length > 0 && (
                    <button className="btn btn-outline-primary btn-sm" onClick={() => setLabelOpen(true)}>
                      <i className="bi bi-tags me-1"></i>Print labels ({selected.length})
                    </button>
                  )}
                  <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <i className="bi bi-plus-lg me-1"></i>New product
                  </button>
                  </div>
                </div>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

            {/* P7 filter bar */}
            <div className="row g-2 mb-3">
              <div className="col-md-3">
                <input className="form-control form-control-sm" placeholder="Search name / SKU (jump)…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <div className="col-md-2">
                <select className="form-select form-select-sm" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                  <option value="">All categories</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="col-md-2 d-flex gap-1">
                <input className="form-control form-control-sm" type="number" min="0" step="0.01" placeholder="Min ₱" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} />
                <input className="form-control form-control-sm" type="number" min="0" step="0.01" placeholder="Max ₱" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} />
              </div>
              <div className="col-md-2">
                <select className="form-select form-select-sm" value={active} onChange={(e) => setActive(e.target.value)}>
                  <option value="">All status</option>
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </div>
              <div className="col-md-3">
                <select className="form-select form-select-sm" value={sort} onChange={(e) => setSort(e.target.value as "created" | "name" | "price" | "stock")}>
                  <option value="created">Sort: newest</option>
                  <option value="name">Sort: name</option>
                  <option value="price">Sort: price</option>
                  <option value="stock">Sort: stock</option>
                </select>
              </div>
            </div>

            {loading ? (
        <p className="text-muted">Loading…</p>
      ) : products.length === 0 ? (
        <p className="text-muted">No products yet. Create your first one!</p>
      ) : (
        <table className="table table-hover align-middle">
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  className="form-check-input"
                  aria-label="Select all products"
                  checked={products.length > 0 && selected.length === products.length}
                  onChange={(e) => setSelected(e.target.checked ? products.map((p) => p.id) : [])}
                />
              </th>
              <th>Product</th>
              <th>SKU</th>
              <th className="text-end">Selling price</th>
              <th className="text-end">Unit cost</th>
              <th className="text-end">Stock</th>
              <th>Category</th>
              <th>Status</th>
              <th className="text-end">Actions</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} className={p.isActive ? "" : "table-secondary"}>
                <td>
                  <input
                    type="checkbox"
                    className="form-check-input"
                    aria-label={`Select ${p.name}`}
                    checked={selected.includes(p.id)}
                    onChange={(e) =>
                      setSelected((s) => (e.target.checked ? [...s, p.id] : s.filter((id) => id !== p.id)))
                    }
                  />
                </td>
                <td className="fw-semibold">
                    {p.name}
                    {p.unit && <span className="badge text-bg-light border ms-1">{p.unit}</span>}
                    {p.soldByWeight && <span className="badge text-bg-secondary ms-1" title="Sold by weight">per-kilo</span>}
                  </td>
                <td className="text-muted small">
                  {p.sku}
                  {p.barcode && <div className="text-muted text-opacity-75" style={{ fontSize: "0.8em" }} title="Barcode">{p.barcode}</div>}
                </td>
                <td className="text-end">{toPesos(p.priceMinor)}</td>
                <td className="text-end text-muted">{toPesos(p.costMinor)}</td>
                <td className={`text-end ${p.reorderThreshold > 0 && p.availableQuantity <= p.reorderThreshold ? "text-danger fw-semibold" : ""}`}>
                  {p.availableQuantity}
                  {p.reorderThreshold > 0 && <small className="text-muted"> ≤{p.reorderThreshold}</small>}
                  {p.quantityReserved > 0 && <small className="text-muted"> ({p.quantityReserved} reserved)</small>}
                </td>
                <td className="small">{p.category?.name ?? "—"}</td>
                <td>
                  <span className={`badge ${p.isActive ? "text-bg-success" : "text-bg-secondary"}`}>
                    {p.isActive ? "Active" : "Hidden"}
                      {p.taxExempt && <span className="badge text-bg-info ms-1" title="VAT-exempt">VAT-exempt</span>}
                  </span>
                </td>
                <td className="text-end">
                  <button className="btn btn-sm btn-outline-secondary me-1" title="Variants & add-ons" onClick={() => setOptionsFor(p)}>
                    <i className="bi bi-sliders"></i>
                  </button>
                  <button className="btn btn-sm btn-outline-secondary me-1" onClick={() => openEdit(p)}>
                    <i className="bi bi-pencil"></i>
                  </button>
                  <button className="btn btn-sm btn-outline-secondary" onClick={() => toggleActive(p)}>
                    <i className={`bi ${p.isActive ? "bi-eye-slash" : "bi-eye"}`}></i>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Create/Edit modal */}
      {modal.open && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog">
              <div className="modal-content">
                <form onSubmit={save}>
                  <div className="modal-header">
                    <h5 className="modal-title">{modal.editing ? "Edit product" : "New product"}</h5>
                    <button type="button" className="btn-close" onClick={() => setModal({ open: false, editing: null })}></button>
                  </div>
                  <div className="modal-body">
                    <div className="mb-2">
                      <label className="form-label small">Name *</label>
                      <input className="form-control" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                    </div>
                    <div className="mb-2">
                      <label className="form-label small">SKU *</label>
                      <input className="form-control" required value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
                    </div>
                    <div className="row">
                      <div className="col-6 mb-2">
                        <label className="form-label small">Barcode</label>
                        <input className="form-control" placeholder="e.g. 4801234567890" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} />
                      </div>
                      <div className="col-6 mb-2">
                        <label className="form-label small">Unit</label>
                        <input className="form-control" placeholder="pc · pack · kilo · bottle" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
                      </div>
                    </div>
                    <div className="form-check form-switch mb-2">
                      <input className="form-check-input" type="checkbox" id="soldByWeight" checked={form.soldByWeight} onChange={(e) => setForm({ ...form, soldByWeight: e.target.checked })} />
                      <label className="form-check-label small" htmlFor="soldByWeight">Sold per weight (kilo) <span className="text-muted">— decimal quantity on a future module; pricing stays per-unit for now</span></label>
                    </div>
                    <div className="row">
                      <div className="col-6 mb-2">
                        <label className="form-label small" htmlFor="productSellingPrice">Selling price (₱) per unit *</label>
                        <input id="productSellingPrice" className="form-control" required type="number" step="0.01" min="0" value={form.priceMinor} onChange={(e) => setForm({ ...form, priceMinor: e.target.value })} />
                      </div>
                      <div className="col-6 mb-2">
                        <label className="form-label small" htmlFor="productUnitCost">Unit acquisition cost (₱)</label>
                        <input id="productUnitCost" className="form-control" type="number" step="0.01" min="0" value={form.costMinor} onChange={(e) => setForm({ ...form, costMinor: e.target.value })} />
                        <small className="text-muted">Purchases update this to the latest received cost.</small>
                      </div>
                    </div>
                    <div className="row">
                      <div className="col-6 mb-2">
                        <label className="form-label small">Opening stock</label>
                        <input className="form-control" type="number" min="0" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} />
                      </div>
                      <div className="col-6 mb-2">
                        <label className="form-label small">Reorder at</label>
                        <input className="form-control" type="number" min="0" placeholder="0" title="Flag LOW stock at or below this on-hand qty" value={form.reorderThreshold} onChange={(e) => setForm({ ...form, reorderThreshold: e.target.value })} />
                      </div>
                    </div>
                    <div className="mb-2">
                      <label className="form-label small">Category</label>
                      {creatingCategory && !modal.editing ? (
                        <div className="input-group">
                          <input className="form-control" autoFocus required maxLength={80} placeholder="New category name" value={form.categoryName} onChange={(e) => setForm({ ...form, categoryName: e.target.value })} />
                          <button type="button" className="btn btn-outline-secondary" onClick={() => { setCreatingCategory(false); setForm({ ...form, categoryName: "" }); }}>Choose existing</button>
                        </div>
                      ) : (
                        <>
                          <select className="form-select" value={form.categorySlug} onChange={(e) => setForm({ ...form, categorySlug: e.target.value })}>
                            <option value="">— none —</option>
                            {categories.map((c) => (
                              <option key={c.id} value={c.slug}>{c.name}</option>
                            ))}
                          </select>
                          {!modal.editing && <button type="button" className="btn btn-link btn-sm px-0" onClick={() => { setCreatingCategory(true); setForm({ ...form, categorySlug: "", categoryName: "" }); }}>+ Create category</button>}
                        </>
                      )}
                    </div>
                    <div className="mb-2">
                      <label className="form-label small">Description</label>
                      <textarea className="form-control" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                    <div className="form-check form-switch mt-2">
                      <input className="form-check-input" type="checkbox" id="taxExempt" checked={form.taxExempt} onChange={(e) => setForm({ ...form, taxExempt: e.target.checked })} />
                      <label className="form-check-label" htmlFor="taxExempt">VAT-exempt product <span className="text-muted small">(basic/zero-rated goods — reported as non-VAT sales on the BIR slip)</span></label>
                    </div>
                    </div>
                    {/* P3d: merchandising */}
                    <div className="form-check form-switch mb-2">
                      <input className="form-check-input" type="checkbox" id="featured" checked={form.featured} onChange={(e) => setForm({ ...form, featured: e.target.checked })} />
                      <label className="form-check-label" htmlFor="featured">Featured <span className="text-muted small">(show in the storefront "Featured" section)</span></label>
                    </div>
                    <div className="mb-2">
                      <label className="form-label small">Tags</label>
                      <input className="form-control" placeholder="new, best seller" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
                      <small className="text-muted d-block">Comma-separated display tags.</small>
                    </div>
                    {modal.editing && (
                      <div className="mb-2">
                        <label className="form-label small">Related / upsell</label>
                        <div className="d-flex gap-2">
                          <select className="form-select form-select-sm" multiple size={4} value={form.related} onChange={(e) => setForm({ ...form, related: [...e.target.selectedOptions].map((o) => o.value) })}>
                            {products.filter((x) => x.id !== modal.editing?.id).map((x) => (
                              <option key={x.id} value={x.id}>{x.name}</option>
                            ))}
                          </select>
                          <select className="form-select form-select-sm" multiple size={4} value={form.upsell} onChange={(e) => setForm({ ...form, upsell: [...e.target.selectedOptions].map((o) => o.value) })}>
                            {products.filter((x) => x.id !== modal.editing?.id).map((x) => (
                              <option key={x.id} value={x.id}>{x.name}</option>
                            ))}
                          </select>
                        </div>
                        <small className="text-muted d-block">Left = "You may also like", right = "Upgrade". Ctrl/Cmd-click to select multiple.</small>
                      </div>
                    )}
                  </div>
                  <div className="modal-footer">
                    <button type="button" className="btn btn-outline-secondary" onClick={() => setModal({ open: false, editing: null })}>Cancel</button>
                    <button className="btn btn-primary" type="submit" disabled={saving}>
                      {saving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}
      {labelOpen && <LabelSheet productIds={selected} onClose={() => setLabelOpen(false)} />}
      {optionsFor && (
        <VariantEditor
          product={optionsFor as unknown as Parameters<typeof VariantEditor>[0]["product"]}
          onClose={() => setOptionsFor(null)}
          onChanged={() => { setOptionsFor(null); void load(); }}
        />
      )}
    </div>
  );
}
