"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getAdminToken, getAdminStoreId, setAdminStoreId, getAdminRole,
  NAV_GROUPS, allowedTabs, defaultTabFor, isOwnerRole, handleUnauthorized,
} from "../../../lib/admin";
import { API_URL } from "../../../config";
import OverviewPanel from "../../../components/admin/OverviewPanel";
import OrdersPanel from "../../../components/admin/OrdersPanel";
import ProductsPanel from "../../../components/admin/ProductsPanel";
import SettingsPanel from "../../../components/admin/SettingsPanel";
import VouchersPanel from "../../../components/admin/VouchersPanel";
import StoresPanel from "../../../components/admin/StoresPanel";
import CustomersPanel from "../../../components/admin/CustomersPanel";
import CrmPanel from "../../../components/admin/CrmPanel";
import ErpPanel from "../../../components/admin/ErpPanel";
import AnalyticsPanel from "../../../components/admin/AnalyticsPanel";
import MaintenancePanel from "../../../components/admin/MaintenancePanel";
import TeamPanel from "../../../components/admin/TeamPanel";
import WarehousesPanel from "../../../components/admin/WarehousesPanel";
import UserAccessPanel from "../../../components/admin/UserAccessPanel";
import PosPanel from "../../../components/admin/PosPanel";
import PreOrdersPanel from "../../../components/admin/PreOrdersPanel";
import UtangPanel from "../../../components/admin/UtangPanel";
import ExpensesPanel from "../../../components/admin/ExpensesPanel";
import PurchasesPanel from "../../../components/admin/PurchasesPanel";
import InventoryPanel from "../../../components/admin/InventoryPanel";
import StoreLinkPanel from "../../../components/admin/StoreLinkPanel";
import ReportsPanel from "../../../components/admin/ReportsPanel";

interface MyStore { id: string; name: string; slug: string; role: string; }

export default function AdminDashboard() {
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
  const userNavigated = useRef(false);

  const loadStores = useCallback(async () => {
    const token = getAdminToken();
    if (!token) return;
    setStoresStatus("loading");
    try {
      const res = await fetch(`${API_URL}/admin/stores/mine`, { headers: { Authorization: `Bearer ${token}` } });
      if (handleUnauthorized(res)) return;
      if (!res.ok) {
        setStoresStatus("error");
        return;
      }
      const data = await res.json();
      const mine: MyStore[] = (data?.stores ?? []) as MyStore[];
      if (mine.length > 0) {
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
      setStoresStatus("error");
    }
  }, [router]);

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
    sessionStorage.removeItem("samstore.admin.token");
    sessionStorage.removeItem("samstore.admin.storeId");
    router.push("/admin/login");
  };

  if (!authed) return null;

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

  const renderTab = () => {
    switch (tab) {
      case "overview": return <OverviewPanel onNavigate={setTab} storeSlug={active?.slug} storeName={active?.name} />;
      case "pos": return <PosPanel onNavigate={setTab} />;
      case "preorders": return <PreOrdersPanel onNavigate={setTab} />;
      case "utang": return <UtangPanel />;
      case "inventory": return <InventoryPanel />;
      case "expenses": return <ExpensesPanel />;
      case "purchases": return <PurchasesPanel />;
      case "storelink": return <StoreLinkPanel />;
      case "reports": return <ReportsPanel />;
      case "orders": return <OrdersPanel />;
      case "products": return <ProductsPanel />;
      case "settings": return <SettingsPanel />;
      case "vouchers": return <VouchersPanel />;
      case "team": return <TeamPanel />;
      case "customers": return <CustomersPanel />;
case "crm": return <CrmPanel />;
case "erp": return <ErpPanel />;
      case "analytics": return <AnalyticsPanel />;
      case "maintenance": return <MaintenancePanel />;
      case "useraccess": return <UserAccessPanel />;
      case "warehouses": return <WarehousesPanel />;
      case "stores": return <StoresPanel />;
      default: return <OrdersPanel />;
    }
  };

  const sidebar = (
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
          <div key={g.group} className="mb-2">
            <div className="nav-group-label px-3 small text-uppercase fw-semibold">{g.label}</div>
            <ul className="nav flex-column">
              {g.items.map((item) => (
                <li className="nav-item" key={item.id}>
                  <button
                    className={`nav-link w-100 text-start d-flex align-items-center gap-2 ${tab === item.id ? "active" : ""}`}
                    onClick={() => { userNavigated.current = true; setTab(item.id); setMobileNav(false); }}
                  >
                    <i className={`bi ${item.icon}`}></i>
                    <span>{item.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="p-3 border-top">
        <div className="small fw-semibold">{email || "Admin"}</div>
        <div className="small mb-2">{role} · {active?.name}</div>
        <button className="btn btn-outline-danger btn-sm w-100" onClick={logout}>
          <i className="bi bi-box-arrow-right me-1"></i>Log out
        </button>
      </div>
    </div>
  );

  return (
    <div key={activeStore ?? "none"} className="admin-shell d-flex min-vh-100">
      {/* Desktop sidebar */}
      <aside className="admin-sidebar d-none d-md-flex flex-column" style={{ width: 240, position: "sticky", top: 0, height: "100vh" }}>
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      {mobileNav && (
        <>
          <div className="modal fade show d-block d-md-none" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-scrollable" style={{ maxWidth: 280, margin: 0 }}>
              <div className="modal-content rounded-0 border-end min-vh-100" style={{ minHeight: "100vh" }}>
                {sidebar}
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show d-md-none" onClick={() => setMobileNav(false)}></div>
        </>
      )}

      {/* Main */}
      <div className="flex-grow-1 d-flex flex-column" style={{ minWidth: 0 }}>
        {/* Topbar */}
        <nav className="admin-topbar navbar navbar-expand py-2">
          <div className="container-fluid">
            <button className="btn btn-outline-secondary btn-sm d-md-none me-2" onClick={() => setMobileNav(true)}>
              <i className="bi bi-list"></i>
            </button>
            <span className="navbar-brand fw-semibold fs-6 mb-0 d-flex align-items-center gap-2">
              {role === "DELIVERY" ? <i className="bi bi-truck"></i> : <i className="bi bi-speedometer2"></i>}
              {role === "DELIVERY" ? "Courier" : "Dashboard"}
            </span>
            <div className="ms-auto d-flex align-items-center gap-2">
              {(stores.length > 1 || (role === "PLATFORM_ADMIN" && stores.length > 0)) && (
                <select
                  className="form-select form-select-sm"
                  style={{ width: 190 }}
                  value={activeStore ?? ""}
                  onChange={(e) => e.target.value && switchStore(e.target.value)}
                >
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.role})</option>
                  ))}
                </select>
              )}
              <span className="badge text-bg-primary text-uppercase">{role}</span>
              {active && (
                <a className="btn btn-sm btn-outline-primary" href={`/${active.slug}`} target="_blank" rel="noreferrer" title="Open storefront">
                  <i className="bi bi-box-arrow-up-right"></i>
                </a>
              )}
              <button className="btn btn-sm btn-outline-secondary d-md-none" onClick={logout} title="Log out">
                <i className="bi bi-box-arrow-right"></i>
              </button>
            </div>
          </div>
        </nav>

        <main className="container-fluid py-4 flex-grow-1" style={{ background: "#faf7f2" }}>
          {renderTab()}
        </main>
      </div>
    </div>
  );
}
