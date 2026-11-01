"use client";

// Walk-in: the quick cash sale for customers who are not on the list.
//   Tap the rice (each tap adds one; loose rice asks how many kilos), then "Cash exact". Two or three taps.
//   It is the same sale as the full POS (POST /admin/benta): same stock, cost, Store payable charge,
//   offline queue and receipt. Credit, GCash, special prices and "take from another store" stay in Full sale.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cachedGet, offlineRef, savedCopy, savedThenFresh, useOffline } from "../../lib/offlineCache";
import { sendStep } from "../../lib/offlineQueue";
import { newSaleKey } from "../../lib/saleKey";
import { printSlip } from "../../lib/slip-print";
import { getPrinterSettings } from "../../lib/printer-settings";
import { peso, kg } from "../../lib/number-format";
import { quickCash } from "../../lib/quick-cash";
import { matchesSearch, mostUsed, noteUse } from "../../lib/product-find";
import { FIT, useMediaQuery, WIDE } from "../../lib/use-media-query";
import { useFitHeight } from "../../lib/use-fit-height";
import { toast } from "../../lib/toast";
import { bestSellers, lineTotal } from "../../lib/walk-in";
import StoreBar from "./StoreBar";
import { OpenDrawer } from "./BentaPanel";
import PickTile from "./PickTile";

interface Loc { id: string; name: string; code: string | null; type: string }
interface Item { id: string; name: string; loose: boolean; gramsPerUnit: number | null; priceMinor: number; stock: Record<string, number> }
/** Sacks/packs: `qty` pieces. Loose rice: `qty` grams. */
interface Line { productId: string; qty: number }
interface Sold { ref: string; offline: boolean; totalMinor: number; changeMinor: number; lines: { name: string; qty: string; totalMinor: number }[]; belowCost: string[] }
type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;

const BEST = 10;
/** Kilos offered for loose rice, in grams. */
const KILO_CHOICES = [500, 1000, 2000, 3000, 5000, 10000];

