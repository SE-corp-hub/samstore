"use client";

import { useEffect, useRef, useState } from "react";
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
  const userNavigated = useRef(false);

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
    fetch(`${API_URL}/admin/stores/mine`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (handleUnauthorized(r)) return null;
        return r.json();
      })
      .then((data) => {
        if (data?.stores?.length) {
          setStores(data.stores);
          if (!getAdminStoreId()) setAdminStoreId(data.stores[0].id);
          setActiveStore(getAdminStoreId());
          // M7 vocab fix: nav role comes from the ACTIVE store's membership role
          // (OWNER/…) — the JWT global role can lag it (e.g. an owner whose global
          // role is still STORE_OWNER or a stale STAFF after promotion).
          const member = data.stores.find((s: MyStore) => s.id === getAdminStoreId());
           if (member?.role) {
             if (member.role === "DELIVERY") {
               router.replace("/admin/delivery");
               return;
             }
             setRole(isOwnerRole(member.role) ? "OWNER" : member.role);
            if (!userNavigated.current) setTab(defaultTabFor(isOwnerRole(member.role) ? "OWNER" : member.role));
          }
        }
      })
      .catch(() => { /* non-fatal */ });

    // A platform operator holds NO store membership, so /admin/stores/mine is empty,
    // the switcher had nothing to show and no X-Store-Id was ever sent — every
    // store-scoped call then answered 403 "No active store membership" and the
    // overview looked permanently broken. Offer the platform-wide store list instead
    // and let the operator target a store explicitly (see auth/tenant-context.ts:52).
    if (getAdminRole() === "PLATFORM_ADMIN") {
      fetch(`${API_URL}/admin/stores`, { headers: { Authorization: `Bearer ${token}` } })
        .then((res) => {
          if (handleUnauthorized(res)) return null;
          return res.ok ? res.json() : null;
        })
        .then((data) => {
          const listed = (data?.stores ?? []) as Array<{ id: string; name: string; slug: string }>;
          const platform: MyStore[] = listed.map((s) => ({ ...s, role: "platform" }));
          if (platform.length === 0) return;
          setStores(platform);
          // Deliberately NOT auto-selecting: the operator picks which tenant to view.
          const kept = getAdminStoreId();
          setActiveStore(platform.some((s) => s.id === kept) ? kept : null);
        })
        .catch(() => { /* non-fatal */ });
    }
  }, [router]);

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
        <div className="fw-bold h6 mb-0">
          <i className="bi bi-shop me-2 text-primary"></i>
          {active?.name ?? "Store Admin"}
        </div>
        {active && <small className="text-muted">{active.slug}</small>}
      </div>
      <nav className="flex-grow-1 overflow-auto py-2">
        {visibleGroups.map((g) => (
          <div key={g.group} className="mb-2">
            <div className="px-3 small text-uppercase text-muted fw-semibold">{g.label}</div>
            <ul className="nav flex-column">
              {g.items.map((item) => (
                <li className="nav-item" key={item.id}>
                  <button
                    className={`nav-link w-100 text-start d-flex align-items-center gap-2 ${tab === item.id ? "active bg-primary text-white" : "text-body"}`}
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
        <div className="small text-muted mb-2">{role} · {active?.name}</div>
        <button className="btn btn-outline-danger btn-sm w-100" onClick={logout}>
          <i className="bi bi-box-arrow-right me-1"></i>Log out
        </button>
      </div>
    </div>
  );

  return (
    <div key={activeStore ?? "none"} className="d-flex min-vh-100">
      {/* Desktop sidebar */}
      <aside className="d-none d-md-flex flex-column border-end bg-white" style={{ width: 240, position: "sticky", top: 0, height: "100vh" }}>
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
        <nav className="navbar navbar-expand bg-white border-bottom py-2">
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
