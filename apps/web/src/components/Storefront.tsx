"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProductDTO, PublicStoreDTO, CheckoutResponse, CartWithItemsDTO } from "../types";
import ProductCard from "../components/ProductCard";
import CartDrawer, { type CartLineUI } from "../components/CartDrawer";
import CheckoutForm from "../components/CheckoutForm";
import OrderTracker from "../components/OrderTracker";
import { CustomerAccount } from "../components/CustomerAccount";
import {
  ensureCartToken,
  getStoredCartToken,
  getCart,
  addItem,
  updateItemQuantity,
  removeItem,
  clearStoredCartToken,
} from "../lib/cart-client";

const toPesos = (minor: number) => `₱${(minor / 100).toFixed(2)}`;

interface StorefrontProps {
  store: PublicStoreDTO;
  products: ProductDTO[];
}

export default function Storefront({ store, products }: StorefrontProps) {
  const [cartOpen, setCartOpen] = useState(false);
  const [view, setView] = useState<"menu" | "checkout" | "done">("menu");
  const [cartToken, setCartToken] = useState<string | null>(null);
  const [lines, setLines] = useState<CartLineUI[]>([]);
  const [cartError, setCartError] = useState<string | null>(null);
  const [lastOrder, setLastOrder] = useState<CheckoutResponse | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  // U4: catalog search + category filter (client-side over loaded products)
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");

  const categories = [...new Set(products.map((p) => p.category?.name).filter(Boolean))] as string[];
  const filteredProducts = products.filter((p) => {
    const q = search.trim().toLowerCase();
    const inSearch = !q || p.name.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q) || (p.sku ?? "").toLowerCase().includes(q);
    const inCategory = !category || p.category?.name === category;
    return inSearch && inCategory;
  });

  const productById = useCallback(
    () => new Map(products.map((p) => [p.id, p])),
    [products],
  );

  const toLines = useCallback(
    (cart: CartWithItemsDTO): CartLineUI[] =>
      cart.items
        .map((i) => {
          const product = productById().get(i.productId);
          if (!product) return null;
          return { product: { ...product, priceMinor: i.unitPriceMinor }, quantity: i.quantity };
        })
        .filter((l): l is CartLineUI => l !== null),
    [productById],
  );

  // Hydrate an existing cart (token in localStorage) on mount.
  useEffect(() => {
    const token = getStoredCartToken();
    if (!token) return;
    setCartToken(token);
    getCart(token)
      .then((cart) => setLines(toLines(cart)))
      .catch(() => {
        // stale token → start fresh
        clearStoredCartToken();
        setCartToken(null);
      });
  }, [toLines]);

  const addProduct = async (p: ProductDTO) => {
    setCartError(null);
    try {
      const token = cartToken ?? (await ensureCartToken());
      setCartToken(token);
      const cart = await addItem(token, p.id, 1);
      setLines(toLines(cart));
    } catch (e) {
      setCartError(e instanceof Error ? e.message : "Could not add item");
    }
  };

  const updateQty = async (productId: string, qty: number) => {
    if (!cartToken) return;
    setCartError(null);
    try {
      const cart =
        qty <= 0
          ? await removeItem(cartToken, productId)
          : await updateItemQuantity(cartToken, productId, qty);
      setLines(toLines(cart));
    } catch (e) {
      setCartError(e instanceof Error ? e.message : "Could not update item");
    }
  };

  const handleCheckoutSuccess = (r: CheckoutResponse) => {
    setLastOrder(r);
    setLines([]);
    clearStoredCartToken();
    setCartToken(null);
    setView("done");
  };

  const cartCount = lines.reduce((s, l) => s + l.quantity, 0);
  const subtotal = lines.reduce((s, l) => s + l.product.priceMinor * l.quantity, 0);

  if (store.orderingPaused || !store.guestOrderingEnabled) {
    return (
      <div className="container py-5 text-center">
        <i className="bi bi-shop fs-1 d-block mb-3"></i>
        <h1 className="h3">{store.name}</h1>
        <p className="lead">{store.closedStoreMessage ?? "We're currently closed for orders. Please check back soon!"}</p>
      </div>
    );
  }

  return (
    <div className="storefront">
      {/* Per-store branding (P8): accent color scoped to this page */}
      <style>{`
        .storefront { --sam-primary: ${store.accentColor ?? "#d94f2b"}; }
        .storefront .btn-primary { background-color: var(--sam-primary); border-color: var(--sam-primary); }
      `}</style>
      {store.bannerText && (
        <div className="text-center py-2 fw-semibold small text-white" style={{ background: store.accentColor ?? "#d94f2b" }}>
          {store.bannerText}
        </div>
      )}
      {/* Navbar */}
      <nav className="navbar navbar-dark bg-dark sticky-top">
        <div className="container">
          <span className="navbar-brand fw-semibold">
            <i className="bi bi-shop me-2"></i>{store.name}
          </span>
          <div className="d-flex align-items-center gap-2">
            <button className="btn btn-outline-light btn-sm" onClick={() => setAccountOpen((v) => !v)}>
              <i className="bi bi-person me-1"></i>Account
            </button>
            <button className="btn btn-outline-light position-relative" onClick={() => setCartOpen(true)}>
              <i className="bi bi-cart3 me-1"></i>Cart
              {cartCount > 0 && (
                <span className="badge rounded-pill bg-primary position-absolute top-0 start-100 translate-middle">
                  {cartCount}
                </span>
              )}
            </button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <header className="py-4 bg-light border-bottom">
        <div className="container">
          <h1 className="h3 mb-1">{store.name}</h1>
          {store.description && <p className="text-muted mb-0">{store.description}</p>}
          <small className="text-muted">
            {store.deliveryEnabled && `Delivery fee ${toPesos(store.deliveryFeeMinor)} · `}
            {store.minOrderAmountMinor > 0 && `Min order ${toPesos(store.minOrderAmountMinor)} · `}
            Cash on delivery
          </small>
        </div>
      </header>

      {/* Body */}
      <main className="container py-4">
        {accountOpen && (
          <div className="mb-4" style={{ maxWidth: 420 }}>
            <CustomerAccount />
          </div>
        )}
        {cartError && (
          <div className="alert alert-danger py-2 small">{cartError}</div>
        )}
        {view === "done" && lastOrder ? (
          <div className="text-center py-5">
            <div className="card shadow-sm border-success" style={{ maxWidth: 480, margin: "0 auto" }}>
              <div className="card-body text-center p-4">
                <i className="bi bi-check-circle-fill text-success fs-1 d-block mb-2"></i>
                <h2 className="h4 mb-1">Order placed!</h2>
                <p className="text-muted small mb-2">Thanks for ordering from {store.name}.</p>
                <div className="h3 fw-bold text-primary">{lastOrder.orderNumber}</div>
                <p className="mb-1">Total <strong>{toPesos(lastOrder.totalMinor)}</strong> · Cash on delivery</p>
                {(lastOrder.removedProductIds?.length ?? 0) > 0 && (
                  <div className="alert alert-warning py-2 small text-start mb-2" role="status">
                    <i className="bi bi-exclamation-triangle me-1"></i>
                    {lastOrder.removedProductIds!.length === 1 ? "1 item became" : `${lastOrder.removedProductIds!.length} items became`} unavailable and
                    {lastOrder.removedProductIds!.length === 1 ? " was" : " were"} removed from your order.
                  </div>
                )}
                {(lastOrder.priceChanges?.length ?? 0) > 0 && (
                  <div className="alert alert-info py-2 small text-start mb-2" role="status">
                    <i className="bi bi-info-circle me-1"></i>
                    A price changed while you were ordering — your total reflects the current price
                    {lastOrder.priceChanges!.length === 1
                      ? ` (was ${toPesos(lastOrder.priceChanges![0]!.fromMinor)}, now ${toPesos(lastOrder.priceChanges![0]!.toMinor)}).`
                      : ` for ${lastOrder.priceChanges!.length} items.`}
                  </div>
                )}
                <OrderTracker initialToken={lastOrder.claimToken} />
                <div className="d-grid gap-2 mt-3">
                  <button
                    className="btn btn-sm btn-outline-secondary"
                    onClick={() => { navigator.clipboard?.writeText(lastOrder.claimToken); }}
                  >
                    <i className="bi bi-clipboard me-1"></i>Copy tracking token
                  </button>
                  <button
                    className="btn btn-sm btn-outline-primary"
                    onClick={() => {
                      const text = `Order ${lastOrder.orderNumber} from ${store.name} — total ${toPesos(lastOrder.totalMinor)}. Track with token: ${lastOrder.claimToken}`;
                      if (typeof navigator !== "undefined" && "share" in navigator) { try { navigator.share({ title: `Your ${store.name} order`, text }); return; } catch { /* fall through */ } }
                      navigator.clipboard?.writeText(text);
                    }}
                  >
                    <i className="bi bi-share me-1"></i>Share order
                  </button>
                </div>
                <div className="mt-3">
                  <button className="btn btn-outline-secondary btn-sm" onClick={() => setView("menu")}>Back to menu</button>
                </div>
              </div>
            </div>
          </div>
        ) : view === "checkout" ? (
          <CheckoutForm
            cartToken={cartToken ?? ""}
            store={store}
            subtotalMinor={subtotal}
            deliveryFeeMinor={store.deliveryFeeMinor}
            onSuccess={handleCheckoutSuccess}
            onClose={() => setView("menu")}
          />
        ) : (
          <>
            <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
              <input
                className="form-control form-control-sm"
                style={{ maxWidth: 280 }}
                placeholder="Search menu…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button
                className={`btn btn-sm ${category === "" ? "btn-primary" : "btn-outline-primary"}`}
                onClick={() => setCategory("")}
              >
                All
              </button>
              {categories.map((c) => (
                <button
                  key={c}
                  className={`btn btn-sm ${category === c ? "btn-primary" : "btn-outline-primary"}`}
                  onClick={() => setCategory(category === c ? "" : c)}
                >
                  {c}
                </button>
              ))}
            </div>
            {filteredProducts.length === 0 ? (
              <p className="text-muted text-center py-4">
                <i className="bi bi-search fs-3 d-block mb-2"></i>
                Nothing matches your search.
              </p>
            ) : (
              <div className="row g-3">
                {filteredProducts.map((p) => (
                  <div className="col-6 col-md-4 col-lg-3" key={p.id}>
                    <ProductCard product={p} onAdd={addProduct} />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {/* Cart drawer */}
      <CartDrawer
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        lines={lines}
        onUpdateQty={updateQty}
        onCheckout={() => { setCartOpen(false); setView("checkout"); }}
        deliveryFeeMinor={store.deliveryFeeMinor}
        minOrderMinor={store.minOrderAmountMinor}
      />
    </div>
  );
}