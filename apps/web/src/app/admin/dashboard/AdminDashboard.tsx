"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getAdminToken, getAdminStoreId, setAdminStoreId, getAdminRole, clearAdminSession,
  NAV_GROUPS, allowedTabs, defaultTabFor, isOwnerRole, handleUnauthorized, navItemFor, navGroupFor, toneFor,
} from "../../../lib/admin";
import dynamic from "next/dynamic";
import { API_URL } from "../../../config";
import { wakeFetch } from "../../../lib/wake-fetch";
import { saveCopy, savedCopy, useOffline } from "../../../lib/offlineCache";

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
import OrderAlerts from "../../../components/admin/OrderAlerts";
import { OPEN_ORDER_EVENT, OPEN_ORDER_KEY } from "../../../lib/order-pulse";
import { isScreenLocked, lockAgain, lockListFor, useFeatureLock } from "../../../lib/feature-lock";

/** Rice Ops M10: the store screens get the large, high-contrast look (globals.css .rice-ui). */
const RICE_TABS = new Set(["pos", "preorders", "orders", "utang", "utangrice", "agentorders", "agent", "approvals", "moves", "returns", "resack", "pasok", "purchaseorders", "bilangin", "storereport", "payable", "ulat", "drafts", "kargadors", "settings", "expenses"]);
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

interface PanelProps { onNavigate?: (tab: string) => void; role?: string }

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
const PayablePanel = panel(() => import("../../../components/admin/PayablePanel"));
const PurchaseOrdersPanel = panel(() => import("../../../components/admin/PurchaseOrdersPanel"));
const UlatPanel = panel(() => import("../../../components/admin/UlatPanel"));

/**
 * Bottom bar for counter staff: the five jobs they do all day, one tap each, plus
 * "More" for the full menu. Phones and tablets held either way (hidden only on a PC with a mouse, where the sidebar shows). It only changes what is easy to
 * reach: the server still decides what each role may do.
 */
const STAFF_BAR: { id: string; label: string; icon: string }[] = [
  { id: "pos", label: "POS", icon: "bi-basket" },
  { id: "preorders", label: "Pre-order", icon: "bi-bag-check" },
  { id: "resack", label: "Resack", icon: "bi-arrow-repeat" },
  { id: "utang", label: "Credit", icon: "bi-journal-text" },
  { id: "orders", label: "Orders", icon: "bi-receipt" },
];