/** `switcher`: the Walk-in / Full sale buttons, placed at the top of the product column so the sale card can start at the very top. */
export default function WalkInPanel({ switcher }: { switcher?: ReactNode }) {
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
  // Tablet or PC: the screen is exactly the space between the bars (no page scroll); only the product list scrolls.
  const fit = useMediaQuery(FIT);
  const fitRef = useFitHeight<HTMLDivElement>(fit);

  const catalogAsk = useRef(0); // only the latest location asked for may fill the screen
  /** The price list of a location: the copy saved on this tablet at once, then the server's. Returns the location shown. */
  const loadCatalog = useCallback(async (loc?: string): Promise<string | null> => {
    const ask = ++catalogAsk.current;
    let shown: string | null = null;
    const show = (d: ApiBody) => {
      if (ask !== catalogAsk.current || !d?.products) return;
      setLocations((d.locations as Loc[]).filter((l) => l.type !== "BUFFER"));
      setItems(d.products as Item[]);
      shown = (d.location as Loc).id;
      setLocationId(shown);
    };
    const d = await savedThenFresh<ApiBody>(`/admin/benta/catalog${loc ? `?locationId=${encodeURIComponent(loc)}` : ""}`, show);
    if (!d?.products && ask === catalogAsk.current) setError("Could not load the products — connect to the internet once so the tablet can save them");
    return shown;
  }, []);

  useEffect(() => {
    setUsed(mostUsed("pos", BEST));
    (async () => {
      // Ask for the price list right away, for the home location this tablet saved last time,
      // instead of waiting for "who am I" first (one server answer less before prices show).
      const guess = savedCopy<{ homeLocationId?: string | null }>("/admin/me/rice")?.homeLocationId ?? undefined;
      const catalog = loadCatalog(guess);
      const firstAsk = catalogAsk.current;
      void savedThenFresh<{ name?: string }>("/admin/settings", (d) => setStoreName(d?.name ?? ""));
      // Cash needs an open drawer when the owner asks for one: say so before the first sale, not after.
      void cachedGet<{ session?: unknown; required?: boolean }>("/admin/registers/current").then((r) => { if (r && !r.session && r.required !== false) setDrawerClosed(true); });
      const me = await cachedGet<{ homeLocationId?: string | null }>("/admin/me/rice");
      setHomeLocationId(me?.homeLocationId ?? null);
      const want = me?.homeLocationId ?? undefined;
      const shown = await catalog;
      // The saved guess was wrong (home location changed): show the right one, unless staff already picked a location.
      if (catalogAsk.current === firstAsk && want !== guess && want !== shown) await loadCatalog(want);
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
      <div key={i.id} className="col-6 col-md-3">
        <PickTile name={i.name} price={peso(i.priceMinor)} priceNote={i.loose ? "/kg" : undefined}
          countText={n > 0 ? `${i.loose ? kg(n) : n} in sale` : undefined}
          stock={left <= 0 ? "None left here" : `${i.loose ? kg(left) : left} left`} stockOut={left <= 0}
          ariaLabel={`${i.name}, ${peso(i.priceMinor)}${i.loose ? " a kilo" : ""}${n > 0 ? `, ${i.loose ? kg(n) : n} in this sale` : ""}`}
          onClick={() => tap(i)} />
      </div>
    );
  };

  // The rows above the product buttons stay put; the buttons themselves scroll in their own box (.fit-scroll).
  const storeBar = (
    <StoreBar inline size="md" label="Selling at" locations={locations} value={locationId} homeLocationId={homeLocationId} locked={lines.length > 0}
      lockedNote="Finish or clear this sale to switch store." onPick={(id) => { setLines([]); void loadCatalog(id); }} />
  );
  const searching = search.trim() !== "";
  const headingRow = (
    <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
      <h2 className="h5 mb-0 me-auto">{searching ? "Other rice" : "Best sellers"}</h2>
      <label htmlFor="wi-search" className="mb-0 fw-semibold">Other rice</label>
      <input id="wi-search" className="form-control" style={{ flex: "0 1 14rem", minWidth: "9rem" }} type="search" placeholder="Type a name" value={search} onChange={(e) => setSearch(e.target.value)} />
    </div>
  );
  const grid = (
    <div className="fit-scroll">
      {!searching && <div className="row g-2 mb-2">{best.map(tile)}</div>}
      {searching && found.length > 0 && <div className="row g-2 mb-2">{found.map(tile)}</div>}
      {searching && found.length === 0 && <p className="text-muted">No rice matches “{search}”.</p>}
    </div>
  );

  // Sacks and packs count one each; a loose-rice line counts once whatever the kilos.
  const itemCount = lines.reduce((s, l) => s + (byId.get(l.productId)?.loose ? 1 : l.qty), 0);
  const side = (
    <div className={`sale-card fit-card${fit || wide ? "" : " position-sticky bottom-0 sticky-above-bar shadow"}${fit && !wide ? " fit-bottom" : ""}`} style={fit || wide ? undefined : { zIndex: 5, maxHeight: "60vh", overflowY: "auto" }}>
      <div className="card-body">
        {loosePick ? (
          <>
            <div className="sale-card-title"><i className="bi bi-basket2-fill" aria-hidden="true"></i>{loosePick.name} · {peso(loosePick.priceMinor)}/kg</div>
            <div className="fw-semibold mb-2">How many kilos?</div>
            <div className="d-flex flex-wrap gap-2 mb-2" role="group" aria-label="Kilos">
              {KILO_CHOICES.map((g) => (
                <button key={g} type="button" className="btn btn-outline-dark btn-lg flex-fill" style={{ minWidth: 96 }} onClick={() => add(loosePick, g)}>
                  {kg(g)}<span className="d-block small">{peso(lineTotal(loosePick, g))}</span>
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-outline-dark" onClick={() => setLoosePick(null)}>Cancel</button>
          </>
        ) : lines.length === 0 ? (
          sold ? (
            <div className="alert alert-success mb-0" role="status">
              <div className="fw-bold fs-5">Sold {peso(sold.totalMinor)}</div>
              {sold.changeMinor > 0 && <div className="change-due">Change to give: {peso(sold.changeMinor)}</div>}
              <div className="mt-1">{sold.ref}{sold.offline && " · saved on this tablet, uploads when Wi-Fi is back"}</div>
              {sold.belowCost.length > 0 && <div className="text-danger fw-semibold mt-1">Sold below Store 1&apos;s cost: {sold.belowCost.join(", ")}.</div>}
              <button type="button" className="btn btn-outline-primary mt-2" onClick={() => printSlip(slipOf(sold))}><i className="bi bi-printer me-1" aria-hidden="true"></i>Print receipt</button>
              <div className="mt-2">Tap the next rice to start a new sale.</div>
            </div>
          ) : (
            <div className="text-center text-muted py-3"><i className="bi bi-hand-index fs-2 d-block mb-1" aria-hidden="true"></i>Tap a rice to start. Each tap adds one.</div>
          )
        ) : (
          <>
            <div className="sale-card-title"><i className="bi bi-basket2-fill" aria-hidden="true"></i>This sale · {itemCount} {itemCount === 1 ? "item" : "items"}</div>
            <ul className="list-unstyled mb-0 sale-lines">
              {lines.map((l) => {
                const i = byId.get(l.productId);
                if (!i) return null;
                const step = i.loose ? 1000 : 1;
                return (
                  <li key={l.productId} className="sale-line">
                    <span className="name">{i.name}</span>
                    <span className="qty" role="group" aria-label={`How many ${i.name}`}>
                      <button type="button" className="btn btn-outline-dark qty-btn" aria-label={`One ${i.loose ? "kilo" : ""} less ${i.name}`} onClick={() => change(l.productId, -Math.min(step, l.qty))}>−</button>
                      <span className="qty-num">{i.loose ? kg(l.qty) : l.qty}</span>
                      <button type="button" className="btn btn-outline-dark qty-btn" aria-label={`One ${i.loose ? "kilo" : ""} more ${i.name}`} onClick={() => change(l.productId, step)}>+</button>
                    </span>
                    <span className="amount">{peso(lineTotal(i, l.qty))}</span>
                  </li>
                );
              })}
            </ul>
            <div className="sale-total"><span className="label">Total</span><span className="amount">{peso(total)}</span></div>
            {drawerClosed ? (
              <OpenDrawer onOpened={() => { setDrawerClosed(false); setError(null); }} />
            ) : (
              <>
                <button type="button" className="btn btn-success btn-lg w-100 py-3 fw-bold sale-pay mt-2" disabled={busy} onClick={() => void pay(total)}>
                  {busy ? "Saving…" : <><i className="bi bi-cash-coin me-2" aria-hidden="true"></i>Cash exact · {peso(total)}</>}
                </button>
                {quickCash(total).filter((x) => x > total).length > 0 && (
                  <>
                    <div className="mt-2 mb-1">Customer gave more? Tap what they gave:</div>
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
            <button type="button" className="btn btn-outline-danger w-100 mt-3" disabled={busy} onClick={() => { setLines([]); setError(null); keyRef.current = null; }}><i className="bi bi-x-lg me-1" aria-hidden="true"></i>Clear this sale</button>
          </>
        )}
      </div>
    </div>
  );

  // Sideways: products left, the sale right, both from the top. Upright: the sale under the products.
  return (
    <div ref={fitRef} className="sell-screen tone-sell sell-fit">
      {offline && <div className="alert alert-secondary py-2 mb-2">Offline — walk-in sales are saved on this tablet and upload later.</div>}
      {error && lines.length === 0 && <div className="alert alert-danger py-2 mb-2" role="alert">{error}</div>}
      {wide ? (
        <div className="fit-row">
          <div className="fit-col fit-main">{switcher}{storeBar}{headingRow}{grid}</div>
          <div className="fit-col fit-side">{side}</div>
        </div>
      ) : (
        <div className="fit-col">{switcher}{storeBar}{headingRow}{grid}{side}</div>
      )}
    </div>
  );
}
