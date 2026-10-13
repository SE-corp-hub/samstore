"use client";

// Shown by store-scoped panels when the top-bar switcher has no store selected
// (a storeless platform admin). Say what to do instead of blaming a load failure.

export default function NoStoreScope() {
  return (
    <div className="card">
      <div className="card-body text-center py-5">
        <i className="bi bi-shop-window fs-1 text-secondary"></i>
        <h5 className="mt-3 mb-2">Select a store</h5>
        <p className="text-muted mb-0">This screen needs a store. Pick one from the switcher in the top bar.</p>
      </div>
    </div>
  );
}
