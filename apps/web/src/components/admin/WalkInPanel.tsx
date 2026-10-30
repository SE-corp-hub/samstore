"use client";

// Walk-in: the quick cash sale for customers who are not on the list.
//   Tap the rice (each tap adds one; loose rice asks how many kilos), then "Cash exact". Two or three taps.
//   It is the same sale as the full POS (POST /admin/benta): same stock, cost, Store payable charge,
//   offline queue and receipt. Credit, GCash, special prices and "take from another store" stay in Full sale.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cachedGet, offlineRef, useOffline } from "../../lib/offlineCache";
import { sendStep } from "../../lib/offlineQueue";
import { newSaleKey } from "../../lib/saleKey";
import { printSlip } from "../../lib/slip-print";
import { getPrinterSettings } from "../../lib/printer-settings";
import { peso, kg } from "../../lib/number-format";
import { quickCash } from "../../lib/quick-cash";
import { matchesSearch, mostUsed, noteUse } from "../../lib/product-find";
import { useMediaQuery, WIDE } from "../../lib/use-media-query";
import { toast } from "../../lib/toast";
import { bestSellers, lineTotal } from "../../lib/walk-in";
import StoreBar from "./StoreBar";
import { OpenDrawer } from "./BentaPanel";

interface Loc { id: string; name: string; code: string | null; type: string }
interface Item { id: string; name: string; loose: boolean; gramsPerUnit: number | null; priceMinor: number; stock: Record<string, number> }
/** Sacks/packs: `qty` pieces. Loose rice: `qty` grams. */
interface Line { productId: string; qty: number }
interface Sold { ref: string; offline: boolean; totalMinor: number; changeMinor: number; lines: { name: string; qty: string; totalMinor: number }[]; belowCost: string[] }
type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;

const BEST = 10;
/** Kilos offered for loose rice, in grams. */
const KILO_CHOICES = [500, 1000, 2000, 3000, 5000, 10000];

