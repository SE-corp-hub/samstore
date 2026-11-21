"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getAdminToken, getAdminStoreId, setAdminStoreId, getAdminRole, clearAdminSession,
  NAV_GROUPS, MENU_HIDDEN, REPORT_SECTIONS, isReportSection, allowedTabs, setHomeLocation, adminHeaders, defaultTabFor, isOwnerRole, handleUnauthorized, STORES_CHANGED_EVENT, navItemFor, navGroupFor, toneFor, getHomeLocation, isStoreLogin,
} from "../../../lib/admin";
import dynamic from "next/dynamic";
import { API_URL } from "../../../config";
import { wakeFetch } from "../../../lib/wake-fetch";
import { cachedGet, saveCopy, savedCopy, useOffline } from "../../../lib/offlineCache";
import { PLACES_PATH } from "../../../lib/store-identity";
import { askConfirm } from "../../../lib/ask";
import { queuedSteps } from "../../../lib/offlineQueue";

/** Screens that work with no internet; every other screen still opens, but read-only (its buttons are off). */
// Settings opens offline too: Printer is kept on this tablet, the other groups lock their own buttons.
// Orders opens offline from the saved copy; its changing buttons lock themselves.
const OFFLINE_READY = new Set(["home", "pos", "preorders", "settings", "orders"]);

const STORES_PATH = "/admin/stores/mine";
import { resumePendingReceipt } from "../../../lib/slip-print";
import { useLang, LANG_WORDS } from "../../../lib/lang";
import QueueBadge, { SyncBar } from "../../../components/admin/QueueBadge";
import StaffHome from "../../../components/admin/StaffHome";
import TextSizePicker from "../../../components/admin/TextSizePicker";
import LockScreen from "../../../components/admin/LockScreen";
import StoreLockSettings from "../../../components/admin/StoreLockSettings";
import ThisStoreSettings from "../../../components/admin/ThisStoreSettings";
import OrderAlerts from "../../../components/admin/OrderAlerts";
import { OPEN_ORDER_EVENT, OPEN_ORDER_KEY } from "../../../lib/order-pulse";
import { anyLockFor, isScreenClosed, isScreenLocked, lockAgain, storeLockOf, whoLocks, useFeatureLock } from "../../../lib/feature-lock";

/** Rice Ops M10: the store screens get the large, high-contrast look (globals.css .rice-ui). */
const RICE_TABS = new Set(["zreads", "pos", "preorders", "orders", "utang", "utangrice", "agentorders", "agent", "approvals", "moves", "returns", "resack", "pasok", "purchaseorders", "bilangin", "storereport", "profit", "payable", "ulat", "drafts", "kargadors", "settings", "expenses", "cash", "storeprices", "storelock", "mystore", "storelink",
  // 2026-11-12, step 4 of the app review: the last old-look screens get the same large, easy-read look.
  "products", "inventory", "warehouses", "customers", "overview", "reports"]);
// The landing panel stays eager (it is the first paint); every other panel loads when
// its tab opens. Shipping every panel at once cost ~95 kB of route JS for one visible screen,
// and dragged jsbarcode/qrcode (used by two panels) into the initial payload.
import OverviewPanel from "../../../components/admin/OverviewPanel";

const panelLoading = () => (
  <div className="d-flex justify-content-center py-5" role="status">
    <div className="spinner-border text-primary"></div>
    <span className="ms-2 text-muted">Loading…</span>
  </div>
);
const panel = (loader: () => Promise<{ default: React.ComponentType<PanelProps> }>) =>
  dynamic(loader, { ssr: false, loading: panelLoading });

interface PanelProps { onNavigate?: (tab: string) => void; role?: string; onAgentOrders?: () => void }

