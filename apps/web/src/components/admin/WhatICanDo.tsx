"use client";

// "What I can do" (2026-11-21, owner: "have a clear guide and restriction on every role and location").
// One page, in plain words and big text, for the login that is open: what it can change, what it can
// only look at, and who to ask for the rest. It reads lib/who-can.ts, the same table the locked boxes
// use and the server check (scripts/who-can-check.ts) tests, so the guide never says something the app
// does not do.

import { useEffect, useState } from "react";
import { getHomeLocation, isStoreHead } from "../../lib/admin";
import { cachedGet } from "../../lib/offlineCache";
import { RULES, SCOPE_LABEL, WHO_LABEL, WHO_SAYS, whoIs, type Right, type Rule, type Scope, type Who } from "../../lib/who-can";

const SCOPES: Scope[] = ["business", "store", "tablet", "me"];

function List({ rules, right, who }: { rules: Rule[]; right: Right[]; who: Who }) {
  const shown = rules.filter((r) => right.includes(r.rights[who]));
  if (!shown.length) return <p className="text-muted mb-0">Nothing here.</p>;
  return (
    <ul className="wicd-list">
      {SCOPES.map((sc) => {
        const of = shown.filter((r) => r.scope === sc);
        if (!of.length) return null;
        return (
          <li key={sc}>
            <span className={`scope-tag scope-${sc}`}>{SCOPE_LABEL[sc]}</span>
            <ul>
              {of.map((r) => (
                <li key={r.id}>
                  <span className="fw-semibold">{r.what}</span>
                  {r.rights[who] === "own" && <span className="badge text-bg-primary ms-2">Your store only</span>}
                  <span className="d-block text-muted">{r.where}</span>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

export default function WhatICanDo({ role = "" }: { role?: string }) {
  const who = whoIs(role, isStoreHead());
  // 2026-11-22: everyone but the owner works at one store; say which.
  const [storeName, setStoreName] = useState<string | null>(null);
  useEffect(() => {
    const home = getHomeLocation();
    if (!home || who === "owner") return;
    void cachedGet<{ warehouses?: { id: string; name: string }[] }>("/admin/warehouses").then((d) => setStoreName(d?.warehouses?.find((w) => w.id === home)?.name ?? null)).catch(() => undefined);
  }, [who]);
  if (!who) {
    return (
      <div className="wicd-screen">
        <h1 className="h4">What I can do</h1>
        <p>Your login takes and follows orders on its own screens. Ask the owner if something is missing.</p>
      </div>
    );
  }
  const ask = who === "staff" ? "Ask your store head or the owner." : who === "head" ? "Ask the owner or a manager." : "Ask the owner.";
  return (
    <div className="wicd-screen">
      <h1 className="h4 mb-1">What I can do</h1>
      <p className="wicd-who"><i className="bi bi-person-badge" aria-hidden="true"></i>You are logged in as <strong>{WHO_LABEL[who]}</strong></p>
      <p className="fs-5">{WHO_SAYS[who]}</p>
      {who !== "owner" && (
        <p className="fs-5 wicd-store">
          <i className="bi bi-shop me-1" aria-hidden="true"></i>
          {storeName ? <>Your store: <strong>{storeName}</strong>. Everything you see and change is this store's only.</> : getHomeLocation() ? "You see and change your own store only." : "Your login has no store yet, so you cannot sell or change stock. Ask the owner to choose your store in Team."}
        </p>
      )}

      <section className="wicd-card wicd-yes" aria-labelledby="wicd-yes">
        <h2 id="wicd-yes"><i className="bi bi-pencil-square" aria-hidden="true"></i>You can change</h2>
        <List rules={RULES} right={["yes", "own"]} who={who} />
      </section>
      <section className="wicd-card wicd-look" aria-labelledby="wicd-look">
        <h2 id="wicd-look"><i className="bi bi-eye" aria-hidden="true"></i>You can look, not change</h2>
        <p className="text-muted">These show a <i className="bi bi-lock-fill" aria-label="lock"></i> and a grey box. {ask}</p>
        <List rules={RULES} right={["look"]} who={who} />
      </section>
      {who !== "owner" && (
        <section className="wicd-card wicd-no" aria-labelledby="wicd-no">
          <h2 id="wicd-no"><i className="bi bi-person-raised-hand" aria-hidden="true"></i>{ask}</h2>
          <p className="text-muted">These are not on your screens.</p>
          <List rules={RULES} right={["no"]} who={who} />
        </section>
      )}
      <p className="text-muted mt-3">Every form also says at the top where a change lands: the whole business, one store, only this tablet, or only you.</p>
    </div>
  );
}
