"use client";

import { useEffect, useState } from "react";
import type { ProductDTO } from "../types";
import { peso } from "../lib/number-format";
import { photoUrl } from "../lib/product-photo";

const toPesos = (minor: number) => peso(minor);

interface ProductCardProps {
  product: ProductDTO;
  onAdd: (product: ProductDTO) => void;
}

export default function ProductCard({ product, onAdd }: ProductCardProps) {
  const [added, setAdded] = useState(false);
  const available = product.availableQuantity ?? Infinity;
  const soldOut = available <= 0;
  // The store app's own picture. Set after the page is on the phone: the server and the phone reach the API by different addresses.
  const [photo, setPhoto] = useState<string | null>(null);
  useEffect(() => { setPhoto(photoUrl(product.photoKey)); }, [product.photoKey]);
  const picture = product.images[0]?.url ?? photo;

  const handleAdd = () => {
    onAdd(product);
    setAdded(true);
    setTimeout(() => setAdded(false), 1200);
  };

  return (
    <div className="card h-100 shadow-sm product-card">
      <div className="card-img-top ratio ratio-4x3 bg-light">
        {picture ? (
          <img src={picture} alt={product.name} loading="lazy" className="object-fit-cover w-100 h-100" />
        ) : (
          // No picture yet: a quiet rice-sack mark in the middle, not a "broken picture" icon in the corner.
          <div className="d-flex align-items-center justify-content-center" aria-hidden="true">
            <i className="bi bi-bag text-secondary fs-1 opacity-50"></i>
          </div>
        )}
        {product.featured && (
          <span className="badge text-bg-warning position-absolute top-0 start-0 m-1">
            <i className="bi bi-star-fill me-1"></i>Featured
          </span>
        )}
      </div>
      <div className="card-body d-flex flex-column">
        {/* Name, then the price on its own line: side by side the price was cut off on a phone. */}
        <h6 className="card-title mb-1">{product.name}</h6>
        <div className="fw-bold fs-5 mb-1" style={{ color: "var(--sam-primary, #c0421f)" }}>{toPesos(product.priceMinor)}</div>
        {product.category && <small className="text-muted">{product.category.name}</small>}
        {product.tags?.length > 0 && (
          <div className="d-flex flex-wrap gap-1 mt-1">
            {product.tags.map((t) => <span key={t} className="badge text-bg-light border small">{t}</span>)}
          </div>
        )}
        {product.description && (
          <p className="card-text small text-muted mt-1 mb-2">{product.description}</p>
        )}
        {/* Customers see "Available" or "Sold out", not the count: the count is every store and the warehouse
            added up, and loose rice is kept in grams (it read "In stock: 40000"). */}
        <div className="mt-auto d-flex flex-wrap justify-content-between align-items-center gap-2">
          <small className={soldOut ? "text-danger fw-semibold" : "text-success fw-semibold"}>
            {soldOut ? "Sold out" : "Available"}
          </small>
          <button
            className="btn btn-primary"
            style={{ minHeight: 44 }}
            disabled={soldOut}
            onClick={handleAdd}
          >
            {added ? <i className="bi bi-check-lg me-1"></i> : <i className="bi bi-cart-plus me-1"></i>}
            {added ? "Added" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}