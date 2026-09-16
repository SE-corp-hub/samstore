import Storefront from "../../components/Storefront";
import { API_URL } from "../../config";
import type { PublicStoreDTO, ProductDTO } from "../../types";

export default async function StorePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams?: Promise<{ token?: string }> }) {
  const { slug } = await params;
  const sp = searchParams ? await searchParams : null;
  const token = sp?.token ?? "";
  // The public link is slug + high-entropy token. Missing token → 404 (identical
  // to an unknown store, so nothing leaks).
  const res = await fetch(`${API_URL}/public/stores/${slug}?token=${encodeURIComponent(token)}`, { cache: "no-store" });
  if (!res.ok) {
    return (
      <div className="container py-5 text-center">
        <i className="bi bi-exclamation-triangle fs-1 d-block mb-3 text-warning"></i>
        <h1 className="h4">Store not found</h1>
        <p className="text-muted">Check the link and try again.</p>
      </div>
    );
  }
  const data: { store: PublicStoreDTO; products: ProductDTO[] } = await res.json();
  return <Storefront store={data.store} products={data.products} />;
}