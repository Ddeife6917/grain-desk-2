"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../lib/supabaseClient";

const WHEAT_TYPES = ["Soft White Winter", "Hard Red Winter"];
const FUTURES_MARKETS = ["CBOT Wheat (SRW)", "KC HRW Wheat"];
const CONTRACT_TYPES = ["Unpriced / Stored", "Cash Forward", "HTA (Hedge-to-Arrive)", "Basis Contract"];
const FUTURES_FOR_TYPE = { "Soft White Winter": "CBOT Wheat (SRW)", "Hard Red Winter": "KC HRW Wheat" };

const fmt$ = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtC = (n) => {
  if (n === null || n === undefined || n === "" || isNaN(n)) return "—";
  const num = Number(n);
  return (num < 0 ? "-$" : "$") + Math.abs(num).toFixed(2);
};
const todayISO = () => new Date().toISOString().slice(0, 10);

export default function Dashboard() {
  const router = useRouter();
  const [session, setSession] = useState(undefined); // undefined = checking, null = signed out
  const [prices, setPrices] = useState([]);
  const [contracts, setContracts] = useState([]);
  const [breakevens, setBreakevens] = useState({});
  const [tab, setTab] = useState("board");

  const [priceForm, setPriceForm] = useState({
    date: todayISO(),
    wheatType: WHEAT_TYPES[0],
    futuresMarket: FUTURES_MARKETS[0],
    futuresPrice: "",
    cashPrice: "",
    basis: "",
    elevator: "",
  });

  const [contractForm, setContractForm] = useState({
    wheatType: WHEAT_TYPES[0],
    contractType: CONTRACT_TYPES[0],
    bushels: "",
    price: "",
    deliveryPeriod: "",
    elevator: "",
    dateEntered: todayISO(),
    notes: "",
  });

  // ---- auth guard ----
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      if (!sess) router.push("/login");
    });
    return () => listener.subscription.unsubscribe();
  }, [router]);

  // ---- data loading ----
  const loadAll = useCallback(async () => {
    const [{ data: priceRows }, { data: contractRows }, { data: beRows }] = await Promise.all([
      supabase.from("prices").select("*").order("date", { ascending: false }),
      supabase.from("contracts").select("*").order("date_entered", { ascending: false }),
      supabase.from("breakevens").select("*"),
    ]);
    setPrices(priceRows || []);
    setContracts(contractRows || []);
    const beMap = {};
    (beRows || []).forEach((r) => { beMap[r.wheat_type] = r.value; });
    setBreakevens(beMap);
  }, []);

  useEffect(() => {
    if (session) loadAll();
  }, [session, loadAll]);

  // ---- derived ----
  const latestByType = useMemo(() => {
    const out = {};
    WHEAT_TYPES.forEach((wt) => {
      const rows = prices.filter((r) => r.wheat_type === wt).sort((a, b) => (a.date < b.date ? 1 : -1));
      out[wt] = rows[0] || null;
    });
    return out;
  }, [prices]);

  const sortedPrices = useMemo(() => [...prices].sort((a, b) => (a.date < b.date ? 1 : -1)), [prices]);

  const latestFuturesByMarket = useMemo(() => {
    const out = {};
    FUTURES_MARKETS.forEach((m) => {
      const rows = prices
        .filter((r) => r.futures_market === m && r.futures_price !== null && r.futures_price !== undefined)
        .sort((a, b) => (a.date < b.date ? 1 : -1));
      out[m] = rows[0] || null;
    });
    return out;
  }, [prices]);

  const basisByType = useMemo(() => {
    const out = {};
    WHEAT_TYPES.forEach((wt) => {
      const cashRow = latestByType[wt];
      const futMarket = FUTURES_FOR_TYPE[wt];
      const futRow = latestFuturesByMarket[futMarket];
      const cash = cashRow && cashRow.cash_price !== null ? Number(cashRow.cash_price) : null;
      const fut = futRow && futRow.futures_price !== null ? Number(futRow.futures_price) : null;
      out[wt] = {
        value: cash !== null && fut !== null ? cash - fut : null,
        cashDate: cashRow ? cashRow.date : null,
        futDate: futRow ? futRow.date : null,
        futMarket,
      };
    });
    return out;
  }, [latestByType, latestFuturesByMarket]);

  const contractStats = useMemo(() => {
    return contracts.map((c) => {
      const latest = latestByType[c.wheat_type];
      const currentCash = latest && latest.cash_price !== null ? Number(latest.cash_price) : null;
      const isPriced = c.contract_type !== "Unpriced / Stored" && c.price !== null && c.price !== "";
      const bu = Number(c.bushels) || 0;
      let mtmValue = null, mtmDelta = null, beDelta = null;
      if (currentCash !== null) {
        mtmValue = bu * currentCash;
        if (isPriced) mtmValue !== null && (mtmDelta = bu * Number(c.price) - mtmValue);
      }
      const be = breakevens[c.wheat_type];
      if (be !== undefined && be !== null && be !== "") {
        const refPrice = isPriced ? Number(c.price) : currentCash;
        if (refPrice !== null) beDelta = (refPrice - Number(be)) * bu;
      }
      return { ...c, currentCash, isPriced, mtmValue, mtmDelta, beDelta };
    });
  }, [contracts, latestByType, breakevens]);

  const totals = useMemo(() => {
    let bu = 0, priceValueLocked = 0, marketValue = 0, mtm = 0, be = 0, haveMtm = false, haveBe = false;
    contractStats.forEach((c) => {
      const b = Number(c.bushels) || 0;
      bu += b;
      if (c.isPriced) priceValueLocked += b * Number(c.price);
      if (c.mtmValue !== null) { marketValue += c.mtmValue; haveMtm = true; }
      if (c.mtmDelta !== null) mtm += c.mtmDelta;
      if (c.beDelta !== null) { be += c.beDelta; haveBe = true; }
    });
    return { bu, priceValueLocked, marketValue, mtm, be, haveMtm, haveBe };
  }, [contractStats]);

  // ---- actions ----
  async function addPrice(e) {
    e.preventDefault();
    let { futuresPrice, cashPrice, basis } = priceForm;
    const has = (v) => v !== "" && v !== null && !isNaN(v);
    if (!has(futuresPrice) && has(cashPrice) && has(basis)) futuresPrice = (Number(cashPrice) - Number(basis)).toFixed(2);
    else if (!has(cashPrice) && has(futuresPrice) && has(basis)) cashPrice = (Number(futuresPrice) + Number(basis)).toFixed(2);
    else if (!has(basis) && has(futuresPrice) && has(cashPrice)) basis = (Number(cashPrice) - Number(futuresPrice)).toFixed(2);
    if (!has(futuresPrice) && !has(cashPrice) && !has(basis)) return;

    await supabase.from("prices").insert([{
      date: priceForm.date,
      wheat_type: priceForm.wheatType,
      futures_market: priceForm.futuresMarket,
      futures_price: has(futuresPrice) ? Number(futuresPrice) : null,
      cash_price: has(cashPrice) ? Number(cashPrice) : null,
      basis: has(basis) ? Number(basis) : null,
      elevator: priceForm.elevator || null,
      created_by: session.user.id,
      created_by_email: session.user.email,
    }]);
    setPriceForm((f) => ({ ...f, futuresPrice: "", cashPrice: "", basis: "" }));
    loadAll();
  }

  async function deletePrice(id) {
    await supabase.from("prices").delete().eq("id", id);
    loadAll();
  }

  async function addContract(e) {
    e.preventDefault();
    if (contractForm.bushels === "") return;
    await supabase.from("contracts").insert([{
      user_id: session.user.id,
      wheat_type: contractForm.wheatType,
      contract_type: contractForm.contractType,
      bushels: Number(contractForm.bushels),
      price: contractForm.price !== "" ? Number(contractForm.price) : null,
      delivery_period: contractForm.deliveryPeriod || null,
      elevator: contractForm.elevator || null,
      date_entered: contractForm.dateEntered,
      notes: contractForm.notes || null,
    }]);
    setContractForm((f) => ({ ...f, bushels: "", price: "", deliveryPeriod: "", notes: "" }));
    loadAll();
  }

  async function deleteContract(id) {
    await supabase.from("contracts").delete().eq("id", id);
    loadAll();
  }

  async function saveBreakeven(wheatType, value) {
    setBreakevens((b) => ({ ...b, [wheatType]: value }));
    if (value === "") return;
    await supabase.from("breakevens").upsert(
      { user_id: session.user.id, wheat_type: wheatType, value: Number(value) },
      { onConflict: "user_id,wheat_type" }
    );
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  if (session === undefined) return <div className="wrap" style={{ paddingTop: 40 }}>Loading…</div>;
  if (!session) return null;

  return (
    <div>
      <header className="header">
        <div className="wrap header-top">
          <div>
            <span className="disp brand">Grain Desk</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="mono location">{session.user.email} · Odessa, WA</span>
            <button className="signout" onClick={handleSignOut}>Sign out</button>
          </div>
        </div>
        <div className="ticker">
          <div className="wrap ticker-grid">
            {[
              { label: "CBOT Wheat (SRW)", val: latestFuturesByMarket[FUTURES_MARKETS[0]]?.futures_price },
              { label: "KC HRW Wheat", val: latestFuturesByMarket[FUTURES_MARKETS[1]]?.futures_price },
              { label: "Cash · Soft White", val: latestByType["Soft White Winter"]?.cash_price },
              { label: "Cash · Hard Red", val: latestByType["Hard Red Winter"]?.cash_price },
            ].map((t, i) => (
              <div key={i}>
                <div className="mono tile-label">{t.label}</div>
                <div className="mono tile-value">{fmtC(t.val)}</div>
              </div>
            ))}
          </div>
          <div className="wrap basis-grid">
            {WHEAT_TYPES.map((wt) => (
              <div key={wt}>
                <div className="mono tile-label">Basis · {wt === "Soft White Winter" ? "Soft White" : "Hard Red"}</div>
                <div className="mono tile-value orange">
                  {basisByType[wt].value !== null ? (basisByType[wt].value >= 0 ? "+" : "") + fmtC(basisByType[wt].value) : "—"}
                </div>
                <div className="mono tile-sub">
                  {basisByType[wt].value !== null ? `cash ${basisByType[wt].cashDate} vs. ${basisByType[wt].futMarket} ${basisByType[wt].futDate}` : "needs cash & futures"}
                </div>
              </div>
            ))}
          </div>
        </div>
      </header>

      <main className="wrap">
        <section>
          <h2 className="disp section-title">Position Summary</h2>
          <div className="stat-grid">
            <Stat label="Bushels tracked" value={totals.bu.toLocaleString()} />
            <Stat label="Bu priced value" value={fmt$(totals.priceValueLocked)} />
            <Stat label="Mark-to-market value" value={totals.haveMtm ? fmt$(totals.marketValue) : "—"} />
            <Stat label="Locked vs. today's market" value={totals.haveMtm ? fmt$(totals.mtm) : "—"} tone={totals.mtm > 0 ? "gain" : totals.mtm < 0 ? "loss" : "flat"} />
          </div>
          {totals.haveBe && (
            <div style={{ marginTop: 12 }}>
              <Stat label="P&L vs. breakeven" value={fmt$(totals.be)} tone={totals.be > 0 ? "gain" : totals.be < 0 ? "loss" : "flat"} wide />
            </div>
          )}
          <p className="mono note">
            "Locked vs. today's market" compares what you locked in on priced contracts to what those bushels would be worth at today's most recent cash price. Positive means your locked price beats today's market; negative means the market has moved above what you locked in.
          </p>
        </section>

        <div className="tabs" style={{ marginTop: 32 }}>
          {[
            { id: "board", label: "Price Log" },
            { id: "contracts", label: "Contract Ledger" },
            { id: "settings", label: "Breakevens" },
          ].map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`disp tab ${tab === t.id ? "active" : ""}`}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === "board" && (
          <section style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="card link-card">
              <div>
                <h3 className="disp" style={{ margin: 0, color: "var(--blue)", textTransform: "uppercase", fontSize: 14 }}>HighLine Grain · Cash Bid Board (Odessa)</h3>
                <p className="mono" style={{ fontSize: 10, color: "var(--muted2)", marginTop: 4 }}>Their site blocks embedding — check the board there and log Odessa's price below.</p>
              </div>
              <a href="https://highlinegrain.com/cblocembed" target="_blank" rel="noopener noreferrer" className="btn btn-primary">Open bid board ↗</a>
            </div>

            <form onSubmit={addPrice} className="card form-grid">
              <Field label="Date"><input type="date" value={priceForm.date} onChange={(e) => setPriceForm((f) => ({ ...f, date: e.target.value }))} /></Field>
              <Field label="Wheat type">
                <select value={priceForm.wheatType} onChange={(e) => setPriceForm((f) => ({ ...f, wheatType: e.target.value }))}>
                  {WHEAT_TYPES.map((w) => <option key={w}>{w}</option>)}
                </select>
              </Field>
              <Field label="Futures market">
                <select value={priceForm.futuresMarket} onChange={(e) => setPriceForm((f) => ({ ...f, futuresMarket: e.target.value }))}>
                  {FUTURES_MARKETS.map((w) => <option key={w}>{w}</option>)}
                </select>
              </Field>
              <Field label="Futures $/bu"><input type="number" step="0.01" placeholder="6.25" value={priceForm.futuresPrice} onChange={(e) => setPriceForm((f) => ({ ...f, futuresPrice: e.target.value }))} /></Field>
              <Field label="Local cash $/bu"><input type="number" step="0.01" placeholder="5.80" value={priceForm.cashPrice} onChange={(e) => setPriceForm((f) => ({ ...f, cashPrice: e.target.value }))} /></Field>
              <Field label="Basis (optional)"><input type="number" step="0.01" placeholder="e.g. -0.45" value={priceForm.basis} onChange={(e) => setPriceForm((f) => ({ ...f, basis: e.target.value }))} /></Field>
              <Field label="Elevator"><input type="text" placeholder="HighLine - Odessa" value={priceForm.elevator} onChange={(e) => setPriceForm((f) => ({ ...f, elevator: e.target.value }))} /></Field>
              <div className="full-row"><button type="submit" className="btn btn-primary">Log price</button></div>
            </form>

            <div className="table-wrap">
              <table>
                <thead><tr><th>Date</th><th>Wheat</th><th>Futures</th><th>Futures $</th><th>Cash $</th><th>Basis</th><th>Elevator</th><th>Logged</th><th></th></tr></thead>
                <tbody>
                  {sortedPrices.length === 0 && <tr><td colSpan={9} className="empty-row">No prices logged yet.</td></tr>}
                  {sortedPrices.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{r.date}</td>
                      <td className="mono">{r.wheat_type}</td>
                      <td className="mono">{r.futures_market}</td>
                      <td className="mono">{fmtC(r.futures_price)}</td>
                      <td className="mono">{fmtC(r.cash_price)}</td>
                      <td className="mono">{fmtC(r.basis)}</td>
                      <td className="mono">{r.elevator || "—"}</td>
                      <td className="mono" style={{ fontSize: 11, color: "var(--muted2)" }}>
                        {r.created_by_email ? r.created_by_email.split("@")[0] : "—"}
                        <br />
                        {r.created_at ? new Date(r.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}
                      </td>
                      <td><button onClick={() => deletePrice(r.id)} className="btn-link">Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === "contracts" && (
          <section style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 16 }}>
            <p className="mono" style={{ fontSize: 10, color: "var(--muted2)" }}>Contracts here are private to your account — others sign in with their own login and see only their own. The price board above is shared by everyone with access.</p>
            <form onSubmit={addContract} className="card form-grid">
              <Field label="Wheat type">
                <select value={contractForm.wheatType} onChange={(e) => setContractForm((f) => ({ ...f, wheatType: e.target.value }))}>
                  {WHEAT_TYPES.map((w) => <option key={w}>{w}</option>)}
                </select>
              </Field>
              <Field label="Contract type">
                <select value={contractForm.contractType} onChange={(e) => setContractForm((f) => ({ ...f, contractType: e.target.value }))}>
                  {CONTRACT_TYPES.map((w) => <option key={w}>{w}</option>)}
                </select>
              </Field>
              <Field label="Bushels"><input type="number" placeholder="5000" value={contractForm.bushels} onChange={(e) => setContractForm((f) => ({ ...f, bushels: e.target.value }))} /></Field>
              <Field label="Contract price $/bu">
                <input type="number" step="0.01" placeholder="leave blank if unpriced" value={contractForm.price}
                  onChange={(e) => setContractForm((f) => ({ ...f, price: e.target.value }))}
                  disabled={contractForm.contractType === "Unpriced / Stored"} />
              </Field>
              <Field label="Delivery period"><input type="text" placeholder="Aug 2026" value={contractForm.deliveryPeriod} onChange={(e) => setContractForm((f) => ({ ...f, deliveryPeriod: e.target.value }))} /></Field>
              <Field label="Elevator"><input type="text" placeholder="Lauer" value={contractForm.elevator} onChange={(e) => setContractForm((f) => ({ ...f, elevator: e.target.value }))} /></Field>
              <Field label="Date entered"><input type="date" value={contractForm.dateEntered} onChange={(e) => setContractForm((f) => ({ ...f, dateEntered: e.target.value }))} /></Field>
              <Field label="Notes"><input type="text" placeholder="optional" value={contractForm.notes} onChange={(e) => setContractForm((f) => ({ ...f, notes: e.target.value }))} /></Field>
              <div className="full-row"><button type="submit" className="btn btn-primary">Add contract</button></div>
            </form>

            <div className="table-wrap">
              <table>
                <thead><tr><th>Wheat</th><th>Type</th><th>Bu</th><th>Locked $</th><th>Current cash $</th><th>Delivery</th><th>Elevator</th><th>vs. market</th><th></th></tr></thead>
                <tbody>
                  {contractStats.length === 0 && <tr><td colSpan={9} className="empty-row">No contracts yet.</td></tr>}
                  {contractStats.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.wheat_type}</td>
                      <td className="mono">{c.contract_type}</td>
                      <td className="mono">{Number(c.bushels).toLocaleString()}</td>
                      <td className="mono">{c.isPriced ? fmtC(c.price) : "Open"}</td>
                      <td className="mono">{fmtC(c.currentCash)}</td>
                      <td className="mono">{c.delivery_period || "—"}</td>
                      <td className="mono">{c.elevator || "—"}</td>
                      <td className="mono">
                        {c.isPriced && c.mtmDelta !== null ? <span className={c.mtmDelta > 0 ? "gain" : c.mtmDelta < 0 ? "loss" : ""}>{fmt$(c.mtmDelta)}</span> : "—"}
                      </td>
                      <td><button onClick={() => deleteContract(c.id)} className="btn-link">Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === "settings" && (
          <section style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 16 }}>
            <p style={{ fontSize: 14, color: "var(--muted)", maxWidth: 560 }}>
              Optional: enter your breakeven (cost of production) per bushel for each wheat type. This is private to your account.
            </p>
            <div className="stat-grid" style={{ maxWidth: 520 }}>
              {WHEAT_TYPES.map((wt) => (
                <Field key={wt} label={`${wt} breakeven $/bu`}>
                  <input type="number" step="0.01" placeholder="e.g. 5.10" value={breakevens[wt] ?? ""} onChange={(e) => saveBreakeven(wt, e.target.value)} />
                </Field>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="app-footer wrap">
        All prices are entered manually — this board does not pull live market data. Figures are for personal tracking only, not trading advice.
      </footer>
    </div>
  );
}

function Stat({ label, value, tone, wide }) {
  const cls = tone === "gain" ? "gain" : tone === "loss" ? "loss" : "";
  return (
    <div className={`stat ${wide ? "wide" : ""}`}>
      <div className="mono stat-label">{label}</div>
      <div className={`disp stat-value ${cls}`}>{value}</div>
    </div>
  );
}
function Field({ label, children }) {
  return (
    <label style={{ display: "block" }}>
      <div className="mono field-label">{label}</div>
      {children}
    </label>
  );
}
