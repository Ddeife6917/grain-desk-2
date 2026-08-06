"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
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
  const [deliveringId, setDeliveringId] = useState(null);
  const [deliveryForm, setDeliveryForm] = useState({ date: todayISO(), finalPrice: "", finalFutures: "", finalBasis: "" });
  const [showDelivered, setShowDelivered] = useState(false);
  const [splittingId, setSplittingId] = useState(null);
  const [splitForm, setSplitForm] = useState({
    bushels: "", contractType: "Cash Forward", price: "", lockedFutures: "", lockedBasis: "",
    elevator: "", deliveryPeriod: "", dateEntered: todayISO(),
  });

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
    lockedFutures: "",
    lockedBasis: "",
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
    (beRows || []).forEach((r) => { beMap[r.wheat_type] = { value: r.value, expectedBushels: r.expected_bushels }; });
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
      const currentBasis = basisByType[c.wheat_type]?.value ?? null;
      const futMarket = FUTURES_FOR_TYPE[c.wheat_type];
      const currentFutures = latestFuturesByMarket[futMarket]?.futures_price ?? null;

      // Fully locked (both legs known) only for Cash Forward contracts.
      const isPriced = c.contract_type === "Cash Forward" && c.price !== null && c.price !== "";

      // Hypothetical: if the still-open leg were priced right now, what
      // would the final cash price come out to?
      let whatIfPrice = null;
      if (c.contract_type === "HTA (Hedge-to-Arrive)" && c.locked_futures !== null && c.locked_futures !== undefined && currentBasis !== null) {
        whatIfPrice = Number(c.locked_futures) + currentBasis;
      } else if (c.contract_type === "Basis Contract" && c.locked_basis !== null && c.locked_basis !== undefined && currentFutures !== null && currentFutures !== undefined) {
        whatIfPrice = Number(c.locked_basis) + Number(currentFutures);
      }

      const bu = Number(c.bushels) || 0;
      let mtmValue = null, mtmDelta = null, beDelta = null, whatIfDelta = null;
      if (currentCash !== null) {
        mtmValue = bu * currentCash;
        if (isPriced) mtmDelta = bu * Number(c.price) - mtmValue;
        if (whatIfPrice !== null) whatIfDelta = bu * whatIfPrice - mtmValue;
      }
      const be = breakevens[c.wheat_type]?.value;
      if (be !== undefined && be !== null && be !== "") {
        const refPrice = c.delivered ? Number(c.final_price) : isPriced ? Number(c.price) : whatIfPrice !== null ? whatIfPrice : currentCash;
        if (refPrice !== null && refPrice !== undefined && !isNaN(refPrice)) beDelta = (refPrice - Number(be)) * bu;
      }
      return { ...c, currentCash, currentBasis, currentFutures, isPriced, whatIfPrice, mtmValue, mtmDelta, whatIfDelta, beDelta };
    });
  }, [contracts, latestByType, basisByType, latestFuturesByMarket, breakevens]);

  const activeContracts = useMemo(() => contractStats.filter((c) => !c.delivered), [contractStats]);
  const deliveredContracts = useMemo(() => contractStats.filter((c) => c.delivered), [contractStats]);

  const totals = useMemo(() => {
    let bu = 0, priceValueLocked = 0, marketValue = 0, mtm = 0, be = 0, haveMtm = false, haveBe = false;
    activeContracts.forEach((c) => {
      const b = Number(c.bushels) || 0;
      bu += b;
      if (c.isPriced) priceValueLocked += b * Number(c.price);
      if (c.mtmValue !== null) { marketValue += c.mtmValue; haveMtm = true; }
      if (c.mtmDelta !== null) mtm += c.mtmDelta;
      if (c.beDelta !== null) { be += c.beDelta; haveBe = true; }
    });
    return { bu, priceValueLocked, marketValue, mtm, be, haveMtm, haveBe };
  }, [activeContracts]);

  // "Fully priced" = Cash Forward (priced) + any delivered contract, since the
  // final price is actually known. HTA/Basis contracts count as "partially
  // hedged" until delivered, since one leg is still open.
  const perTypeStats = useMemo(() => {
    const out = {};
    WHEAT_TYPES.forEach((wt) => {
      const rows = contractStats.filter((c) => c.wheat_type === wt);
      let fullyPricedBu = 0, fullyPricedValue = 0, partiallyHedgedBu = 0, totalBu = 0;
      rows.forEach((c) => {
        const b = Number(c.bushels) || 0;
        totalBu += b;
        if (c.delivered) {
          fullyPricedBu += b;
          fullyPricedValue += b * Number(c.final_price);
        } else if (c.contract_type === "Cash Forward" && c.isPriced) {
          fullyPricedBu += b;
          fullyPricedValue += b * Number(c.price);
        } else if (c.contract_type === "HTA (Hedge-to-Arrive)" || c.contract_type === "Basis Contract") {
          partiallyHedgedBu += b;
        }
      });
      const expected = breakevens[wt]?.expectedBushels;
      const hasExpected = expected !== undefined && expected !== null && expected !== "" && Number(expected) > 0;
      out[wt] = {
        totalBu,
        fullyPricedBu,
        partiallyHedgedBu,
        blendedPrice: fullyPricedBu > 0 ? fullyPricedValue / fullyPricedBu : null,
        pctPriced: hasExpected ? (fullyPricedBu / Number(expected)) * 100 : null,
        pctHedged: hasExpected ? (partiallyHedgedBu / Number(expected)) * 100 : null,
        expectedBushels: hasExpected ? Number(expected) : null,
      };
    });
    return out;
  }, [contractStats, breakevens]);

  // ---- actions ----
  async function addPrice(e) {
    e.preventDefault();
    let { futuresPrice, cashPrice, basis } = priceForm;
    const has = (v) => v !== "" && v !== null && !isNaN(v);
    if (!has(futuresPrice) && has(cashPrice) && has(basis)) futuresPrice = (Number(cashPrice) - Number(basis)).toFixed(2);
    else if (!has(cashPrice) && has(futuresPrice) && has(basis)) cashPrice = (Number(futuresPrice) + Number(basis)).toFixed(2);
    else if (!has(basis) && has(futuresPrice) && has(cashPrice)) basis = (Number(cashPrice) - Number(futuresPrice)).toFixed(2);
    if (!has(futuresPrice) && !has(cashPrice) && !has(basis)) return;

    const { error } = await supabase.from("prices").insert([{
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
    if (error) { alert("Couldn't save this price: " + error.message); return; }
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
    const { error } = await supabase.from("contracts").insert([{
      user_id: session.user.id,
      wheat_type: contractForm.wheatType,
      contract_type: contractForm.contractType,
      bushels: Number(contractForm.bushels),
      price: contractForm.price !== "" ? Number(contractForm.price) : null,
      locked_futures: contractForm.lockedFutures !== "" ? Number(contractForm.lockedFutures) : null,
      locked_basis: contractForm.lockedBasis !== "" ? Number(contractForm.lockedBasis) : null,
      delivery_period: contractForm.deliveryPeriod || null,
      elevator: contractForm.elevator || null,
      date_entered: contractForm.dateEntered,
      notes: contractForm.notes || null,
    }]);
    if (error) { alert("Couldn't save this contract: " + error.message); return; }
    setContractForm((f) => ({ ...f, bushels: "", price: "", lockedFutures: "", lockedBasis: "", deliveryPeriod: "", notes: "" }));
    loadAll();
  }

  async function deleteContract(id) {
    await supabase.from("contracts").delete().eq("id", id);
    loadAll();
  }

  function startDelivery(c) {
    setDeliveringId(c.id);
    setDeliveryForm({
      date: todayISO(),
      finalPrice: c.contract_type === "Cash Forward" ? (c.price ?? "") : "",
      finalFutures: "",
      finalBasis: "",
    });
  }

  async function saveDelivery(c) {
    let finalPrice = null;
    const updates = { delivered: true, delivered_date: deliveryForm.date };

    if (c.contract_type === "Cash Forward") {
      finalPrice = deliveryForm.finalPrice !== "" ? Number(deliveryForm.finalPrice) : Number(c.price);
    } else if (c.contract_type === "HTA (Hedge-to-Arrive)") {
      if (deliveryForm.finalBasis === "") { alert("Enter the final basis at delivery."); return; }
      updates.final_basis = Number(deliveryForm.finalBasis);
      finalPrice = Number(c.locked_futures) + Number(deliveryForm.finalBasis);
    } else if (c.contract_type === "Basis Contract") {
      if (deliveryForm.finalFutures === "") { alert("Enter the final futures price at delivery."); return; }
      updates.final_futures = Number(deliveryForm.finalFutures);
      finalPrice = Number(c.locked_basis) + Number(deliveryForm.finalFutures);
    } else {
      // Unpriced / Stored — priced at the point of delivery
      if (deliveryForm.finalPrice === "") { alert("Enter the final cash price received."); return; }
      finalPrice = Number(deliveryForm.finalPrice);
    }

    updates.final_price = finalPrice;
    const { error } = await supabase.from("contracts").update(updates).eq("id", c.id);
    if (error) { alert("Couldn't save delivery: " + error.message); return; }
    setDeliveringId(null);
    loadAll();
  }

  function startSplit(c) {
    setSplittingId(c.id);
    setSplitForm({
      bushels: "",
      contractType: "Cash Forward",
      price: "",
      lockedFutures: "",
      lockedBasis: "",
      elevator: c.elevator || "",
      deliveryPeriod: c.delivery_period || "",
      dateEntered: todayISO(),
    });
  }

  async function saveSplit(c) {
    const bu = Number(splitForm.bushels);
    const available = Number(c.bushels);
    if (!bu || bu <= 0) { alert("Enter how many bushels to price."); return; }
    if (bu > available) { alert(`Only ${available.toLocaleString()} bu are available on this contract.`); return; }

    const newContract = {
      user_id: session.user.id,
      wheat_type: c.wheat_type,
      contract_type: splitForm.contractType,
      bushels: bu,
      price: splitForm.contractType === "Cash Forward" && splitForm.price !== "" ? Number(splitForm.price) : null,
      locked_futures: splitForm.contractType === "HTA (Hedge-to-Arrive)" && splitForm.lockedFutures !== "" ? Number(splitForm.lockedFutures) : null,
      locked_basis: splitForm.contractType === "Basis Contract" && splitForm.lockedBasis !== "" ? Number(splitForm.lockedBasis) : null,
      delivery_period: splitForm.deliveryPeriod || null,
      elevator: splitForm.elevator || null,
      date_entered: splitForm.dateEntered,
      notes: c.notes || null,
    };

    if (splitForm.contractType === "Cash Forward" && newContract.price === null) { alert("Enter the locked cash price."); return; }
    if (splitForm.contractType === "HTA (Hedge-to-Arrive)" && newContract.locked_futures === null) { alert("Enter the locked futures price."); return; }
    if (splitForm.contractType === "Basis Contract" && newContract.locked_basis === null) { alert("Enter the locked basis."); return; }

    const { error: insertError } = await supabase.from("contracts").insert([newContract]);
    if (insertError) { alert("Couldn't create the new contract: " + insertError.message); return; }

    const remaining = available - bu;
    if (remaining <= 0) {
      const { error: delError } = await supabase.from("contracts").delete().eq("id", c.id);
      if (delError) { alert("New contract was created, but couldn't update the original: " + delError.message); }
    } else {
      const { error: updError } = await supabase.from("contracts").update({ bushels: remaining }).eq("id", c.id);
      if (updError) { alert("New contract was created, but couldn't update the original: " + updError.message); }
    }

    setSplittingId(null);
    loadAll();
  }

  async function saveBreakeven(wheatType, value) {
    setBreakevens((b) => ({ ...b, [wheatType]: { ...b[wheatType], value } }));
    await supabase.from("breakevens").upsert(
      { user_id: session.user.id, wheat_type: wheatType, value: value === "" ? null : Number(value) },
      { onConflict: "user_id,wheat_type" }
    );
  }

  async function saveExpectedBushels(wheatType, expectedBushels) {
    setBreakevens((b) => ({ ...b, [wheatType]: { ...b[wheatType], expectedBushels } }));
    await supabase.from("breakevens").upsert(
      { user_id: session.user.id, wheat_type: wheatType, expected_bushels: expectedBushels === "" ? null : Number(expectedBushels) },
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
            "Locked vs. today's market" compares what you locked in on priced contracts to what those bushels would be worth at today's most recent cash price. Positive means your locked price beats today's market; negative means the market has moved above what you locked in. These totals reflect open contracts only — delivered/settled contracts are tracked separately in the Contract Ledger tab.
          </p>

          <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            {WHEAT_TYPES.map((wt) => {
              const s = perTypeStats[wt];
              if (!s || s.totalBu === 0) return null;
              return (
                <div key={wt} className="card">
                  <div className="disp" style={{ fontSize: 13, textTransform: "uppercase", color: "var(--blue)", marginBottom: 8 }}>{wt}</div>
                  <div className="stat-grid">
                    <Stat
                      label="% of crop priced"
                      value={s.pctPriced !== null ? `${s.pctPriced.toFixed(0)}%` : "Set expected bu"}
                    />
                    <Stat
                      label="% partially hedged"
                      value={s.pctHedged !== null ? `${s.pctHedged.toFixed(0)}%` : "—"}
                    />
                    <Stat label="Blended avg. price" value={s.blendedPrice !== null ? fmtC(s.blendedPrice) : "—"} />
                    <Stat label="Bu fully priced / total" value={`${s.fullyPricedBu.toLocaleString()} / ${s.totalBu.toLocaleString()}`} />
                  </div>
                </div>
              );
            })}
          </div>
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

            <BasisChart prices={prices} />

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
              {contractForm.contractType === "Cash Forward" && (
                <Field label="Locked cash price $/bu">
                  <input type="number" step="0.01" placeholder="6.00" value={contractForm.price} onChange={(e) => setContractForm((f) => ({ ...f, price: e.target.value }))} />
                </Field>
              )}
              {contractForm.contractType === "HTA (Hedge-to-Arrive)" && (
                <Field label="Locked futures $/bu (basis still open)">
                  <input type="number" step="0.01" placeholder="6.25" value={contractForm.lockedFutures} onChange={(e) => setContractForm((f) => ({ ...f, lockedFutures: e.target.value }))} />
                </Field>
              )}
              {contractForm.contractType === "Basis Contract" && (
                <Field label="Locked basis $/bu (futures still open)">
                  <input type="number" step="0.01" placeholder="-0.45" value={contractForm.lockedBasis} onChange={(e) => setContractForm((f) => ({ ...f, lockedBasis: e.target.value }))} />
                </Field>
              )}
              <Field label="Delivery period"><input type="text" placeholder="Aug 2026" value={contractForm.deliveryPeriod} onChange={(e) => setContractForm((f) => ({ ...f, deliveryPeriod: e.target.value }))} /></Field>
              <Field label="Elevator"><input type="text" placeholder="Lauer" value={contractForm.elevator} onChange={(e) => setContractForm((f) => ({ ...f, elevator: e.target.value }))} /></Field>
              <Field label="Date entered"><input type="date" value={contractForm.dateEntered} onChange={(e) => setContractForm((f) => ({ ...f, dateEntered: e.target.value }))} /></Field>
              <Field label="Notes"><input type="text" placeholder="optional" value={contractForm.notes} onChange={(e) => setContractForm((f) => ({ ...f, notes: e.target.value }))} /></Field>
              <div className="full-row"><button type="submit" className="btn btn-primary">Add contract</button></div>
            </form>

            <div className="table-wrap">
              <table>
                <thead><tr><th>Wheat</th><th>Type</th><th>Bu</th><th>Locked</th><th>What if priced now</th><th>Current cash $</th><th>Delivery</th><th>Elevator</th><th>vs. market</th><th></th></tr></thead>
                <tbody>
                  {activeContracts.length === 0 && <tr><td colSpan={10} className="empty-row">No active contracts.</td></tr>}
                  {activeContracts.map((c) => (
                    <React.Fragment key={c.id}>
                      <tr>
                        <td className="mono">{c.wheat_type}</td>
                        <td className="mono">{c.contract_type}</td>
                        <td className="mono">{Number(c.bushels).toLocaleString()}</td>
                        <td className="mono">
                          {c.contract_type === "Cash Forward" && (c.isPriced ? fmtC(c.price) : "Open")}
                          {c.contract_type === "HTA (Hedge-to-Arrive)" && (c.locked_futures !== null && c.locked_futures !== undefined ? `Fut ${fmtC(c.locked_futures)} · basis open` : "Open")}
                          {c.contract_type === "Basis Contract" && (c.locked_basis !== null && c.locked_basis !== undefined ? `Basis ${fmtC(c.locked_basis)} · fut open` : "Open")}
                          {c.contract_type === "Unpriced / Stored" && "Open"}
                        </td>
                        <td className="mono">
                          {c.whatIfPrice !== null ? (
                            <span>
                              {fmtC(c.whatIfPrice)}
                              {c.whatIfDelta !== null && (
                                <span className={c.whatIfDelta > 0 ? "gain" : c.whatIfDelta < 0 ? "loss" : ""}> ({fmt$(c.whatIfDelta)})</span>
                              )}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="mono">{fmtC(c.currentCash)}</td>
                        <td className="mono">{c.delivery_period || "—"}</td>
                        <td className="mono">{c.elevator || "—"}</td>
                        <td className="mono">
                          {c.isPriced && c.mtmDelta !== null ? <span className={c.mtmDelta > 0 ? "gain" : c.mtmDelta < 0 ? "loss" : ""}>{fmt$(c.mtmDelta)}</span> : "—"}
                        </td>
                        <td style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {c.contract_type === "Unpriced / Stored" && (
                            <button onClick={() => startSplit(c)} className="btn-link" style={{ color: "var(--orange)" }}>Price this</button>
                          )}
                          <button onClick={() => startDelivery(c)} className="btn-link" style={{ color: "var(--blue)" }}>Mark delivered</button>
                          <button onClick={() => deleteContract(c.id)} className="btn-link">Remove</button>
                        </td>
                      </tr>
                      {splittingId === c.id && (
                        <tr>
                          <td colSpan={10}>
                            <div className="card" style={{ background: "#FFFFFF" }}>
                              <p className="mono note" style={{ marginTop: 0 }}>
                                Pulls bushels out of this Unpriced/Stored contract ({Number(c.bushels).toLocaleString()} bu available) and creates a new priced contract with them. The elevator and delivery period below are pre-filled from this contract — edit if the new contract is going somewhere different.
                              </p>
                              <div className="form-grid">
                                <Field label={`Bushels to price (max ${Number(c.bushels).toLocaleString()})`}>
                                  <input type="number" value={splitForm.bushels} onChange={(e) => setSplitForm((f) => ({ ...f, bushels: e.target.value }))} />
                                </Field>
                                <Field label="New contract type">
                                  <select value={splitForm.contractType} onChange={(e) => setSplitForm((f) => ({ ...f, contractType: e.target.value }))}>
                                    <option>Cash Forward</option>
                                    <option>HTA (Hedge-to-Arrive)</option>
                                    <option>Basis Contract</option>
                                  </select>
                                </Field>
                                {splitForm.contractType === "Cash Forward" && (
                                  <Field label="Locked cash price $/bu">
                                    <input type="number" step="0.01" value={splitForm.price} onChange={(e) => setSplitForm((f) => ({ ...f, price: e.target.value }))} />
                                  </Field>
                                )}
                                {splitForm.contractType === "HTA (Hedge-to-Arrive)" && (
                                  <Field label="Locked futures $/bu (basis still open)">
                                    <input type="number" step="0.01" value={splitForm.lockedFutures} onChange={(e) => setSplitForm((f) => ({ ...f, lockedFutures: e.target.value }))} />
                                  </Field>
                                )}
                                {splitForm.contractType === "Basis Contract" && (
                                  <Field label="Locked basis $/bu (futures still open)">
                                    <input type="number" step="0.01" value={splitForm.lockedBasis} onChange={(e) => setSplitForm((f) => ({ ...f, lockedBasis: e.target.value }))} />
                                  </Field>
                                )}
                                <Field label="Elevator">
                                  <input type="text" value={splitForm.elevator} onChange={(e) => setSplitForm((f) => ({ ...f, elevator: e.target.value }))} />
                                </Field>
                                <Field label="Delivery period">
                                  <input type="text" value={splitForm.deliveryPeriod} onChange={(e) => setSplitForm((f) => ({ ...f, deliveryPeriod: e.target.value }))} />
                                </Field>
                                <Field label="Date entered">
                                  <input type="date" value={splitForm.dateEntered} onChange={(e) => setSplitForm((f) => ({ ...f, dateEntered: e.target.value }))} />
                                </Field>
                                <div style={{ display: "flex", gap: 8 }}>
                                  <button onClick={() => saveSplit(c)} className="btn btn-primary">Save</button>
                                  <button onClick={() => setSplittingId(null)} className="btn-link">Cancel</button>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                      {deliveringId === c.id && (
                        <tr>
                          <td colSpan={10}>
                            <div className="card" style={{ background: "#FFFFFF" }}>
                              <div className="form-grid">
                                <Field label="Delivery date">
                                  <input type="date" value={deliveryForm.date} onChange={(e) => setDeliveryForm((f) => ({ ...f, date: e.target.value }))} />
                                </Field>
                                {(c.contract_type === "Cash Forward" || c.contract_type === "Unpriced / Stored") && (
                                  <Field label="Final cash price $/bu">
                                    <input type="number" step="0.01" value={deliveryForm.finalPrice} onChange={(e) => setDeliveryForm((f) => ({ ...f, finalPrice: e.target.value }))} />
                                  </Field>
                                )}
                                {c.contract_type === "HTA (Hedge-to-Arrive)" && (
                                  <Field label="Final basis at delivery $/bu">
                                    <input type="number" step="0.01" placeholder="e.g. -0.30" value={deliveryForm.finalBasis} onChange={(e) => setDeliveryForm((f) => ({ ...f, finalBasis: e.target.value }))} />
                                  </Field>
                                )}
                                {c.contract_type === "Basis Contract" && (
                                  <Field label="Final futures at delivery $/bu">
                                    <input type="number" step="0.01" value={deliveryForm.finalFutures} onChange={(e) => setDeliveryForm((f) => ({ ...f, finalFutures: e.target.value }))} />
                                  </Field>
                                )}
                                <div style={{ display: "flex", gap: 8 }}>
                                  <button onClick={() => saveDelivery(c)} className="btn btn-primary">Save</button>
                                  <button onClick={() => setDeliveringId(null)} className="btn-link">Cancel</button>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mono note">
              "What if priced now" applies to HTA contracts (futures locked, basis still open) and Basis Contracts (basis locked, futures still open) — it shows what your final cash price would be if you locked the still-open leg at today's market, with the $ gain/loss versus today's cash price in parentheses.
            </p>

            <button onClick={() => setShowDelivered((s) => !s)} className="disp tab" style={{ borderBottom: "none", paddingLeft: 0 }}>
              {showDelivered ? "Hide" : "Show"} delivered contracts ({deliveredContracts.length})
            </button>
            {showDelivered && (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Wheat</th><th>Type</th><th>Bu</th><th>Final price</th><th>Delivered</th><th>vs. breakeven</th><th>Elevator</th></tr></thead>
                  <tbody>
                    {deliveredContracts.length === 0 && <tr><td colSpan={7} className="empty-row">No delivered contracts yet.</td></tr>}
                    {deliveredContracts.map((c) => (
                      <tr key={c.id}>
                        <td className="mono">{c.wheat_type}</td>
                        <td className="mono">{c.contract_type}</td>
                        <td className="mono">{Number(c.bushels).toLocaleString()}</td>
                        <td className="mono">{fmtC(c.final_price)}</td>
                        <td className="mono">{c.delivered_date || "—"}</td>
                        <td className="mono">
                          {c.beDelta !== null ? <span className={c.beDelta > 0 ? "gain" : c.beDelta < 0 ? "loss" : ""}>{fmt$(c.beDelta)}</span> : "—"}
                        </td>
                        <td className="mono">{c.elevator || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {tab === "settings" && (
          <section style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 24 }}>
            <p style={{ fontSize: 14, color: "var(--muted)", maxWidth: 560 }}>
              Optional, per wheat type, private to your account. Your breakeven (cost of production) drives the "vs. breakeven" columns. Expected bushels drives the "% of crop priced" and blended price figures in Position Summary.
            </p>
            {WHEAT_TYPES.map((wt) => (
              <div key={wt} className="stat-grid" style={{ maxWidth: 560 }}>
                <Field label={`${wt} breakeven $/bu`}>
                  <input type="number" step="0.01" placeholder="e.g. 5.10" value={breakevens[wt]?.value ?? ""} onChange={(e) => saveBreakeven(wt, e.target.value)} />
                </Field>
                <Field label={`${wt} expected bushels this year`}>
                  <input type="number" placeholder="e.g. 40000" value={breakevens[wt]?.expectedBushels ?? ""} onChange={(e) => saveExpectedBushels(wt, e.target.value)} />
                </Field>
              </div>
            ))}
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

function BasisChart({ prices }) {
  const width = 640, height = 260, padLeft = 56, padRight = 16, padTop = 16, padBottom = 40;
  const colors = { "Soft White Winter": "#F2994A", "Hard Red Winter": "#1D5D9B" };

  const series = WHEAT_TYPES.map((wt) => ({
    wt,
    color: colors[wt],
    points: prices
      .filter((r) => r.wheat_type === wt && r.basis !== null && r.basis !== undefined)
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  }));

  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length < 2) {
    return (
      <div className="card">
        <h3 className="disp" style={{ margin: 0, color: "var(--blue)", textTransform: "uppercase", fontSize: 14 }}>Basis Over Time</h3>
        <p className="mono" style={{ fontSize: 12, color: "var(--muted2)", marginTop: 8 }}>
          Log basis (or both cash and futures) on at least two different dates to see a trend line here.
        </p>
      </div>
    );
  }

  const dates = allPoints.map((p) => new Date(p.date).getTime());
  const minDate = Math.min(...dates), maxDate = Math.max(...dates);
  const basisVals = allPoints.map((p) => Number(p.basis));
  let minB = Math.min(...basisVals), maxB = Math.max(...basisVals);
  if (minB === maxB) { minB -= 0.1; maxB += 0.1; }
  const pad = (maxB - minB) * 0.15;
  minB -= pad; maxB += pad;

  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const xScale = (d) => {
    const t = new Date(d).getTime();
    if (maxDate === minDate) return padLeft + plotW / 2;
    return padLeft + ((t - minDate) / (maxDate - minDate)) * plotW;
  };
  const yScale = (v) => padTop + plotH - ((v - minB) / (maxB - minB)) * plotH;

  // Horizontal gridlines with a value label at each level.
  const gridLevels = 4;
  const gridValues = Array.from({ length: gridLevels + 1 }, (_, i) => minB + (i / gridLevels) * (maxB - minB));

  // One date label per unique date across both series, so labels don't repeat
  // when both wheat types were logged the same day.
  const uniqueDates = [...new Set(allPoints.map((p) => p.date))].sort();
  const formatDate = (d) => {
    const dt = new Date(d + "T00:00:00");
    return dt.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
  };

  return (
    <div className="card">
      <h3 className="disp" style={{ margin: 0, color: "var(--blue)", textTransform: "uppercase", fontSize: 14 }}>Basis Over Time</h3>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto", marginTop: 8 }}>
        {gridValues.map((v, i) => (
          <g key={i}>
            <line x1={padLeft} x2={width - padRight} y1={yScale(v)} y2={yScale(v)} style={{ stroke: "var(--border)" }} strokeDasharray={Math.abs(v) < 1e-9 ? "0" : "3 3"} strokeWidth={Math.abs(v) < 1e-9 ? 1.5 : 1} />
            <text x={padLeft - 6} y={yScale(v) + 3} textAnchor="end" className="mono" style={{ fontSize: 10, fill: "var(--muted2)" }}>{fmtC(v)}</text>
          </g>
        ))}

        {uniqueDates.map((d, i) => (
          <g key={d}>
            <line x1={xScale(d)} x2={xScale(d)} y1={padTop} y2={height - padBottom} style={{ stroke: "var(--border)" }} strokeDasharray="2 4" strokeWidth={0.75} />
            <text
              x={xScale(d)}
              y={height - padBottom + 16}
              textAnchor="middle"
              className="mono"
              style={{ fontSize: 10, fill: "var(--muted2)" }}
            >
              {formatDate(d)}
            </text>
          </g>
        ))}

        {series.map((s) => s.points.length >= 2 && (
          <polyline
            key={s.wt}
            fill="none"
            strokeWidth="2"
            style={{ stroke: s.color }}
            points={s.points.map((p) => `${xScale(p.date)},${yScale(Number(p.basis))}`).join(" ")}
          />
        ))}
        {series.map((s) => s.points.map((p, i) => (
          <circle key={s.wt + i} cx={xScale(p.date)} cy={yScale(Number(p.basis))} r="3" style={{ fill: s.color }} />
        )))}
      </svg>
      <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
        {series.map((s) => (
          <div key={s.wt} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 10, background: s.color, borderRadius: 2, display: "inline-block" }}></span>
            <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{s.wt}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