const OrdersPanel = panel(() => import("../../../components/admin/OrdersPanel"));
const ProductsPanel = panel(() => import("../../../components/admin/ProductsPanel"));
const SettingsPanel = panel(() => import("../../../components/admin/SettingsPanel"));
const VouchersPanel = panel(() => import("../../../components/admin/VouchersPanel"));
const StoresPanel = panel(() => import("../../../components/admin/StoresPanel"));
const CustomersPanel = panel(() => import("../../../components/admin/CustomersPanel"));
const CrmPanel = panel(() => import("../../../components/admin/CrmPanel"));
const ErpPanel = panel(() => import("../../../components/admin/ErpPanel"));
const AnalyticsPanel = panel(() => import("../../../components/admin/AnalyticsPanel"));
const MaintenancePanel = panel(() => import("../../../components/admin/MaintenancePanel"));
const TeamPanel = panel(() => import("../../../components/admin/TeamPanel"));
const WarehousesPanel = panel(() => import("../../../components/admin/WarehousesPanel"));
const UserAccessPanel = panel(() => import("../../../components/admin/UserAccessPanel"));
const PreOrdersPanel = panel(() => import("../../../components/admin/PreOrdersPanel"));
const CounterSettingsPanel = panel(() => import("../../../components/admin/CounterSettingsPanel"));
const ExpensesPanel = panel(() => import("../../../components/admin/ExpensesPanel"));
const CashPanel = panel(() => import("../../../components/admin/CashPanel"));
const StorePricesPanel = panel(() => import("../../../components/admin/StorePricesPanel"));
const PurchasesPanel = panel(() => import("../../../components/admin/PurchasesPanel"));
const InventoryPanel = panel(() => import("../../../components/admin/InventoryPanel"));
const StoreLinkPanel = panel(() => import("../../../components/admin/StoreLinkPanel"));
const ExportPanel = panel(() => import("../../../components/admin/ExportPanel"));
const ReportsPanel = panel(() => import("../../../components/admin/ReportsPanel"));
const ApprovalsPanel = panel(() => import("../../../components/admin/ApprovalsPanel"));
const DraftsPanel = panel(() => import("../../../components/admin/DraftsPanel"));
const KargadorsPanel = panel(() => import("../../../components/admin/KargadorsPanel"));
const MovePanel = panel(() => import("../../../components/admin/MovePanel"));
const ReturnsPanel = panel(() => import("../../../components/admin/ReturnsPanel"));
const ResackPanel = panel(() => import("../../../components/admin/ResackPanel"));
// POS = the full sale screen (the separate Walk-in quick-sale screen was removed 2026-11-07).
const PosPanel = panel(() => import("../../../components/admin/BentaPanel"));
const PasokPanel = panel(() => import("../../../components/admin/PasokPanel"));
const UtangRicePanel = panel(() => import("../../../components/admin/UtangRicePanel"));
const AgentPanel = panel(() => import("../../../components/admin/AgentPanel"));
const AgentOrdersPanel = panel(() => import("../../../components/admin/AgentOrdersPanel"));
const BilanginPanel = panel(() => import("../../../components/admin/BilanginPanel"));
const StoreReportPanel = panel(() => import("../../../components/admin/StoreReportPanel"));
const ProfitPanel = panel(() => import("../../../components/admin/ProfitPanel"));
const PayablePanel = panel(() => import("../../../components/admin/PayablePanel"));
const PurchaseOrdersPanel = panel(() => import("../../../components/admin/PurchaseOrdersPanel"));
const UlatPanel = panel(() => import("../../../components/admin/UlatPanel"));
const ZReadsPanel = panel(() => import("../../../components/admin/ZReadsPanel"));

/**
 * Bottom bar for counter staff: the six jobs they do all day, one tap each, plus
 * "More" for the full menu. Phones and tablets held either way (hidden only on a PC with a mouse, where the sidebar shows). It only changes what is easy to
 * reach: the server still decides what each role may do.
 */
const STAFF_BAR: { id: string; label: string; icon: string; wideOnly?: boolean }[] = [
  { id: "pos", label: "POS", icon: "bi-basket" },
  { id: "preorders", label: "Pre-order", icon: "bi-bag-check" },
  { id: "resack", label: "Resack", icon: "bi-arrow-repeat" },
  { id: "utang", label: "Credit", icon: "bi-journal-text" },
  { id: "orders", label: "Orders", icon: "bi-receipt" },
  // 2026-11-16: Move stock (Stock group, blue) added last so the five old buttons keep their place.
  { id: "moves", label: "Move", icon: "bi-arrow-left-right", wideOnly: true }, // on a narrow phone it stays in More
];

/** Roles that get the bottom bar: the same six jobs for staff, manager and owner. */
const BAR_ROLES = ["STAFF", "MANAGER", "OWNER", "STORE_OWNER"];
/** Menu ids that open the same screen as a bar button. */
const BAR_ALIAS: Record<string, string> = { utangrice: "utang", agentorders: "orders" };

/** Screens opened by a bar button that the menu lists under another id (for the page title and icon). */
const NAV_ID: Record<string, string> = { utang: "utangrice" };

interface MyStore { id: string; name: string; slug: string; role: string; }

