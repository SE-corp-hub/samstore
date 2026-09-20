"use client";

import { useState } from "react";
import type { ProductDTO } from "../types";

const toPesos = (minor: number) => `₱${(minor / 100).toFixed(2)}`;

interface ProductCardProps {
  product: ProductDTO;
  onAdd: (product: ProductDTO) => void;
}

export default function ProductCard({ product, onAdd }: ProductCardProps) {
  const [added, setAdded] = useState(false);
  const available = product.availableQuantity ?? Infinity;
  const soldOut = available <= 0;

  const handleAdd = () => {
    onAdd(product);
    setAdded(true);
    setTimeout(() => setAdded(false), 1200);
  };

  return (
    <div className="card h-100 shadow-sm product-card">
      <div className="card-img-top ratio ratio-4x3 bg-light d-flex align-items-center justify-content-center">
        {product.images[0] ? (
          <img src={product.images[0].url} alt={product.name} className="object-fit-cover w-100 h-100" />
        ) : (
          <i className="bi bi-image text-secondary fs-1"></i>
        )}
        {product.featured && (
          <span className="badge text-bg-warning position-absolute top-0 start-0 m-1">
            <i className="bi bi-star-fill me-1"></i>Featured
          </span>
        )}
      </div>
      <div className="card-body d-flex flex-column">
        <div className="d-flex justify-content-between align-items-start mb-1">
          <h6 className="card-title mb-0">{product.name}</h6>
          <span className="badge text-bg-primary ms-2">{toPesos(product.priceMinor)}</span>
        </div>
        {product.category && <small className="text-muted">{product.category.name}</small>}
        {product.tags?.length > 0 && (
          <div className="d-flex flex-wrap gap-1 mt-1">
            {product.tags.map((t) => <span key={t} className="badge text-bg-light border small">{t}</span>)}
          </div>
        )}
        {product.description && (
          <p className="card-text small text-muted mt-1 mb-2">{product.description}</p>
        )}
        <div className="mt-auto d-flex justify-content-between align-items-center">
          <small className={soldOut ? "text-danger" : "text-muted"}>
            {soldOut ? "Sold out" : `In stock: ${available}`}
          </small>
          <button
            className="btn btn-sm btn-primary"
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