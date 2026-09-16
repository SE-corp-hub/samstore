"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";

interface ExpenseRow {
  id: string;
  category: string;
  amountMinor: number;
  note: string | null;
  spentAt: string;
}

const CATEGORIES = ["rent", "utilities", "supplies", "wages", "transport", "other"];
const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;

export default function ExpensesPanel() {
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [category, setCategory] = useState("supplies");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/admin/expenses`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load expenses");
      const data = await res.json();
      setRows(data.expenses ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setError(null);
    const amountMinor = Math.round(parseFloat(amount || "0") * 100);
    if (amountMinor <= 0) { setError("Enter a valid amount"); return; }
    const res = await fetch(`${API_URL}/admin/expenses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ category, amountMinor, note: note || undefined }),
    });
    if (res.ok) {
      setShowForm(false);
      setAmount("");
      setNote("");
      toast("Expense saved");
      await load();
    } else {
      const d = await res.json();
      setError(d?.message ?? "Create failed");
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this expense?")) return;
    const res = await fetch(`${API_URL}/admin/expenses/${id}`, { method: "DELETE", headers: adminHeaders() });
    if (res.ok) { toast("Expense deleted"); await load(); }
  };

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h1 className="h4 mb-0"><i className="bi bi-receipt-cutoff me-2"></i>Expenses</h1>
        <button className="btn btn-primary btn-sm" onClick={() => setShowForm(!showForm)}>
          <i className="bi bi-plus-lg me-1"></i>Add expense
        </button>
      </div>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      {showForm && (
        <div className="card mb-3">
          <div className="card-body">
            <div className="row g-2">
              <div className="col-4">
                <select className="form-select form-select-sm" value={category} onChange={(e) => setCategory(e.target.value)}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="col-3">
                <input className="form-control form-control-sm" type="number" min="0" step="0.01" placeholder="Amount ₱" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div className="col-3">
                <input className="form-control form-control-sm" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              <div className="col-2">
                <button className="btn btn-success btn-sm w-100" onClick={create}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-muted">No expenses yet.</p>
      ) : (
        <table className="table table-hover align-middle">
          <thead>
            <tr><th>Category</th><th className="text-end">Amount</th><th>Note</th><th>Date</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><span className="badge text-bg-secondary text-capitalize">{r.category}</span></td>
                <td className="text-end fw-semibold">{toPesos(r.amountMinor)}</td>
                <td className="small text-muted">{r.note ?? "—"}</td>
                <td className="small text-muted">{new Date(r.spentAt).toLocaleString()}</td>
                <td className="text-end">
                  <button className="btn btn-sm btn-outline-danger" onClick={() => remove(r.id)}><i className="bi bi-trash"></i></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}