export default function AdminDashboard() {
  const { t } = useLang();
  const navLabel = (id: string, label: string) => (LANG_WORDS[`nav.${id}`] ? t(`nav.${id}`) : label);
  const router = useRouter();
  const [authed, setAuthed] = useState(false);
  const [stores, setStores] = useState<MyStore[]>([]);
  const [activeStore, setActiveStore] = useState<string | null>(null);
  const [role, setRole] = useState("");
  // Step 6 (the wall): the login's home store decides which screens the menu offers.
  const [, setHomeSeen] = useState<string | null>(null);
  useEffect(() => {
    if (!authed || !activeStore) return;
    let off = false;
    fetch(`${API_URL}/admin/me/rice`, { headers: adminHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((me) => { if (!off && me) { setHomeLocation(me.homeLocationId ?? null, !!me.isHead); setHomeSeen(`${me.homeLocationId ?? ""}:${me.isHead ? 1 : 0}`); } })
      .catch(() => { /* offline: the saved answer stays */ });
    // Step 9: keep the stores' own receipt names and targets on the tablet, for receipts printed offline.
    void cachedGet(PLACES_PATH).catch(() => null);
    return () => { off = true; };
  }, [authed, activeStore]);
  const [email, setEmail] = useState("");
  const [tab, setTabState] = useState("overview");
  const tabRef = useRef("overview");
  /**
   * Open a screen and write it in the address (?tab=…), so the tablet's Back button goes to the screen
   * before (it used to leave the app) and a reload stays on the same screen (it used to return to Overview).
   * `replace` = do not add a Back step (the first screen after signing in).
   */
  const setTab = useCallback((id: string, replace = false) => {
    tabRef.current = id;
    setTabState(id);
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("tab") === id) return;
      url.searchParams.set("tab", id);
      window.history[replace ? "replaceState" : "pushState"](window.history.state, "", url);
    } catch { /* an odd browser: the screen still opens */ }
  }, []);
  const [mobileNav, setMobileNav] = useState(false);
  // The Menu drawer stays on screen for a moment after it is closed, so it can slide away (motion.css).
  const [drawerShown, setDrawerShown] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuCloseRef = useRef<HTMLButtonElement>(null);
  const swipeFrom = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (mobileNav) { setDrawerShown(true); return; }
    if (!drawerShown) return;
    const still = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(() => setDrawerShown(false), still ? 0 : 200);
    return () => clearTimeout(timer);
  }, [mobileNav, drawerShown]);
  // Keyboard users land on Close when the Menu opens, and go back to the Menu button when it closes.
  const closeMenu = useCallback(() => {
    setMobileNav(false);
    if (menuBtnRef.current && menuBtnRef.current.offsetParent !== null) menuBtnRef.current.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!mobileNav) return;
    menuCloseRef.current?.focus({ preventScroll: true });
    // The open screen's row is in view when the Menu opens (the list is longer than the screen).
    document.querySelector<HTMLElement>(".menu-panel .nav-link.active")?.scrollIntoView({ block: "center" });
  }, [mobileNav]);
  // Whether we know which stores this account can reach. Without this the shell
  // renders while the answer is still "none", and every tab answers 403.
  const [storesStatus, setStoresStatus] = useState<"loading" | "ready" | "error">("loading");
  const [waking, setWaking] = useState(false); // the sleeping beta server is starting up
  // Each time another screen opens, its title and content fade in once (two same-looking animations take turns,
  // so the fade plays again without re-making the screen).
  const [shown, setShown] = useState({ tab: "overview", n: 0 });
  if (shown.tab !== tab) setShown({ tab, n: shown.n + 1 });
  const enterClass = shown.n % 2 ? "screen-in-a" : "screen-in-b";
  const offline = useOffline();
  const locked = offline && !OFFLINE_READY.has(tab);
  // PIN lock: screens the owner locked show the PIN pad instead, until the right PIN (works offline).
  const pinLock = useFeatureLock(activeStore);
  const userNavigated = useRef(false);

  const loadStores = useCallback(async () => {
    const token = getAdminToken();
    if (!token) return;
    // Offline in the store: open right away with the store list saved on this tablet, then refresh it.
    const kept = savedCopy<{ stores?: MyStore[] }>(STORES_PATH, { perStore: false });
    const applyStores = (mine: MyStore[]) => {
      setStores(mine);
      const firstId = mine[0]?.id;
      if (!getAdminStoreId() && firstId) setAdminStoreId(firstId);
      setActiveStore(getAdminStoreId());
      // M7 vocab fix: nav role comes from the ACTIVE store's membership role
      // (OWNER/…) — the JWT global role can lag it (e.g. an owner whose global
      // role is still STORE_OWNER or a stale STAFF after promotion).
      const member = mine.find((s) => s.id === getAdminStoreId());
      if (member?.role) {
        if (member.role === "DELIVERY") {
          router.replace("/admin/delivery");
          return;
        }
        setRole(isOwnerRole(member.role) ? "OWNER" : member.role);
        const memberRole = isOwnerRole(member.role) ? "OWNER" : member.role;
        // A screen named in the address that this login may not open (an old link, another person's tablet) falls back to the start screen.
        const open = BAR_ALIAS[tabRef.current] ?? tabRef.current;
        const mayOpen = tabRef.current === "home" ? BAR_ROLES.includes(memberRole) : allowedTabs(memberRole).some((t) => (BAR_ALIAS[t] ?? t) === open);
        if (!userNavigated.current || !mayOpen) setTab(defaultTabFor(memberRole), true);
      }
      setStoresStatus("ready");
    };
    const keptStores = kept?.stores ?? [];
    const fromKept = keptStores.length > 0;
    if (fromKept) applyStores(keptStores);
    else setStoresStatus("loading");
    try {
      if (fromKept && typeof navigator !== "undefined" && navigator.onLine === false) return;
      const res = await wakeFetch(`${API_URL}${STORES_PATH}`, { headers: { Authorization: `Bearer ${token}` } }, fromKept ? () => {} : setWaking);
      if (handleUnauthorized(res)) return;
      if (!res.ok) {
        if (!fromKept) setStoresStatus("error");
        return;
      }
      const data = await res.json();
      const mine: MyStore[] = (data?.stores ?? []) as MyStore[];
      if (mine.length > 0) {
        saveCopy(STORES_PATH, data, { perStore: false });
        applyStores(mine);
        return;
      }

      // No membership at all. A platform operator is meant to reach every tenant,
      // so offer the platform-wide list and let them target a store explicitly
      // (see auth/tenant-context.ts:52). Anyone else genuinely has no store yet.
      if (getAdminRole() === "PLATFORM_ADMIN") {
        const all = await fetch(`${API_URL}/admin/stores`, { headers: { Authorization: `Bearer ${token}` } });
        if (handleUnauthorized(all)) return;
        const body = all.ok ? await all.json() : null;
        const listed = (body?.stores ?? []) as Array<{ id: string; name: string; slug: string }>;
        const platform: MyStore[] = listed.map((s) => ({ ...s, role: "platform" }));
        if (platform.length > 0) {
          setStores(platform);
          // Deliberately NOT auto-selecting: the operator picks which tenant to view.
          const kept = getAdminStoreId();
          setActiveStore(platform.some((s) => s.id === kept) ? kept : null);
        }
      }
      setStoresStatus("ready");
    } catch {
      if (!fromKept) setStoresStatus("error");
    }
  }, [router, setTab]);

  // PC sidebar: keep the open screen's menu item in view (the menu is longer than the screen).
  useEffect(() => {
    const el = typeof document !== "undefined" ? document.querySelector<HTMLElement>("aside.admin-sidebar .nav-link.active") : null;
    if (el && el.offsetParent !== null) el.scrollIntoView({ block: "nearest" });
  }, [tab, authed, storesStatus]);

  // A receipt that could not print before the app was closed is offered again.
  useEffect(() => { resumePendingReceipt(); }, []);
  useEffect(() => {
    const token = getAdminToken();
    if (!token) {
      router.replace("/admin/login");
      return;
    }
    const r = getAdminRole();
    if (r === "DELIVERY") {
      router.replace("/admin/delivery");
      return;
    }
    setRole(r);
    // The screen named in the address wins (a reload, or Back from another page); else the role's start screen.
    const asked = new URLSearchParams(window.location.search).get("tab") ?? "";
    // A screen this login may not open (e.g. a report link kept from before) falls back to its start screen.
    if (asked && (asked === "home" || asked === "utang" || (navItemFor(asked) && allowedTabs(r).includes(asked)))) { userNavigated.current = true; setTab(asked, true); }
    else setTab(defaultTabFor(r), true);
    setAuthed(true);
    setActiveStore(getAdminStoreId());
    fetch(`${API_URL}/admin/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => {
        if (handleUnauthorized(res)) return null;
        return res.ok ? res.json() : null;
      })
      .then((d) => d && setEmail(d.email ?? ""))
      .catch(() => {});
    void loadStores();
  }, [router, loadStores, setTab]);

  // Settings → Business name: show the new name at the top of the menu straight away.
  useEffect(() => {
    const again = () => { void loadStores(); };
    window.addEventListener(STORES_CHANGED_EVENT, again);
    return () => window.removeEventListener(STORES_CHANGED_EVENT, again);
  }, [loadStores]);

  // Back / Forward on the tablet: show the screen the address now names.
  useEffect(() => {
    const onPop = () => {
      const id = new URLSearchParams(window.location.search).get("tab");
      if (!id) return;
      userNavigated.current = true;
      tabRef.current = id;
      setTabState(id);
      setMobileNav(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const switchStore = (storeId: string) => {
    setAdminStoreId(storeId);
    setActiveStore(storeId);
    // Panels refetch on remount via the key below — no full page reload.
  };

  const logout = () => {
    lockAgain();
    clearAdminSession();
    router.push("/admin/login");
  };

  /**
   * Leaving needs a yes: one wrong tap used to log the tablet out at once. With no internet nobody can log in
   * again until it is back, and sales still waiting to upload stay on the tablet until the same person returns.
   */
  const sureToLeave = async (what: "logout" | "switch"): Promise<boolean> => {
    const noNet = typeof navigator !== "undefined" && navigator.onLine === false;
    let waiting = 0;
    try { waiting = queuedSteps().length; } catch { /* nothing waiting */ }
    if (what === "switch" && !noNet && waiting === 0) return true; // handing over at the counter: no extra question
    const lines = [what === "logout" ? "Log out of this tablet?" : "Switch to another person?"];
    if (noNet) lines.push("There is no internet now. Nobody can log in again until it is back.");
    if (waiting > 0) lines.push(`${waiting} saved ${waiting === 1 ? "entry is" : "entries are"} still waiting to upload. ${waiting === 1 ? "It uploads" : "They upload"} only when you log in again.`);
    return askConfirm(lines.join(" "), { ok: what === "logout" ? "Log out" : "Switch user", cancel: "Stay", danger: noNet || waiting > 0 });
  };
  const askLogout = async () => { if (await sureToLeave("logout")) logout(); };

  // Rice Ops M2: hand the phone to the next person — they log in with their own PIN.
  const switchUser = async () => {
    if (!(await sureToLeave("switch"))) return;
    lockAgain();
    clearAdminSession();
    router.push("/admin/login?pin=1");
  };

  if (!authed) return null;

  if (storesStatus === "loading" && waking) {
    return (
      <div className="container d-flex align-items-center justify-content-center" style={{ minHeight: "100vh" }}>
        <div className="card shadow-sm p-4 text-center" style={{ width: "100%", maxWidth: 460 }} role="status">
          <div className="spinner-border text-success mx-auto" aria-hidden="true"></div>
          <h4 className="mt-3 mb-2">Starting the server</h4>
          <p className="text-muted mb-0">It was asleep. This can take a minute or two — please wait, it opens by itself.</p>
        </div>
      </div>
    );
  }

  // A signed-in account that reaches no store gets an explanation, not a tab shell
  // where every panel answers 403. A platform admin is excluded: an empty
  // /admin/stores/mine is normal for them and the platform list fills in above.
  if (storesStatus === "ready" && stores.length === 0 && role !== "PLATFORM_ADMIN") {
    return (
      <div className="container d-flex align-items-center justify-content-center" style={{ minHeight: "100vh" }}>
        <div className="card shadow-sm p-4 text-center" style={{ width: "100%", maxWidth: 460 }}>
          <i className="bi bi-shop-window fs-1 text-secondary"></i>
          <h4 className="mt-3 mb-2">No store linked yet</h4>
          <p className="text-muted small mb-3">
            Your account is ready, but it is not connected to a store, so there is nothing to
            show yet. A platform admin has to create your store or invite you to one — then
            check again.
          </p>
          {email && <p className="small mb-3">Signed in as <strong>{email}</strong></p>}
          <button
            className="btn btn-primary w-100"
            onClick={() => { void loadStores(); }}
          >
            Check again
          </button>
          <button className="btn btn-link btn-sm w-100 mt-2" onClick={logout}>Sign out</button>
        </div>
      </div>
    );
  }

  if (storesStatus === "error") {
    return (
      <div className="container d-flex align-items-center justify-content-center" style={{ minHeight: "100vh" }}>
        <div className="card shadow-sm p-4 text-center" style={{ width: "100%", maxWidth: 460 }}>
          <i className="bi bi-exclamation-triangle fs-1 text-warning"></i>
          <h4 className="mt-3 mb-2">Could not load your stores</h4>
          <p className="text-muted small mb-3">
            The server could not be reached. Your session is still valid — try again.
          </p>
          <button className="btn btn-primary w-100" onClick={() => { void loadStores(); }}>Retry</button>
          <button className="btn btn-link btn-sm w-100 mt-2" onClick={logout}>Sign out</button>
        </div>
      </div>
    );
  }

  const active = stores.find((s) => s.id === activeStore);
  const allowed = allowedTabs(role);
  const visibleGroups = NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((i) => allowed.includes(i.id) && !MENU_HIDDEN.has(i.id)) }))
    .filter((g) => g.items.length > 0);

  // A login tied to one store also gets that store's own lock (set by its head, a manager or the owner).
  const lockHome = isStoreLogin(role) ? getHomeLocation() : null;
  const pinLocked = (id: string) => isScreenLocked(pinLock.lock, role, id, lockHome);
  const pinClosed = (id: string) => isScreenClosed(pinLock.lock, role, id, lockHome, pinLock.open);
  const showPinPad = tab !== "home" && pinClosed(tab);
  const anyPinLock = anyLockFor(pinLock.lock, role, lockHome);
  const anyOpen = pinLock.open.all || pinLock.open.store;
  const lockIcon = (id: string) => (pinLocked(id)
    ? <i className={`bi ${pinClosed(id) ? "bi-lock-fill" : "bi-unlock"} ms-auto nav-lock`} role="img" aria-label={pinClosed(id) ? "Needs the lock PIN" : "Locked screen, open now"}></i>
    : null);

  const renderTab = () => {
    switch (tab) {
      case "home": return <StaffHome role={role} onNavigate={(id) => { userNavigated.current = true; setTab(id); }} labelFor={navLabel} isLocked={pinClosed} />;
      case "overview": return <OverviewPanel onNavigate={setTab} storeName={active?.name} />;
      // One POS: the rice-ready counter screen.
      case "pos": return <PosPanel />;
      case "preorders": return <PreOrdersPanel onNavigate={setTab} />;
      case "utang": // the bar id; the menu id is "utangrice" (one merged Credit screen)
      case "utangrice": return <UtangRicePanel role={role} />;
      case "inventory": return <InventoryPanel role={role} />;
      case "expenses": return <ExpensesPanel />;
      case "cash": return <CashPanel />;
      case "storeprices": return <StorePricesPanel />;
      case "storelock": return <StoreLockSettings role={role} />;
      case "mystore": return <ThisStoreSettings standalone />;
      case "purchases": return <PurchasesPanel />;
      case "storelink": return <StoreLinkPanel />;
      case "reports": return <ReportsPanel />;
      case "export": return <ExportPanel />;
      case "orders": return BAR_ROLES.includes(role) ? <OrdersWithAgents /> : <OrdersPanel />;
      case "products": return <ProductsPanel role={role} />;
      case "settings": return <SettingsPanel role={role} />;
      case "countersettings": return <CounterSettingsPanel />;
      case "vouchers": return <VouchersPanel />;
      case "team": return <TeamPanel />;
      case "customers": return <CustomersPanel />;
      case "crm": return <CrmPanel />;
      case "erp": return <ErpPanel />;
      case "analytics": return <AnalyticsPanel />;
      case "maintenance": return <MaintenancePanel />;
      case "useraccess": return <UserAccessPanel />;
      case "warehouses": return <WarehousesPanel onNavigate={setTab} />;
      case "approvals": return <ApprovalsPanel />;
      case "drafts": return <DraftsPanel />;
      case "kargadors": return <KargadorsPanel />;
      case "moves": return <MovePanel />;
      case "returns": return <ReturnsPanel />;
      case "resack": return <ResackPanel />;
      case "pasok": return <PasokPanel role={role} />;
      case "agent": return <AgentPanel />;
      case "agentorders": return <AgentOrdersPanel />;
      case "bilangin": return <BilanginPanel role={role} onNavigate={setTab} />;
      case "storereport": return <StoreReportPanel role={role} onNavigate={setTab} />;
      case "profit": return <ProfitPanel onNavigate={setTab} />;
      case "payable": return <PayablePanel />;
      case "purchaseorders": return <PurchaseOrdersPanel />;
      case "ulat": return <UlatPanel role={role} onNavigate={setTab} />;
      case "zreads": return <ZReadsPanel role={role} />;
      case "stores": return <StoresPanel />;
      default: return <OrdersPanel />;
    }
  };

  // `desktop` = the sidebar of a PC with a mouse (hidden on every touch screen); the tablet drawer keeps the plain footer.
  // The selling screens get a slim top bar with no Menu button, when the bottom bar ("More") is there to reach the rest.
  const slimTop = (tab === "pos" || tab === "preorders") && BAR_ROLES.includes(role);
  const renderSidebar = (desktop: boolean) => (
    <div className="d-flex flex-column h-100">
      {desktop ? (
        <div className="p-3 border-bottom">
          <div className="fw-bold h6 mb-0 d-flex align-items-center gap-2">
            <i className="bi bi-shop fs-6"></i>
            {active?.name ?? "Store Admin"}
          </div>
          {active && role === "PLATFORM_ADMIN" && <small>{active.slug}</small>}
        </div>
      ) : (
        <div className="menu-head">
          <span className="menu-brand" aria-hidden="true"><i className="bi bi-shop"></i></span>
          <div className="min-w-0 flex-grow-1">
            <div className="menu-brand-name">{active?.name ?? "Store Admin"}</div>
            <div className="menu-brand-sub">{active && role === "PLATFORM_ADMIN" ? active.slug : "Menu"}</div>
          </div>
          <button ref={menuCloseRef} type="button" className="menu-close" onClick={closeMenu} aria-label="Close menu">
            <i className="bi bi-x-lg" aria-hidden="true"></i>
          </button>
        </div>
      )}
      <nav className="flex-grow-1 overflow-auto py-2">
        {visibleGroups.map((g) => (
          <div key={g.group} className={`mb-2 tone-${g.tone}`}>
            <div className="nav-group-label px-3">{g.label}</div>
            <ul className="nav flex-column">
              {g.items.map((item) => (
                <li className="nav-item" key={item.id}>
                  <button
                    className={`nav-link w-100 text-start d-flex align-items-center gap-2 ${tab === item.id || (item.id === "overview" && isReportSection(tab)) ? "active" : ""}`}
                    onClick={() => { userNavigated.current = true; setTab(item.id); setMobileNav(false); }}
                  >
                    <i className={`bi ${item.icon}`}></i>
                    <span>{navLabel(item.id, item.label)}</span>
                    {lockIcon(item.id)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      {desktop ? (
        <div className="side-foot border-top">
          <TextSizePicker />
          <div className="side-who">
            <i className="bi bi-person-circle" aria-hidden="true"></i>
            <div className="min-w-0">
              <div className="side-email" title={email || "Admin"}>{email || "Admin"}</div>
              <div className="side-role" title={`${role}${active?.name ? ` · ${active.name}` : ""}`}>{role}{active?.name ? ` · ${active.name}` : ""}</div>
            </div>
          </div>
          <div className="side-actions">
            <button type="button" className="btn side-btn" onClick={() => void switchUser()} title="Switch user (PIN)">
              <i className="bi bi-arrow-left-right" aria-hidden="true"></i>Switch user
            </button>
            <button type="button" className="btn side-btn side-btn-out" onClick={() => void askLogout()}>
              <i className="bi bi-box-arrow-right" aria-hidden="true"></i>Log out
            </button>
          </div>
        </div>
      ) : (
        <div className="menu-foot">
          <TextSizePicker />
          <div className="menu-who">
            <span className="menu-avatar" aria-hidden="true">{(email || "A").trim().charAt(0).toUpperCase()}</span>
            <div className="min-w-0">
              <div className="menu-who-name">{email || "Admin"}</div>
              <div className="menu-who-role">{role}{active?.name ? ` · ${active.name}` : ""}</div>
            </div>
          </div>
          <button type="button" className="btn menu-act w-100" onClick={() => void switchUser()}>
            <i className="bi bi-arrow-left-right" aria-hidden="true"></i>Switch user (PIN)
          </button>
          <button type="button" className="btn menu-act menu-act-out w-100" onClick={() => void askLogout()}>
            <i className="bi bi-box-arrow-right" aria-hidden="true"></i>Log out
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div key={activeStore ?? "none"} className="admin-shell d-flex min-vh-100">
      {/* Sidebar: PC with a mouse only. Touch screens (phone, tablet either way) get the bottom bar. */}
      <aside className="admin-sidebar d-none d-lg-flex flex-column" style={{ width: 240, position: "sticky", top: 0, height: "100vh" }}>
        {renderSidebar(true)}
      </aside>

      {/* Drawer: phones and tablets (either way), from the menu button; same dark look as the sidebar */}
      {(mobileNav || drawerShown) && (
        <div className={`menu-layer d-lg-none touch-show-block${mobileNav ? "" : " is-closing"}`} role="dialog" aria-modal="true" aria-label="Menu"
          onKeyDown={(e) => { if (e.key === "Escape") closeMenu(); }}>
          <div className="menu-backdrop" onClick={closeMenu}></div>
          {/* The drawer is exactly one screen tall and scrolls by itself (admin-drawer in globals.css), so the
              last screens, Text size, Switch user and Log out can always be reached with a finger, at any text size.
              A swipe to the left closes it, like the tap outside. */}
          <div className="menu-panel admin-sidebar admin-drawer"
            onTouchStart={(e) => { const p = e.touches[0]; swipeFrom.current = p ? { x: p.clientX, y: p.clientY } : null; }}
            onTouchEnd={(e) => {
              const from = swipeFrom.current; const p = e.changedTouches[0];
              swipeFrom.current = null;
              if (!from || !p) return;
              const dx = p.clientX - from.x; const dy = p.clientY - from.y;
              if (dx < -70 && Math.abs(dx) > Math.abs(dy) * 2) closeMenu();
            }}>
            {renderSidebar(false)}
          </div>
        </div>
      )}

      {/* Main */}
      <div className="flex-grow-1 d-flex flex-column" style={{ minWidth: 0 }}>
        {/* Topbar */}
        {/* On the selling screens (POS, Pre-order) the bar is one slim line, so the price list gets the height,
            and it has no Menu button: nothing to open by mistake in the middle of a sale. The Menu (every
            screen, Text size, Switch user, Log out) is one tap away under "More" on the bottom bar. */}
        <nav className={`admin-topbar navbar navbar-expand py-2${slimTop ? " topbar-slim" : ""}`}>
          <div className="container-fluid">
            {!slimTop && (
              <button ref={menuBtnRef} type="button" className="menu-open d-lg-none touch-show me-2" onClick={() => setMobileNav(true)}
                aria-label="Menu" aria-haspopup="dialog" aria-expanded={mobileNav}>
                <span className="menu-open-in">
                  <span className="menu-bars" aria-hidden="true"><span></span><span></span><span></span></span>
                  <span className="menu-open-word" aria-hidden="true">Menu</span>
                </span>
              </button>
            )}
            {/* The screen's icon on its group colour, its name, and one line on what it is for. */}
            {(() => {
              const id = NAV_ID[tab] ?? tab;
              const n = navItemFor(id);
              const group = navGroupFor(id);
              const name = role === "DELIVERY" ? "Courier" : tab === "home" ? "Home" : n ? navLabel(n.id, n.label) : "Dashboard";
              const icon = role === "DELIVERY" ? "bi-truck" : tab === "home" ? "bi-grid-3x3-gap" : (n?.icon ?? "bi-speedometer2");
              const hint = tab === "home" ? "Every screen, grouped by what it is for" : n?.hint;
              return (
                <div className={`screen-title ${enterClass} ${group ? `tone-${group.tone}` : "tone-setup"}`}>
                  <span className="screen-chip" aria-hidden="true"><i className={`bi ${icon}`}></i></span>
                  <div className="min-w-0">
                    <div className="screen-name">{name}</div>
                    {hint && <div className="screen-hint">{hint}</div>}
                  </div>
                </div>
              );
            })()}
            <div className="ms-auto d-flex align-items-center gap-2">
              {(stores.length > 1 || (role === "PLATFORM_ADMIN" && stores.length > 0)) && (
                <select
                  className="form-select form-select-sm"
                  style={{ width: "min(190px, 40vw)" }}
                  value={activeStore ?? ""}
                  onChange={(e) => e.target.value && switchStore(e.target.value)}
                >
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.role})</option>
                  ))}
                </select>
              )}
              {anyPinLock && anyOpen && (
                <button type="button" className="btn btn-sm btn-outline-dark lock-now" onClick={lockAgain} title="Lock the locked screens again">
                  <i className="bi bi-lock-fill me-1" aria-hidden="true"></i>Lock
                </button>
              )}
              <QueueBadge />
              <span className="badge text-bg-primary role-badge text-uppercase d-none d-sm-inline">{role}</span>
{/* Log out lives in the Menu (bottom) only: the picture-only button here was one wrong tap away from locking the tablet out. */}
            </div>
          </div>
        </nav>
        <SyncBar />
        {/* Live new-order alerts on every screen (not for sales agents or couriers). */}
        {allowed.includes("orders") && role !== "SALES_AGENT" && role !== "DELIVERY" && (
          <OrderAlerts onOpen={(id) => {
            userNavigated.current = true;
            try { sessionStorage.setItem(OPEN_ORDER_KEY, id); } catch { /* the event below still opens it */ }
            setTab("orders");
            setMobileNav(false);
            window.dispatchEvent(new CustomEvent(OPEN_ORDER_EVENT, { detail: id }));
          }} />
        )}

        <main className={`container-fluid py-4 flex-grow-1${BAR_ROLES.includes(role) ? " has-staff-bar" : ""}`} style={{ background: "var(--sam-bg)" }}>
          {showPinPad && pinLock.lock ? (
            <LockScreen
              lock={pinLock.lock}
              kind={whoLocks(pinLock.lock, role, tab, lockHome) ?? "owner"}
              storeLock={storeLockOf(pinLock.lock, lockHome)}
              screenName={(() => { const n = navItemFor(NAV_ID[tab] ?? tab); return n ? navLabel(n.id, n.label) : "This screen"; })()}
              ownerSignedIn={isOwnerRole(role)}
              onBack={() => { userNavigated.current = true; setTab(BAR_ROLES.includes(role) ? "home" : defaultTabFor(role)); }}
            />
          ) : <>
          {locked && (
            <div className="alert alert-secondary d-flex align-items-center gap-2" role="status">
              <i className="bi bi-lock fs-4"></i>
              <div><div className="fw-semibold">Needs internet</div><div className="small">You can open this screen, but its buttons are off until the tablet is online. POS and Pre-order work offline.</div></div>
            </div>
          )}
          {/* Always the same wrapper, so going offline locks the screen without reloading it. */}
          {isReportSection(tab) && (() => {
            const parts = REPORT_SECTIONS.filter((r) => allowed.includes(r.id));
            return parts.length > 1 ? (
              <div className="report-sections tone-report d-flex flex-wrap gap-2 mb-3" role="group" aria-label="Reports">
                {parts.map((r) => (
                  <button key={r.id} type="button" className={`btn btn-lg ${tab === r.id ? "active" : ""}`} aria-pressed={tab === r.id} onClick={() => { userNavigated.current = true; setTab(r.id); }}>{r.label}</button>
                ))}
              </div>
            ) : null;
          })()}
          <fieldset disabled={locked} className={`border-0 p-0 m-0 screen-body ${enterClass}`} style={{ minWidth: 0 }}>
            {RICE_TABS.has(tab) ? <div className="rice-ui p-2 rounded">{renderTab()}</div> : renderTab()}
          </fieldset>
          </>}
        </main>

        {BAR_ROLES.includes(role) && (() => {
          // The dark pill slides to the open button (motion.css). On a narrow phone the wide-only buttons
          // are hidden, so the pill gets its own count and place there.
          const items = STAFF_BAR.filter((b) => allowed.includes(b.id));
          const narrow = items.filter((b) => !b.wideOnly);
          const cur = BAR_ALIAS[tab] ?? tab;
          const at = items.findIndex((b) => b.id === cur);
          const atNarrow = narrow.findIndex((b) => b.id === cur);
          const more = at < 0;
          const pill = {
            "--bar-n": items.length + 1, "--bar-i": more ? items.length : at,
            "--bar-n-narrow": narrow.length + 1, "--bar-i-narrow": atNarrow < 0 ? narrow.length : atNarrow,
          } as React.CSSProperties;
          return (
          <nav className="staff-bar d-lg-none" aria-label="Main actions" style={pill}>
            {items.map((b) => (
              <button
                key={b.id}
                type="button"
                className={`tone-${toneFor(NAV_ID[b.id] ?? b.id)}${b.wideOnly ? " bar-wide-only" : ""}${cur === b.id ? " active" : ""}`}
                aria-current={cur === b.id ? "page" : undefined}
                onClick={() => { userNavigated.current = true; setTab(b.id); setMobileNav(false); }}
              >
                <i className={`bi ${b.icon}`}></i>
                <span>{b.label}{pinClosed(b.id) && <i className="bi bi-lock-fill ms-1 bar-lock" role="img" aria-label="Needs the lock PIN"></i>}</span>
              </button>
            ))}
            <button
              type="button"
              className={`${more ? "active" : ""}${!more && atNarrow < 0 ? " active-narrow" : ""}`}
              aria-current={more ? "page" : undefined}
              onClick={() => { userNavigated.current = true; setTab("home"); setMobileNav(false); }}
            >
              <i className="bi bi-grid-3x3-gap"></i>
              <span>More</span>
            </button>
          </nav>
          );
        })()}
      </div>
    </div>
  );
}

/**
 * Orders, with the agents' orders one tap away (2026-11-12: one place for every order instead of two
 * menu screens). Agent orders keep their own steps (approve, delivered, take payment).
 */
function OrdersWithAgents() {
  const [which, setWhich] = useState<"all" | "agent">("all");
  return (
    <>
      <div className="d-flex flex-wrap gap-2 mb-3" role="group" aria-label="Which orders">
        <button type="button" className={`btn btn-lg ${which === "all" ? "btn-primary" : "btn-outline-primary"}`} aria-pressed={which === "all"} onClick={() => setWhich("all")}>
          <i className="bi bi-receipt me-1" aria-hidden="true"></i>All orders
        </button>
        <button type="button" className={`btn btn-lg ${which === "agent" ? "btn-primary" : "btn-outline-primary"}`} aria-pressed={which === "agent"} onClick={() => setWhich("agent")}>
          <i className="bi bi-person-lines-fill me-1" aria-hidden="true"></i>Agent orders
        </button>
      </div>
      {which === "all" ? <OrdersPanel onAgentOrders={() => setWhich("agent")} /> : <AgentOrdersPanel />}
    </>
  );
}
