import { NextResponse } from "next/server";
import { API_URL } from "../../../config";
import type { CheckoutRequest, CheckoutResponse } from "../../../types";

export async function POST(req: Request) {
  // Server-side proxy: the storefront posts here; this calls the NestJS API.
  // Keeps API_URL and any future auth server-side.
  let body: CheckoutRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ errors: ["Invalid JSON body"] }, { status: 400 });
  }

  const res = await fetch(`${API_URL}/public/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data: CheckoutResponse | { errors?: string[]; message?: string } = await res.json();
  return NextResponse.json(data, { status: res.status });
}