import { API_URL } from "../config";
import type { PublicStoreDTO, ProductDTO } from "../types";

export async function getPublicStore(slug: string): Promise<PublicStoreDTO | null> {
  const res = await fetch(`${API_URL}/public/stores/${slug}`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

export async function getActiveProducts(storeId: string): Promise<ProductDTO[]> {
  const res = await fetch(`${API_URL}/public/stores/${storeId}/products`, { cache: "no-store" });
  if (!res.ok) return [];
  return res.json();
}