/** Roles that get the bottom bar: the same five jobs for staff, manager and owner. */
const BAR_ROLES = ["STAFF", "MANAGER", "OWNER", "STORE_OWNER"];
/** Menu ids that open the same screen as a bar button. */
const BAR_ALIAS: Record<string, string> = { utangrice: "utang" };

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
  const [email, setEmail] = useState("");
  const [tab, setTab] = useState("overview");
  const [mobileNav, setMobileNav] = useState(false);
  // Whether we know which stores this account can reach. Without this the shell
  // renders while the answer is still "none", and every tab answers 403.
  const [storesStatus, setStoresStatus] = useState<"loading" | "ready" | "error">("loading");
  const [waking, setWaking] = useState(false); // the sleeping beta server is starting up
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
        if (!userNavigated.current) setTab(defaultTabFor(isOwnerRole(member.role) ? "OWNER" : member.role));
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
  }, [router]);

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
    setTab(defaultTabFor(r));
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
  }, [router, loadStores]);

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

  // Rice Ops M2: hand the phone to the next person — they log in with their own PIN.
  const switchUser = () => {
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
    .map((g) => ({ ...g, items: g.items.filter((i) => allowed.includes(i.id)) }))
    .filter((g) => g.items.length > 0);

  const pinLocked = (id: string) => isScreenLocked(pinLock.lock, role, id);
  const showPinPad = tab !== "home" && pinLocked(tab) && !pinLock.open;
  const anyPinLock = !!pinLock.lock?.on && (pinLock.lock[lockListFor(role)]?.length ?? 0) > 0;
  const lockIcon = (id: string) => (pinLocked(id)
    ? <i className={`bi ${pinLock.open ? "bi-unlock" : "bi-lock-fill"} ms-auto nav-lock`} role="img" aria-label={pinLock.open ? "Locked screen, open now" : "Needs the lock PIN"}></i>
    : null);

  const renderTab = () => {
    switch (tab) {
      case "home": return <StaffHome role={role} onNavigate={(id) => { userNavigated.current = true; setTab(id); }} labelFor={navLabel} isLocked={pinLock.open ? undefined : pinLocked} />;
      case "overview": return <OverviewPanel onNavigate={setTab} storeSlug={active?.slug} storeName={active?.name} />;
      // One POS: the rice-ready counter screen.
      case "pos": return <PosPanel />;
      case "preorders": return <PreOrdersPanel onNavigate={setTab} />;
      case "utang": // the bar id; the menu id is "utangrice" (one merged Credit screen)
      case "utangrice": return <UtangRicePanel role={role} />;
      case "inventory": return <InventoryPanel />;
      case "expenses": return <ExpensesPanel />;
      case "purchases": return <PurchasesPanel />;
      case "storelink": return <StoreLinkPanel />;
      case "reports": return <ReportsPanel />;
      case "export": return <ExportPanel />;
      case "orders": return <OrdersPanel />;
      case "products": return <ProductsPanel />;
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
      case "warehouses": return <WarehousesPanel />;
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
      case "payable": return <PayablePanel />;
      case "purchaseorders": return <PurchaseOrdersPanel />;
      case "ulat": return <UlatPanel role={role} onNavigate={setTab} />;
      case "stores": return <StoresPanel />;
      default: return <OrdersPanel />;
    }
  };

  // `desktop` = the sidebar of a PC with a mouse (hidden on every touch screen); the tablet drawer keeps the plain footer.
  const renderSidebar = (desktop: boolean) => (
    <div className="d-flex flex-column h-100">
      <div className="p-3 border-bottom">
        <div className="fw-bold h6 mb-0 d-flex align-items-center gap-2">
          <i className="bi bi-shop fs-6"></i>
          {active?.name ?? "Store Admin"}
        </div>
        {active && <small>{active.slug}</small>}
      </div>
      <nav className="flex-grow-1 overflow-auto py-2">
        {visibleGroups.map((g) => (
          <div key={g.group} className={`mb-2 tone-${g.tone}`}>
            <div className="nav-group-label px-3">{g.label}</div>
            <ul className="nav flex-column">
              {g.items.map((item) => (
                <li className="nav-item" key={item.id}>
                  <button
                    className={`nav-link w-100 text-start d-flex align-items-center gap-2 ${tab === item.id ? "active" : ""}`}
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
            <button type="button" className="btn side-btn" onClick={switchUser} title="Switch user (PIN)">
              <i className="bi bi-arrow-left-right" aria-hidden="true"></i>Switch user
            </button>
            <button type="button" className="btn side-btn side-btn-out" onClick={logout}>
              <i className="bi bi-box-arrow-right" aria-hidden="true"></i>Log out
            </button>
          </div>
        </div>
      ) : (
        <div className="p-3 border-top">
          <div className="mb-3"><TextSizePicker /></div>
          <div className="small fw-semibold">{email || "Admin"}</div>
          <div className="small mb-2">{role} · {active?.name}</div>
          <button className="btn btn-outline-secondary btn-sm w-100 mb-2" onClick={switchUser}>
            <i className="bi bi-arrow-left-right me-1"></i>Switch user (PIN)
          </button>
          <button className="btn btn-outline-danger btn-sm w-100" onClick={logout}>
            <i className="bi bi-box-arrow-right me-1"></i>Log out
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
      {mobileNav && (
        <>
          <div className="modal fade show d-block d-lg-none touch-show-block" tabIndex={-1} role="dialog" aria-modal="true" aria-label="Menu"
            onClick={(e) => { if (e.target === e.currentTarget) setMobileNav(false); }} onKeyDown={(e) => { if (e.key === "Escape") setMobileNav(false); }}>
            <div className="modal-dialog modal-dialog-scrollable" style={{ maxWidth: "min(320px, 85vw)", margin: 0 }}>
              <div className="modal-content admin-sidebar admin-drawer rounded-0 border-end min-vh-100" style={{ minHeight: "100vh" }}>
                {renderSidebar(false)}
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show d-lg-none touch-show-block" onClick={() => setMobileNav(false)}></div>
        </>
      )}

      {/* Main */}
      <div className="flex-grow-1 d-flex flex-column" style={{ minWidth: 0 }}>
        {/* Topbar */}
        <nav className="admin-topbar navbar navbar-expand py-2">
          <div className="container-fluid">
            <button className="btn btn-outline-secondary btn-sm d-lg-none touch-show me-2" onClick={() => setMobileNav(true)} aria-label="Menu">
              <i className="bi bi-list"></i>
            </button>
            {/* The screen's icon on its group colour, its name, and one line on what it is for. */}
            {(() => {
              const id = NAV_ID[tab] ?? tab;
              const n = navItemFor(id);
              const group = navGroupFor(id);
              const name = role === "DELIVERY" ? "Courier" : tab === "home" ? "Home" : n ? navLabel(n.id, n.label) : "Dashboard";
              const icon = role === "DELIVERY" ? "bi-truck" : tab === "home" ? "bi-grid-3x3-gap" : (n?.icon ?? "bi-speedometer2");
              const hint = tab === "home" ? "Every screen, grouped by what it is for" : n?.hint;
              return (
                <div className={`screen-title ${group ? `tone-${group.tone}` : "tone-setup"}`}>
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
              {anyPinLock && pinLock.open && (
                <button type="button" className="btn btn-sm btn-outline-dark lock-now" onClick={lockAgain} title="Lock the locked screens again">
                  <i className="bi bi-lock-fill me-1" aria-hidden="true"></i>Lock
                </button>
              )}
              <QueueBadge />
              <span className="badge text-bg-primary role-badge text-uppercase d-none d-sm-inline">{role}</span>
              {active && (
                <a className="btn btn-sm btn-outline-primary d-none d-sm-inline-block" href={`/${active.slug}`} target="_blank" rel="noreferrer" title="Open storefront" aria-label="Open storefront">
                  <i className="bi bi-box-arrow-up-right"></i>
                </a>
              )}
              <button className="btn btn-sm btn-outline-secondary d-lg-none touch-show" onClick={logout} title="Log out" aria-label="Log out">
                <i className="bi bi-box-arrow-right"></i>
              </button>
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

        <main className={`container-fluid py-4 flex-grow-1${BAR_ROLES.includes(role) ? " has-staff-bar" : ""}`} style={{ background: "#faf7f2" }}>
          {showPinPad && pinLock.lock ? (
            <LockScreen
              lock={pinLock.lock}
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
          <fieldset disabled={locked} className="border-0 p-0 m-0" style={{ minWidth: 0 }}>
            {RICE_TABS.has(tab) ? <div className="rice-ui p-2 rounded">{renderTab()}</div> : renderTab()}
          </fieldset>
          </>}
        </main>

        {BAR_ROLES.includes(role) && (
          <nav className="staff-bar d-lg-none" aria-label="Main actions">
            {STAFF_BAR.filter((b) => allowed.includes(b.id)).map((b) => (
              <button
                key={b.id}
                type="button"
                className={`tone-${toneFor(NAV_ID[b.id] ?? b.id)}${(BAR_ALIAS[tab] ?? tab) === b.id ? " active" : ""}`}
                aria-current={(BAR_ALIAS[tab] ?? tab) === b.id ? "page" : undefined}
                onClick={() => { userNavigated.current = true; setTab(b.id); setMobileNav(false); }}
              >
                <i className={`bi ${b.icon}`}></i>
                <span>{b.label}{pinLocked(b.id) && !pinLock.open && <i className="bi bi-lock-fill ms-1 bar-lock" role="img" aria-label="Needs the lock PIN"></i>}</span>
              </button>
            ))}
            <button
              type="button"
              className={!STAFF_BAR.some((b) => b.id === (BAR_ALIAS[tab] ?? tab)) ? "active" : ""}
              aria-current={!STAFF_BAR.some((b) => b.id === (BAR_ALIAS[tab] ?? tab)) ? "page" : undefined}
              onClick={() => { userNavigated.current = true; setTab("home"); setMobileNav(false); }}
            >
              <i className="bi bi-grid-3x3-gap"></i>
              <span>More</span>
            </button>
          </nav>
        )}
      </div>
    </div>
  );
}
