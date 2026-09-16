// Cart client — browser-side calls to the public API.
// The cart token lives in localStorage; the API holds the authoritative cart.

import { API_URL } from "../config";
import type { CartWithItemsDTO } from "../types";

const TOKEN_KEY = "samstore.cartToken";

export function getStoredCartToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredCartToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
}

export function clearStoredCartToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

async function handle<T>(res: Response): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      data?.errors?.join(" · ") ?? data?.message ?? `Request failed (${res.status})`;
    return { ok: false, message: msg };
  }
  return { ok: true, value: data as T };
}

export async function createCart(): Promise<{ token: string }> {
  const res = await fetch(`${API_URL}/public/carts`, { method: "POST" });
  const out = await handle<{ token: string }>(res);
  if (!out.ok) throw new Error(out.message);
  return out.value;
}

export async function getCart(token: string): Promise<CartWithItemsDTO> {
  const res = await fetch(`${API_URL}/public/carts/${token}`);
  const out = await handle<CartWithItemsDTO>(res);
  if (!out.ok) throw new Error(out.message);
  return out.value;
}

export async function addItem(token: string, productId: string, quantity: number): Promise<CartWithItemsDTO> {
  const res = await fetch(`${API_URL}/public/carts/${token}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId, quantity }),
  });
  const out = await handle<CartWithItemsDTO>(res);
  if (!out.ok) throw new Error(out.message);
  return out.value;
}

export async function updateItemQuantity(token: string, productId: string, quantity: number): Promise<CartWithItemsDTO> {
  const res = await fetch(`${API_URL}/public/carts/${token}/items/${productId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quantity }),
  });
  const out = await handle<CartWithItemsDTO>(res);
  if (!out.ok) throw new Error(out.message);
  return out.value;
}

export async function removeItem(token: string, productId: string): Promise<CartWithItemsDTO> {
  const res = await fetch(`${API_URL}/public/carts/${token}/items/${productId}`, {
    method: "DELETE",
  });
  const out = await handle<CartWithItemsDTO>(res);
  if (!out.ok) throw new Error(out.message);
  return out.value;
}

export async function ensureCartToken(): Promise<string> {
  const existing = getStoredCartToken();
  if (existing) return existing;
  const { token } = await createCart();
  setStoredCartToken(token);
  return token;
}