export default function WalkInPanel({ onFullSale }: { onFullSale: () => void }) {
  const [locations, setLocations] = useState<Loc[]>([]);
  const [locationId, setLocationId] = useState("");
  const [homeLocationId, setHomeLocationId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [storeName, setStoreName] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [loosePick, setLoosePick] = useState<Item | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerClosed, setDrawerClosed] = useState(false);
  const [sold, setSold] = useState<Sold | null>(null);
  const [used, setUsed] = useState<string[]>([]);
  const keyRef = useRef<string | null>(null);
  const offline = useOffline();
  const wide = useMediaQuery(WIDE);

  const loadCatalog = useCallback(async (loc?: string) => {
    const d = await cachedGet<ApiBody>(`/admin/benta/catalog${loc ? `?locationId=${encodeURIComponent(loc)}` : ""}`);
    if (!d?.products) { setError("Could not load the products — connect to the internet once so the tablet can save them"); return; }
    setLocations((d.locations as Loc[]).filter((l) => l.type !== "BUFFER"));
    setItems(d.products as Item[]);
    setLocationId((d.location as Loc).id);
  }, []);

  useEffect(() => {
    setUsed(mostUsed("pos", BEST));
    (async () => {
      const me = await cachedGet<{ homeLocationId?: string | null }>("/admin/me/rice");
      setHomeLocationId(me?.homeLocationId ?? null);
      void cachedGet<{ name?: string }>("/admin/settings").then((d) => setStoreName(d?.name ?? ""));
      // Cash needs an open drawer when the owner asks for one: say so before the first sale, not after.
      void cachedGet<{ session?: unknown; required?: boolean }>("/admin/registers/current").then((r) => { if (r && !r.session && r.required !== false) setDrawerClosed(true); });
      await loadCatalog(me?.homeLocationId ?? undefined);
    })().catch(() => setError("Could not load"));
  }, [loadCatalog]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const best = useMemo(() => bestSellers(items, used, locationId, BEST), [items, used, locationId]);
  const found = useMemo(() => (search.trim() ? items.filter((i) => matchesSearch(i.name, search)).slice(0, 12) : []), [items, search]);
  const total = lines.reduce((s, l) => { const i = byId.get(l.productId); return s + (i ? lineTotal(i, l.qty) : 0); }, 0);
  const inSale = (id: string) => lines.find((l) => l.productId === id)?.qty ?? 0;

  const add = (item: Item, qty: number) => {
    noteUse("pos", item.id);
    setSold(null); setError(null); setLoosePick(null);
    setLines((prev) => {
      const at = prev.findIndex((l) => l.productId === item.id);
      if (at < 0) return [...prev, { productId: item.id, qty }];
      return prev.map((l, i) => (i === at ? { ...l, qty: l.qty + qty } : l));
    });
  };
  const change = (productId: string, delta: number) => setLines((prev) => prev.map((l) => (l.productId === productId ? { ...l, qty: l.qty + delta } : l)).filter((l) => l.qty > 0));
  const tap = (item: Item) => { if (item.loose) { setLoosePick(item); setSold(null); } else add(item, 1); };

  const slipOf = (s: Sold) => ({
    storeName: storeName || "SAM STORE", title: "SALES RECEIPT", reference: s.ref, when: new Date().toLocaleString("en-PH"),
    rows: s.lines.map((x) => ({ name: x.name, qty: `${x.qty}  ${peso(x.totalMinor)}` })),
    totals: [{ label: "TOTAL", value: peso(s.totalMinor) }, ...(s.changeMinor > 0 ? [{ label: "Change", value: peso(s.changeMinor) }] : [])],
    footer: s.offline ? "Saved offline · Salamat po!" : "Salamat po!",
  });

  const pay = async (tenderedMinor: number) => {
    if (busy || total <= 0 || tenderedMinor < total) return;
    setBusy(true); setError(null);
    if (!keyRef.current) keyRef.current = newSaleKey();
    const key = keyRef.current;
    const soldLines = lines.flatMap((l) => {
      const i = byId.get(l.productId);
      return i ? [{ name: i.name, qty: i.loose ? kg(l.qty) : `${l.qty}`, totalMinor: lineTotal(i, l.qty) }] : [];
    });
    const body = {
      idempotencyKey: key, locationId,
      lines: lines.map((l) => (byId.get(l.productId)?.loose ? { productId: l.productId, kilos: String(l.qty / 1000) } : { productId: l.productId, quantity: l.qty })),
      payment: { method: "cash", tenderedMinor },
      signatures: [],
      soldAt: new Date().toISOString(), // a sale that waits offline keeps its real time
    };
    try {
      const sent = await sendStep("/admin/benta", body, `Walk-in ${peso(total)}`);
      let done: Sold;
      if (sent.status === "queued") {
        done = { ref: offlineRef(key), offline: true, totalMinor: total, changeMinor: tenderedMinor - total, lines: soldLines, belowCost: [] };
      } else {
        const d = sent.data as ApiBody | null;
        if (!sent.ok || !d) {
          const msg = String(d?.errors?.join(", ") ?? d?.message ?? "The sale did not go through");
          if (/cash drawer/i.test(msg)) setDrawerClosed(true);
          else setError(msg);
          return;
        }
        done = { ref: String(d.orderNumber), offline: false, totalMinor: Number(d.totalMinor ?? total), changeMinor: tenderedMinor - total, lines: soldLines, belowCost: (d.belowCost as string[] | undefined) ?? [] };
        void loadCatalog(locationId);
      }
      keyRef.current = null;
      setLines([]); setSearch("");
      setSold(done);
      setUsed(mostUsed("pos", BEST));
      toast(`Sold ${peso(done.totalMinor)}`);
      if (getPrinterSettings().autoPrint) printSlip(slipOf(done));
    } catch {
      setError("No signal — tap the button again. The sale will not be counted twice.");
    } finally {
      setBusy(false);
    }
  };

  const tile = (i: Item) => {
    const n = inSale(i.id);
    const left = i.stock[locationId] ?? 0;
    return (
      <div key={i.id} className={wide ? "col-6 col-xl-4" : "col-6 col-md-4"}>
        <button type="button" className={`btn ${n > 0 ? "btn-dark" : "btn-outline-dark"} w-100 h-100 text-center p-2 position-relative`} style={{ minHeight: 112 }}
          aria-label={`${i.name}, ${peso(i.priceMinor)}${i.loose ? " a kilo" : ""}${n > 0 ? `, ${i.loose ? kg(n) : n} in this sale` : ""}`}
          aria-pressed={n > 0} onClick={() => tap(i)}>
          {n > 0 && <span className="position-absolute top-0 end-0 badge rounded-pill text-bg-success m-1 fs-6">{i.loose ? kg(n) : n}</span>}
          <div className="fw-semibold">{i.name}</div>
          <div style={{ fontSize: 24, fontVariantNumeric: "tabular-nums" }}>{peso(i.priceMinor)}<span className="fs-6 opacity-75">{i.loose ? "/kg" : ""}</span></div>
          {left <= 0
            ? <div><span className="badge bg-white text-danger border border-danger fw-semibold">None left here</span></div>
            : <div className="small" style={{ fontVariantNumeric: "tabular-nums" }}>{i.loose ? kg(left) : left} left</div>}
        </button>
      </div>
    );
  };

  const picker = (
    <>
      <StoreBar label="Selling at" locations={locations} value={locationId} homeLocationId={homeLocationId} locked={lines.length > 0}
        lockedNote="Finish or clear this sale to switch store." onPick={(id) => { setLines([]); void loadCatalog(id); }} />
      <h2 className="h5 mb-2">Best sellers</h2>
      <div className="row g-2 mb-3">{best.map(tile)}</div>
      <label htmlFor="wi-search" className="form-label fw-semibold mb-1">Other rice</label>
      <input id="wi-search" className="form-control form-control-lg mb-2" type="search" placeholder="Type a name, e.g. dinorado" value={search} onChange={(e) => setSearch(e.target.value)} />
      {found.length > 0 && <div className="row g-2 mb-3">{found.map(tile)}</div>}
      {search.trim() && found.length === 0 && <p className="text-muted">No rice matches “{search}”.</p>}
    </>
  );

  const side = (
    <div className={`card border-dark ${wide ? "position-sticky" : "position-sticky bottom-0 sticky-above-bar shadow"}`} style={wide ? { top: 12 } : { zIndex: 5, maxHeight: "60vh", overflowY: "auto" }}>
      <div className="card-body">
        {loosePick ? (
          <>
            <div className="fw-semibold mb-2">{loosePick.name} · {peso(loosePick.priceMinor)}/kg — how many kilos?</div>
            <div className="d-flex flex-wrap gap-2 mb-2" role="group" aria-label="Kilos">
              {KILO_CHOICES.map((g) => (
                <button key={g} type="button" className="btn btn-outline-dark btn-lg flex-fill" style={{ minWidth: 96 }} onClick={() => add(loosePick, g)}>
                  {kg(g)}<span className="d-block small">{peso(lineTotal(loosePick, g))}</span>
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-link" onClick={() => setLoosePick(null)}>Cancel</button>
          </>
        ) : lines.length === 0 ? (
          sold ? (
            <div className="alert alert-success mb-0" role="status">
              <div className="h5 mb-1">Sold {peso(sold.totalMinor)}{sold.changeMinor > 0 && <> · Change {peso(sold.changeMinor)}</>}</div>
              <div className="small">{sold.ref}{sold.offline && " · saved on this tablet, uploads when Wi-Fi is back"}</div>
              {sold.belowCost.length > 0 && <div className="small text-danger-emphasis mt-1">Sold below Store 1&apos;s cost: {sold.belowCost.join(", ")}.</div>}
              <button type="button" className="btn btn-outline-dark mt-2" onClick={() => printSlip(slipOf(sold))}><i className="bi bi-printer me-1" aria-hidden="true"></i>Print receipt</button>
              <div className="small text-muted mt-2">Tap the next rice to start a new sale.</div>
            </div>
          ) : (
            <div className="text-center text-muted py-3"><i className="bi bi-hand-index fs-2 d-block mb-1" aria-hidden="true"></i>Tap a rice to start. Each tap adds one.</div>
          )
        ) : (
          <>
            <ul className="list-unstyled mb-2" style={{ fontVariantNumeric: "tabular-nums" }}>
              {lines.map((l) => {
                const i = byId.get(l.productId);
                if (!i) return null;
                const step = i.loose ? 1000 : 1;
                return (
                  <li key={l.productId} className="d-flex align-items-center gap-2 py-1 border-bottom">
                    <span className="flex-grow-1">{i.name}</span>
                    <button type="button" className="btn btn-outline-dark" style={{ minWidth: 48, minHeight: 48 }} aria-label={`One ${i.loose ? "kilo" : ""} less ${i.name}`} onClick={() => change(l.productId, -Math.min(step, l.qty))}>−</button>
                    <span className="fw-semibold text-center" style={{ minWidth: 64 }}>{i.loose ? kg(l.qty) : l.qty}</span>
                    <button type="button" className="btn btn-outline-dark" style={{ minWidth: 48, minHeight: 48 }} aria-label={`One ${i.loose ? "kilo" : ""} more ${i.name}`} onClick={() => change(l.productId, step)}>+</button>
                    <span className="text-end" style={{ minWidth: 96 }}>{peso(lineTotal(i, l.qty))}</span>
                  </li>
                );
              })}
            </ul>
            {drawerClosed ? (
              <OpenDrawer onOpened={() => { setDrawerClosed(false); setError(null); }} />
            ) : (
              <>
                <button type="button" className="btn btn-success btn-lg w-100 py-3 fw-bold" style={{ fontSize: 26 }} disabled={busy} onClick={() => void pay(total)}>
                  {busy ? "Saving…" : <>Cash exact · {peso(total)}</>}
                </button>
                {quickCash(total).filter((x) => x > total).length > 0 && (
                  <>
                    <div className="small text-muted mt-2 mb-1">Customer gave more? Tap what they gave:</div>
                    <div className="d-flex flex-wrap gap-2">
                      {quickCash(total).filter((x) => x > total).map((x) => (
                        <button key={x} type="button" className="btn btn-outline-success btn-lg flex-fill" disabled={busy} onClick={() => void pay(x)}>
                          {peso(x)}<span className="d-block small">change {peso(x - total)}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            {error && <div className="alert alert-danger mt-2 mb-0" role="alert">{error}</div>}
            <button type="button" className="btn btn-link mt-1" disabled={busy} onClick={() => { setLines([]); setError(null); keyRef.current = null; }}>Clear this sale</button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div style={{ fontSize: 18 }}>
      {offline && <div className="alert alert-secondary py-2">Offline — walk-in sales are saved on this tablet and upload later.</div>}
      {error && lines.length === 0 && <div className="alert alert-danger" role="alert">{error}</div>}
      <div className="row g-3">
        <div className={wide ? "col-lg-7 col-xl-8" : "col-12"}>{picker}</div>
        <div className={wide ? "col-lg-5 col-xl-4" : "col-12"}>{side}</div>
      </div>
      <p className="small text-muted mt-3">Credit, GCash, special prices or rice from another store? <button type="button" className="btn btn-link p-0 align-baseline" onClick={onFullSale}>Use Full sale</button>.</p>
    </div>
  );
}
