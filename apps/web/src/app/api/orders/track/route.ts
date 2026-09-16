import { NextResponse } from "next/server";
import { API_URL } from "../../../../config";

// Server-side proxy for order tracking (keeps API_URL server-side).
export async function POST(req: Request) {
  let body: { claimToken?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ message: "Invalid JSON" }, { status: 400 });
  }
  if (!body.claimToken) {
    return NextResponse.json({ message: "claimToken is required" }, { status: 422 });
  }
  const res = await fetch(`${API_URL}/public/orders/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claimToken: body.claimToken }),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}