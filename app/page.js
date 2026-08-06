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
// Parses labels like "Aug 2026" into a rough date so we can find the
// soonest one. Unparseable labels sort last rather than breaking.
function parseMonthLabel(label) {
  const d = new Date("1 " + label.trim());
  return isNaN(d.getTime()) ? new Date(8640000000000000) : d;
}

function getNearestMonth(trackedMonths, wheatType) {
  const months = trackedMonths[wheatType] || [];
  if (months.length === 0) return null;
  const today = new Date();
  today.setDate(1); // compare at month granularity
  const withDates = months.map((m) => ({ m, d: parseMonthLabel(m) }));
  const future = withDates.filter((x) => x.d >= today).sort((a, b) => a.d - b.d);
  if (future.length > 0) return future[0].m;
  // all tracked months are in the past — fall back to the most recent one
  return withDates.sort((a, b) => b.d - a.d)[0].m;
}

// "General/nearby" price: the latest logged entry with no specific
// delivery month attached.
function getGeneralPrice(prices, wheatType) {
  const rows = prices.filter((r) => r.wheat_type === wheatType && !r.delivery_month).sort((a, b) => (a.date < b.date ? 1 : -1));
  if (rows.length === 0) return null;
  const cashRow = rows.find((r) => r.cash_price !== null && r.cash_price !== undefined);
  const futRow = rows.find((r) => r.futures_price !== null && r.futures_price !== undefined);
  const basisRow = rows.find((r) => r.basis !== null && r.basis !== undefined);
  return {
    cashPrice: cashRow ? Number(cashRow.cash_price) : null,
    futuresPrice: futRow ? Number(futRow.futures_price) : null,
    futuresMarket: futRow ? futRow.futures_market : null,
    basis: basisRow ? Number(basisRow.basis) : null,
    date: rows[0].date,
  };
}

// Prefers the nearest tracked delivery month's price; falls back to
// general/nearby only if that month has no data logged yet. This is
// what keeps a later-dated but far-out month (e.g. December) from
// overriding a nearer one (e.g. August) just because it was logged more
// recently.
function getBestPrice(prices, wheatType, nearestMonth) {
  if (nearestMonth) {
    const mp = getMonthPrice(prices, wheatType, nearestMonth);
    if (mp && (mp.cashPrice !== null || mp.futuresPrice !== null || mp.basis !== null)) {
      return { ...mp, month: nearestMonth };
    }
  }
  const gp = getGeneralPrice(prices, wheatType);
  return gp ? { ...gp, month: null } : null;
}

const todayISO = () => new Date().toISOString().slice(0, 10);

// Finds the most recent price row for a wheat type + specific delivery
// month. Used so contracts price off the month that actually matches
// their delivery period, instead of just whatever was logged last.
function getMonthPrice(prices, wheatType, monthLabel) {
  if (!monthLabel) return null;
  const rows = prices
    .filter((r) => r.wheat_type === wheatType && r.delivery_month === monthLabel)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (rows.length === 0) return null;
  const cashRow = rows.find((r) => r.cash_price !== null && r.cash_price !== undefined);
  const futRow = rows.find((r) => r.futures_price !== null && r.futures_price !== undefined);
  const basisRow = rows.find((r) => r.basis !== null && r.basis !== undefined);
  return {
    cashPrice: cashRow ? Number(cashRow.cash_price) : null,
    futuresPrice: futRow ? Number(futRow.futures_price) : null,
    futuresMarket: futRow ? futRow.futures_market : null,
    basis: basisRow ? Number(basisRow.basis) : null,
    date: rows[0].date,
  };
}

export default function Dashboard() {
  const router = useRouter();
  const [session, setSession] = useState(undefined); // undefined = checking, null = signed out
  const [prices, setPrices] = useState([]);
  const [contracts, setContracts] = useState([]);
  const [breakevens, setBreakevens] = useState({});
  const [trackedMonths, setTrackedMonths] = useState({}); // { wheatType: ["Aug 2026", ...] }
  const [cropYears, setCropYears] = useState([]);
  const [selectedYear, setSelectedYear] = useState(null);
  const [newYearInput, setNewYearInput] = useState("");
  const [newMonthInput, setNewMonthInput] = useState({ "Soft White Winter": "", "Hard Red Winter": "" });
  const [tab, setTab] = useState("board");
  const [deliveringId, setDeliveringId] = useState(null);
  const [deliveryForm, setDeliveryForm] = useState({ date: todayISO(), finalPrice: "", finalFutures: "", finalBasis: "" });
  const [showDelivered, setShowDelivered] = useState(false);
  const [splittingId, setSplittingId] = useState(null);
  const [splitForm, setSplitForm] = useState({
    bushels: "", contractType: "Cash Forward", price: "", lockedFutures: "", lockedBasis: "",
    elevator: "", deliveryPeriod: "", dateEntered: todayISO(),
  });
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({
    wheatType: WHEAT_TYPES[0], contractType: CONTRACT_TYPES[0], bushels: "", price: "",
    lockedFutures: "", lockedBasis: "", deliveryPeriod: "", elevator: "", dateEntered: todayISO(), notes: "", cropYear: "",
  });

  const [editingPriceId, setEditingPriceId] = useState(null);
  const [editPriceForm, setEditPriceForm] = useState({
    date: todayISO(), wheatType: WHEAT_TYPES[0], deliveryMonth: "", futuresMarket: FUTURES_MARKETS[0],
    futuresPrice: "", cashPrice: "", basis: "", elevator: "",
  });

  const [priceForm, setPriceForm] = useState({
    date: todayISO(),
    wheatType: WHEAT_TYPES[0],
    deliveryMonth: "",
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
    const [{ data: priceRows }, { data: contractRows }, { data: beRows }, { data: monthRows }, { data: yearRows }] = await Promise.all([
      supabase.from("prices").select("*").order("date", { ascending: false }),
      supabase.from("contracts").select("*").order("date_entered", { ascending: false }),
      supabase.from("breakevens").select("*"),
      supabase.from("tracked_months").select("*").order("sort_order", { ascending: true }),
      supabase.from("crop_years").select("*").order("year_label", { ascending: false }),
    ]);
    setPrices(priceRows || []);
    setContracts(contractRows || []);
    const beMap = {};
    (beRows || []).forEach((r) => {
      const yr = r.crop_year || "unassigned";
      (beMap[yr] ||= {})[r.wheat_type] = { value: r.value, expectedBushels: r.expected_bushels };
    });
    setBreakevens(beMap);
    const monthMap = {};
    WHEAT_TYPES.forEach((wt) => { monthMap[wt] = []; });
    (monthRows || []).forEach((r) => { (monthMap[r.wheat_type] ||= []).push(r.month_label); });
    setTrackedMonths(monthMap);

    const years = (yearRows || []).map((r) => r.year_label);
    setCropYears(years);
    setSelectedYear((prev) => (prev && years.includes(prev) ? prev : years[0] || null));
  }, []);

  useEffect(() => {
    if (session) loadAll();
  }, [session, loadAll]);

  // ---- derived ----
  const nearestMonthByType = useMemo(() => {
    const out = {};
    WHEAT_TYPES.forEach((wt) => { out[wt] = getNearestMonth(trackedMonths, wt); });
    return out;
  }, [trackedMonths]);

  const bestPriceByType = useMemo(() => {
    const out = {};
    WHEAT_TYPES.forEach((wt) => { out[wt] = getBestPrice(prices, wt, nearestMonthByType[wt]); });
    return out;
  }, [prices, nearestMonthByType]);

  const sortedPrices = useMemo(() => [...prices].sort((a, b) => (a.date < b.date ? 1 : -1)), [prices]);

  const basisByType = useMemo(() => {
    const out = {};
    WHEAT_TYPES.forEach((wt) => {
      const best = bestPriceByType[wt];
      const cash = best?.cashPrice ?? null;
      const fut = best?.futuresPrice ?? null;
      const value = best?.basis !== null && best?.basis !== undefined ? best.basis : (cash !== null && fut !== null ? cash - fut : null);
      out[wt] = {
        value,
        cashDate: best?.date ?? null,
        futDate: best?.date ?? null,
        futMarket: best?.futuresMarket || FUTURES_FOR_TYPE[wt],
      };
    });
    return out;
  }, [bestPriceByType]);

  const contractStats = useMemo(() => {
    return contracts.map((c) => {
      const monthPrice = getMonthPrice(prices, c.wheat_type, c.delivery_period);
      const usingMonthPrice = monthPrice !== null && (monthPrice.cashPrice !== null || monthPrice.futuresPrice !== null || monthPrice.basis !== null);

      const best = bestPriceByType[c.wheat_type];
      const generalCash = best?.cashPrice ?? null;
      const generalBasis = best?.basis !== null && best?.basis !== undefined ? best.basis : (best?.cashPrice !== null && best?.futuresPrice !== null && best?.cashPrice !== undefined && best?.futuresPrice !== undefined ? best.cashPrice - best.futuresPrice : null);
      const generalFutures = best?.futuresPrice ?? null;

      const currentCash = usingMonthPrice && monthPrice.cashPrice !== null ? monthPrice.cashPrice : generalCash;
      const currentBasis = usingMonthPrice && monthPrice.basis !== null ? monthPrice.basis : generalBasis;
      const currentFutures = usingMonthPrice && monthPrice.futuresPrice !== null ? monthPrice.futuresPrice : generalFutures;

      // Fully locked (both legs known) only for Cash Forward contracts.
      const isPriced = c.contract_type === "Cash Forward" && c.price !== null && c.price !== "";

      // Hypothetical: if the still-open leg were priced right now, what
      // would the final cash price come out to?
      let whatIfPrice = null;
      if (c.contract_type === "HTA (Hedge-to-Arrive)" && c.locked_futures !== null && c.locked_futures !== undefined && currentBasis !== null) {
        whatIfPrice = Number(c.locked_futures) + currentBasis;
      } else if (c.contract_type === "Basis Contract" && c.locked_basis !== null && c.locked_basis !== undefined && currentFutures !== null && currentFutures !== undefined) {
        whatIfPrice = Number(c.locked_basis) + Number(currentFutures);
      } else if (c.contract_type === "Unpriced / Stored" && currentCash !== null) {
        whatIfPrice = currentCash;
      }

      const bu = Number(c.bushels) || 0;
      let mtmValue = null, mtmDelta = null, beDelta = null, whatIfDelta = null;
      if (currentCash !== null) {
        mtmValue = bu * currentCash;
        if (isPriced) mtmDelta = bu * Number(c.price) - mtmValue;
        if (whatIfPrice !== null) whatIfDelta = bu * whatIfPrice - mtmValue;
      }
      const be = breakevens[c.crop_year || "unassigned"]?.[c.wheat_type]?.value;
      if (be !== undefined && be !== null && be !== "") {
        const refPrice = c.delivered ? Number(c.final_price) : isPriced ? Number(c.price) : whatIfPrice !== null ? whatIfPrice : currentCash;
        if (refPrice !== null && refPrice !== undefined && !isNaN(refPrice)) beDelta = (refPrice - Number(be)) * bu;
      }
      return { ...c, currentCash, currentBasis, currentFutures, isPriced, whatIfPrice, mtmValue, mtmDelta, whatIfDelta, beDelta, usingMonthPrice };
    });
  }, [contracts, prices, bestPriceByType, breakevens]);

  const yearContractStats = useMemo(() => contractStats.filter((c) => c.crop_year === selectedYear), [contractStats, selectedYear]);
  const activeContracts = useMemo(() => yearContractStats.filter((c) => !c.delivered), [yearContractStats]);
  const deliveredContracts = useMemo(() => yearContractStats.filter((c) => c.delivered), [yearContractStats]);

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
      const rows = yearContractStats.filter((c) => c.wheat_type === wt);
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
      const expected = breakevens[selectedYear]?.[wt]?.expectedBushels;
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
  }, [yearContractStats, breakevens, selectedYear]);

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
      delivery_month: priceForm.deliveryMonth || null,
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

  function startEditPrice(r) {
    setEditingPriceId(r.id);
    setEditPriceForm({
      date: r.date,
      wheatType: r.wheat_type,
      deliveryMonth: r.delivery_month || "",
      futuresMarket: r.futures_market || FUTURES_MARKETS[0],
      futuresPrice: r.futures_price ?? "",
      cashPrice: r.cash_price ?? "",
      basis: r.basis ?? "",
      elevator: r.elevator || "",
    });
  }

  async function saveEditPrice(r) {
    let { futuresPrice, cashPrice, basis } = editPriceForm;
    const has = (v) => v !== "" && v !== null && !isNaN(v);
    if (!has(futuresPrice) && has(cashPrice) && has(basis)) futuresPrice = (Number(cashPrice) - Number(basis)).toFixed(2);
    else if (!has(cashPrice) && has(futuresPrice) && has(basis)) cashPrice = (Number(futuresPrice) + Number(basis)).toFixed(2);
    else if (!has(basis) && has(futuresPrice) && has(cashPrice)) basis = (Number(cashPrice) - Number(futuresPrice)).toFixed(2);
    if (!has(futuresPrice) && !has(cashPrice) && !has(basis)) { alert("Enter at least one price."); return; }

    const { error } = await supabase.from("prices").update({
      date: editPriceForm.date,
      wheat_type: editPriceForm.wheatType,
      delivery_month: editPriceForm.deliveryMonth || null,
      futures_market: editPriceForm.futuresMarket,
      futures_price: has(futuresPrice) ? Number(futuresPrice) : null,
      cash_price: has(cashPrice) ? Number(cashPrice) : null,
      basis: has(basis) ? Number(basis) : null,
      elevator: editPriceForm.elevator || null,
    }).eq("id", r.id);
    if (error) { alert("Couldn't save changes: " + error.message); return; }
    setEditingPriceId(null);
    loadAll();
  }

  async function addContract(e) {
    e.preventDefault();
    if (contractForm.bushels === "") return;
    if (!selectedYear) { alert("Add a crop year first (above the Contract Ledger)."); return; }
    const { error } = await supabase.from("contracts").insert([{
      user_id: session.user.id,
      crop_year: selectedYear,
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
      crop_year: c.crop_year || null,
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

  function startEdit(c) {
    setEditingId(c.id);
    setEditForm({
      wheatType: c.wheat_type,
      contractType: c.contract_type,
      bushels: c.bushels ?? "",
      price: c.price ?? "",
      lockedFutures: c.locked_futures ?? "",
      lockedBasis: c.locked_basis ?? "",
      deliveryPeriod: c.delivery_period || "",
      elevator: c.elevator || "",
      dateEntered: c.date_entered || todayISO(),
      notes: c.notes || "",
      cropYear: c.crop_year || selectedYear || "",
    });
  }

  async function saveEdit(c) {
    if (editForm.bushels === "" || Number(editForm.bushels) <= 0) { alert("Enter a valid bushel amount."); return; }

    const updates = {
      wheat_type: editForm.wheatType,
      crop_year: editForm.cropYear || null,
      contract_type: editForm.contractType,
      bushels: Number(editForm.bushels),
      price: editForm.contractType === "Cash Forward" && editForm.price !== "" ? Number(editForm.price) : null,
      locked_futures: editForm.contractType === "HTA (Hedge-to-Arrive)" && editForm.lockedFutures !== "" ? Number(editForm.lockedFutures) : null,
      locked_basis: editForm.contractType === "Basis Contract" && editForm.lockedBasis !== "" ? Number(editForm.lockedBasis) : null,
      delivery_period: editForm.deliveryPeriod || null,
      elevator: editForm.elevator || null,
      date_entered: editForm.dateEntered,
      notes: editForm.notes || null,
    };

    const { error } = await supabase.from("contracts").update(updates).eq("id", c.id);
    if (error) { alert("Couldn't save changes: " + error.message); return; }
    setEditingId(null);
    loadAll();
  }

  async function addCropYear() {
    const label = newYearInput.trim();
    if (!label) return;
    if (cropYears.includes(label)) { setNewYearInput(""); setSelectedYear(label); return; }
    const { error } = await supabase.from("crop_years").insert([{ year_label: label }]);
    if (error) { alert("Couldn't add year: " + error.message); return; }
    setNewYearInput("");
    await loadAll();
    setSelectedYear(label);
  }

  async function addTrackedMonth(wheatType) {
    const label = (newMonthInput[wheatType] || "").trim();
    if (!label) return;
    const existing = trackedMonths[wheatType] || [];
    if (existing.length >= 3) { alert("You can track up to 3 delivery months per wheat type. Remove one first."); return; }
    if (existing.includes(label)) { setNewMonthInput((f) => ({ ...f, [wheatType]: "" })); return; }
    const { error } = await supabase.from("tracked_months").insert([{ wheat_type: wheatType, month_label: label, sort_order: existing.length }]);
    if (error) { alert("Couldn't add month: " + error.message); return; }
    setNewMonthInput((f) => ({ ...f, [wheatType]: "" }));
    loadAll();
  }

  async function removeTrackedMonth(wheatType, label) {
    const { error } = await supabase.from("tracked_months").delete().eq("wheat_type", wheatType).eq("month_label", label);
    if (error) { alert("Couldn't remove month: " + error.message); return; }
    loadAll();
  }

  async function saveBreakeven(wheatType, value) {
    if (!selectedYear) { alert("Add a crop year first."); return; }
    setBreakevens((b) => ({ ...b, [selectedYear]: { ...b[selectedYear], [wheatType]: { ...b[selectedYear]?.[wheatType], value } } }));
    await supabase.from("breakevens").upsert(
      { user_id: session.user.id, wheat_type: wheatType, crop_year: selectedYear, value: value === "" ? null : Number(value) },
      { onConflict: "user_id,wheat_type,crop_year" }
    );
  }

  async function saveExpectedBushels(wheatType, expectedBushels) {
    if (!selectedYear) { alert("Add a crop year first."); return; }
    setBreakevens((b) => ({ ...b, [selectedYear]: { ...b[selectedYear], [wheatType]: { ...b[selectedYear]?.[wheatType], expectedBushels } } }));
    await supabase.from("breakevens").upsert(
      { user_id: session.user.id, wheat_type: wheatType, crop_year: selectedYear, expected_bushels: expectedBushels === "" ? null : Number(expectedBushels) },
      { onConflict: "user_id,wheat_type,crop_year" }
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
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img src="/logo.png" alt="" width={36} height={36} style={{ borderRadius: 8, display: "block" }} />
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
              { label: "CBOT Wheat (SRW)", val: bestPriceByType["Soft White Winter"]?.futuresPrice },
              { label: "KC HRW Wheat", val: bestPriceByType["Hard Red Winter"]?.futuresPrice },
              { label: "Cash · Soft White", val: bestPriceByType["Soft White Winter"]?.cashPrice },
              { label: "Cash · Hard Red", val: bestPriceByType["Hard Red Winter"]?.cashPrice },
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
                  {basisByType[wt].value !== null
                    ? `${bestPriceByType[wt]?.month || "general/nearby"} · as of ${basisByType[wt].cashDate}`
                    : "needs cash & futures"}
                </div>
              </div>
            ))}
          </div>
        </div>
      </header>

      <main className="wrap">
        <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)" }}>Crop Year</span>
            {cropYears.length === 0 && <span className="mono" style={{ fontSize: 12, color: "var(--muted2)" }}>None yet — add one to the right.</span>}
            {cropYears.map((y) => (
              <button
                key={y}
                onClick={() => setSelectedYear(y)}
                className="disp"
                style={{
                  fontSize: 13,
                  padding: "6px 14px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: y === selectedYear ? "var(--blue)" : "#FFFFFF",
                  color: y === selectedYear ? "#FFFFFF" : "var(--ink)",
                  cursor: "pointer",
                }}
              >
                {y}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              placeholder="e.g. 2026"
              value={newYearInput}
              onChange={(e) => setNewYearInput(e.target.value)}
              style={{ maxWidth: 110 }}
            />
            <button onClick={addCropYear} className="btn btn-primary" style={{ padding: "6px 14px" }}>Add year</button>
          </div>
        </div>

        {!selectedYear ? (
          <p className="mono" style={{ color: "var(--muted2)", marginBottom: 24 }}>Add a crop year above to start logging contracts and breakevens for it.</p>
        ) : (
        <>
        <section>
          <h2 className="disp section-title">Position Summary — {selectedYear}</h2>
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

            <BasisChart prices={prices} trackedMonths={trackedMonths} />

            <div className="card">
              <h3 className="disp" style={{ margin: 0, color: "var(--blue)", textTransform: "uppercase", fontSize: 14 }}>Tracked Delivery Months</h3>
              <p className="mono" style={{ fontSize: 10, color: "var(--muted2)", marginTop: 4, marginBottom: 12 }}>
                Up to 3 months per wheat type. Contracts and the delivery-month price table below use whichever month matches a contract's delivery period.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {WHEAT_TYPES.map((wt) => (
                  <div key={wt}>
                    <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>{wt}</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                      {(trackedMonths[wt] || []).map((m) => (
                        <span key={m} className="mono" style={{ fontSize: 12, background: "#FFFFFF", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", display: "flex", alignItems: "center", gap: 6 }}>
                          {m}
                          <button onClick={() => removeTrackedMonth(wt, m)} className="btn-link" style={{ fontSize: 12 }}>✕</button>
                        </span>
                      ))}
                      {(trackedMonths[wt] || []).length === 0 && <span className="mono" style={{ fontSize: 12, color: "var(--muted2)" }}>No months tracked yet.</span>}
                    </div>
                    {(trackedMonths[wt] || []).length < 3 && (
                      <div style={{ display: "flex", gap: 8 }}>
                        <input
                          type="text"
                          placeholder="e.g. Aug 2026"
                          value={newMonthInput[wt] || ""}
                          onChange={(e) => setNewMonthInput((f) => ({ ...f, [wt]: e.target.value }))}
                          style={{ maxWidth: 160 }}
                        />
                        <button onClick={() => addTrackedMonth(wt)} className="btn btn-primary" style={{ padding: "6px 14px" }}>Add</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <DeliveryMonthPrices prices={prices} trackedMonths={trackedMonths} />

            <form onSubmit={addPrice} className="card form-grid">
              <Field label="Date"><input type="date" value={priceForm.date} onChange={(e) => setPriceForm((f) => ({ ...f, date: e.target.value }))} /></Field>
              <Field label="Wheat type">
                <select value={priceForm.wheatType} onChange={(e) => setPriceForm((f) => ({ ...f, wheatType: e.target.value }))}>
                  {WHEAT_TYPES.map((w) => <option key={w}>{w}</option>)}
                </select>
              </Field>
              <Field label="Delivery month">
                <select value={priceForm.deliveryMonth} onChange={(e) => setPriceForm((f) => ({ ...f, deliveryMonth: e.target.value }))}>
                  <option value="">General / nearby</option>
                  {(trackedMonths[priceForm.wheatType] || []).map((m) => <option key={m}>{m}</option>)}
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
                <thead><tr><th>Date</th><th>Wheat</th><th>Month</th><th>Futures</th><th>Futures $</th><th>Cash $</th><th>Basis</th><th>Elevator</th><th>Logged</th><th></th></tr></thead>
                <tbody>
                  {sortedPrices.length === 0 && <tr><td colSpan={10} className="empty-row">No prices logged yet.</td></tr>}
                  {sortedPrices.map((r) => (
                    <React.Fragment key={r.id}>
                      <tr>
                        <td className="mono">{r.date}</td>
                        <td className="mono">{r.wheat_type}</td>
                        <td className="mono">{r.delivery_month || "general/nearby"}</td>
                        <td className="mono">{r.futures_market}</td>
                        <td className="mono">{fmtC(r.futures_price)}</td>
                        <td className="mono">{fmtC(r.cash_price)}</td>
                        <td className="mono">
                          {r.basis !== null && r.basis !== undefined ? (
                            <span className={Number(r.basis) < 0 ? "loss" : Number(r.basis) > 0 ? "gain" : ""}>{fmtC(r.basis)}</span>
                          ) : "—"}
                        </td>
                        <td className="mono">{r.elevator || "—"}</td>
                        <td className="mono" style={{ fontSize: 11, color: "var(--muted2)" }}>
                          {r.created_by_email ? r.created_by_email.split("@")[0] : "—"}
                          <br />
                          {r.created_at ? new Date(r.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}
                        </td>
                        <td style={{ display: "flex", gap: 8 }}>
                          <button onClick={() => startEditPrice(r)} className="btn-link" style={{ color: "var(--blue)" }}>Edit</button>
                          <button onClick={() => deletePrice(r.id)} className="btn-link">Remove</button>
                        </td>
                      </tr>
                      {editingPriceId === r.id && (
                        <tr>
                          <td colSpan={10}>
                            <div className="card" style={{ background: "#FFFFFF" }}>
                              <div className="form-grid">
                                <Field label="Date">
                                  <input type="date" value={editPriceForm.date} onChange={(e) => setEditPriceForm((f) => ({ ...f, date: e.target.value }))} />
                                </Field>
                                <Field label="Wheat type">
                                  <select value={editPriceForm.wheatType} onChange={(e) => setEditPriceForm((f) => ({ ...f, wheatType: e.target.value }))}>
                                    {WHEAT_TYPES.map((w) => <option key={w}>{w}</option>)}
                                  </select>
                                </Field>
                                <Field label="Delivery month">
                                  <select value={editPriceForm.deliveryMonth} onChange={(e) => setEditPriceForm((f) => ({ ...f, deliveryMonth: e.target.value }))}>
                                    <option value="">General / nearby</option>
                                    {(trackedMonths[editPriceForm.wheatType] || []).map((m) => <option key={m}>{m}</option>)}
                                  </select>
                                </Field>
                                <Field label="Futures market">
                                  <select value={editPriceForm.futuresMarket} onChange={(e) => setEditPriceForm((f) => ({ ...f, futuresMarket: e.target.value }))}>
                                    {FUTURES_MARKETS.map((w) => <option key={w}>{w}</option>)}
                                  </select>
                                </Field>
                                <Field label="Futures $/bu">
                                  <input type="number" step="0.01" value={editPriceForm.futuresPrice} onChange={(e) => setEditPriceForm((f) => ({ ...f, futuresPrice: e.target.value }))} />
                                </Field>
                                <Field label="Local cash $/bu">
                                  <input type="number" step="0.01" value={editPriceForm.cashPrice} onChange={(e) => setEditPriceForm((f) => ({ ...f, cashPrice: e.target.value }))} />
                                </Field>
                                <Field label="Basis">
                                  <input type="number" step="0.01" value={editPriceForm.basis} onChange={(e) => setEditPriceForm((f) => ({ ...f, basis: e.target.value }))} />
                                </Field>
                                <Field label="Elevator">
                                  <input type="text" value={editPriceForm.elevator} onChange={(e) => setEditPriceForm((f) => ({ ...f, elevator: e.target.value }))} />
                                </Field>
                                <div style={{ display: "flex", gap: 8 }}>
                                  <button onClick={() => saveEditPrice(r)} className="btn btn-primary">Save</button>
                                  <button onClick={() => setEditingPriceId(null)} className="btn-link">Cancel</button>
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
              <Field label="Delivery period">
                <input type="text" list="delivery-months-add" placeholder="Aug 2026" value={contractForm.deliveryPeriod} onChange={(e) => setContractForm((f) => ({ ...f, deliveryPeriod: e.target.value }))} />
                <datalist id="delivery-months-add">
                  {(trackedMonths[contractForm.wheatType] || []).map((m) => <option key={m} value={m} />)}
                </datalist>
              </Field>
              <Field label="Elevator"><input type="text" placeholder="Lauer" value={contractForm.elevator} onChange={(e) => setContractForm((f) => ({ ...f, elevator: e.target.value }))} /></Field>
              <Field label="Date entered"><input type="date" value={contractForm.dateEntered} onChange={(e) => setContractForm((f) => ({ ...f, dateEntered: e.target.value }))} /></Field>
              <Field label="Notes"><input type="text" placeholder="optional" value={contractForm.notes} onChange={(e) => setContractForm((f) => ({ ...f, notes: e.target.value }))} /></Field>
              <div className="full-row"><button type="submit" className="btn btn-primary">Add contract</button></div>
            </form>

            <div className="table-wrap">
              <table>
                <thead><tr><th>Wheat</th><th>Type</th><th>Bu</th><th>Locked</th><th>What if priced now</th><th>Current cash $</th><th>Delivery</th><th>Elevator</th><th>Notes</th><th>vs. market</th><th></th></tr></thead>
                <tbody>
                  {activeContracts.length === 0 && <tr><td colSpan={11} className="empty-row">No active contracts.</td></tr>}
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
                              {c.contract_type === "Unpriced / Stored" && c.mtmValue !== null && (
                                <span style={{ color: "var(--muted)" }}> ({fmt$(c.mtmValue)} total)</span>
                              )}
                              {c.contract_type !== "Unpriced / Stored" && c.whatIfDelta !== null && (
                                <span className={c.whatIfDelta > 0 ? "gain" : c.whatIfDelta < 0 ? "loss" : ""}> ({fmt$(c.whatIfDelta)})</span>
                              )}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="mono">
                          {fmtC(c.currentCash)}
                          {c.currentCash !== null && (
                            <span className="mono" style={{ fontSize: 9, color: c.usingMonthPrice ? "var(--gain)" : "var(--muted2)", display: "block" }}>
                              {c.usingMonthPrice ? `${c.delivery_period} price` : "general/nearby"}
                            </span>
                          )}
                        </td>
                        <td className="mono">{c.delivery_period || "—"}</td>
                        <td className="mono">{c.elevator || "—"}</td>
                        <td className="mono" title={c.notes || ""} style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.notes || "—"}</td>
                        <td className="mono">
                          {c.isPriced && c.mtmDelta !== null ? <span className={c.mtmDelta > 0 ? "gain" : c.mtmDelta < 0 ? "loss" : ""}>{fmt$(c.mtmDelta)}</span> : "—"}
                        </td>
                        <td style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button onClick={() => startEdit(c)} className="btn-link" style={{ color: "var(--muted)" }}>Edit</button>
                          {c.contract_type === "Unpriced / Stored" && (
                            <button onClick={() => startSplit(c)} className="btn-link" style={{ color: "var(--orange)" }}>Price this</button>
                          )}
                          <button onClick={() => startDelivery(c)} className="btn-link" style={{ color: "var(--blue)" }}>Mark delivered</button>
                          <button onClick={() => deleteContract(c.id)} className="btn-link">Remove</button>
                        </td>
                      </tr>
                      {editingId === c.id && (
                        <tr>
                          <td colSpan={11}>
                            <div className="card" style={{ background: "#FFFFFF" }}>
                              <div className="form-grid">
                                <Field label="Wheat type">
                                  <select value={editForm.wheatType} onChange={(e) => setEditForm((f) => ({ ...f, wheatType: e.target.value }))}>
                                    {WHEAT_TYPES.map((w) => <option key={w}>{w}</option>)}
                                  </select>
                                </Field>
                                <Field label="Contract type">
                                  <select value={editForm.contractType} onChange={(e) => setEditForm((f) => ({ ...f, contractType: e.target.value }))}>
                                    {CONTRACT_TYPES.map((w) => <option key={w}>{w}</option>)}
                                  </select>
                                </Field>
                                <Field label="Bushels">
                                  <input type="number" value={editForm.bushels} onChange={(e) => setEditForm((f) => ({ ...f, bushels: e.target.value }))} />
                                </Field>
                                {editForm.contractType === "Cash Forward" && (
                                  <Field label="Locked cash price $/bu">
                                    <input type="number" step="0.01" value={editForm.price} onChange={(e) => setEditForm((f) => ({ ...f, price: e.target.value }))} />
                                  </Field>
                                )}
                                {editForm.contractType === "HTA (Hedge-to-Arrive)" && (
                                  <Field label="Locked futures $/bu (basis still open)">
                                    <input type="number" step="0.01" value={editForm.lockedFutures} onChange={(e) => setEditForm((f) => ({ ...f, lockedFutures: e.target.value }))} />
                                  </Field>
                                )}
                                {editForm.contractType === "Basis Contract" && (
                                  <Field label="Locked basis $/bu (futures still open)">
                                    <input type="number" step="0.01" value={editForm.lockedBasis} onChange={(e) => setEditForm((f) => ({ ...f, lockedBasis: e.target.value }))} />
                                  </Field>
                                )}
                                <Field label="Delivery period">
                                  <input type="text" list="delivery-months-edit" value={editForm.deliveryPeriod} onChange={(e) => setEditForm((f) => ({ ...f, deliveryPeriod: e.target.value }))} />
                                  <datalist id="delivery-months-edit">
                                    {(trackedMonths[editForm.wheatType] || []).map((m) => <option key={m} value={m} />)}
                                  </datalist>
                                </Field>
                                <Field label="Elevator">
                                  <input type="text" value={editForm.elevator} onChange={(e) => setEditForm((f) => ({ ...f, elevator: e.target.value }))} />
                                </Field>
                                <Field label="Date entered">
                                  <input type="date" value={editForm.dateEntered} onChange={(e) => setEditForm((f) => ({ ...f, dateEntered: e.target.value }))} />
                                </Field>
                                <Field label="Notes">
                                  <input type="text" value={editForm.notes} onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))} />
                                </Field>
                                <div style={{ display: "flex", gap: 8 }}>
                                  <button onClick={() => saveEdit(c)} className="btn btn-primary">Save</button>
                                  <button onClick={() => setEditingId(null)} className="btn-link">Cancel</button>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                      {splittingId === c.id && (
                        <tr>
                          <td colSpan={11}>
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
                                  <input type="text" list="delivery-months-split" value={splitForm.deliveryPeriod} onChange={(e) => setSplitForm((f) => ({ ...f, deliveryPeriod: e.target.value }))} />
                                  <datalist id="delivery-months-split">
                                    {(trackedMonths[c.wheat_type] || []).map((m) => <option key={m} value={m} />)}
                                  </datalist>
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
                          <td colSpan={11}>
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
              "What if priced now" shows what you'd get if you locked in the remaining open piece of a contract at today's market. For HTA and Basis Contracts, it fills in whichever leg (futures or basis) is still open, with the $ gain/loss versus today's cash price in parentheses. For Unpriced/Stored, it's today's cash price along with what that specific batch of bushels would be worth in total if sold right now. Cash Forward contracts are already fully locked, so there's nothing to show here.
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
                  <input type="number" step="0.01" placeholder="e.g. 5.10" value={breakevens[selectedYear]?.[wt]?.value ?? ""} onChange={(e) => saveBreakeven(wt, e.target.value)} />
                </Field>
                <Field label={`${wt} expected bushels this year`}>
                  <input type="number" placeholder="e.g. 40000" value={breakevens[selectedYear]?.[wt]?.expectedBushels ?? ""} onChange={(e) => saveExpectedBushels(wt, e.target.value)} />
                </Field>
              </div>
            ))}
          </section>
        )}
        </>
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
function DeliveryMonthPrices({ prices, trackedMonths }) {
  const colors = { "Soft White Winter": "#C9942F", "Hard Red Winter": "#1D5D9B" };
  const rows = [];
  WHEAT_TYPES.forEach((wt) => {
    (trackedMonths[wt] || []).forEach((month) => {
      const p = getMonthPrice(prices, wt, month);
      rows.push({ wt, month, p });
    });
  });

  if (rows.length === 0) {
    return (
      <div className="card">
        <h3 className="disp" style={{ margin: 0, color: "var(--blue)", textTransform: "uppercase", fontSize: 14 }}>Delivery Month Prices</h3>
        <p className="mono" style={{ fontSize: 12, color: "var(--muted2)", marginTop: 8 }}>Add tracked delivery months above, then log prices against them to see them here.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h3 className="disp" style={{ margin: 0, color: "var(--blue)", textTransform: "uppercase", fontSize: 14 }}>Delivery Month Prices</h3>
      <div className="table-wrap" style={{ marginTop: 12, border: "none" }}>
        <table>
          <thead><tr><th>Wheat</th><th>Month</th><th>Futures $</th><th>Cash $</th><th>Basis</th><th>As of</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.wt + r.month}>
                <td className="mono"><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: colors[r.wt], marginRight: 6 }}></span>{r.wt}</td>
                <td className="mono">{r.month}</td>
                <td className="mono">{r.p ? fmtC(r.p.futuresPrice) : "—"}</td>
                <td className="mono">{r.p ? fmtC(r.p.cashPrice) : "—"}</td>
                <td className="mono">
                  {r.p && r.p.basis !== null ? (
                    <span className={Number(r.p.basis) < 0 ? "loss" : Number(r.p.basis) > 0 ? "gain" : ""}>{fmtC(r.p.basis)}</span>
                  ) : "—"}
                </td>
                <td className="mono" style={{ fontSize: 11, color: "var(--muted2)" }}>{r.p ? r.p.date : "no data yet"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

function BasisChart({ prices, trackedMonths }) {
  const width = 640, height = 260, padLeft = 56, padRight = 16, padTop = 16, padBottom = 40;
  const colors = { "Soft White Winter": "#C9942F", "Hard Red Winter": "#1D5D9B" };

  const series = WHEAT_TYPES.map((wt) => {
    const months = trackedMonths[wt] || [];
    const today = new Date(); today.setDate(1);
    const sortedByProximity = [...months].sort((a, b) => {
      const da = parseMonthLabel(a), db = parseMonthLabel(b);
      const futureA = da >= today, futureB = db >= today;
      if (futureA && !futureB) return -1;
      if (!futureA && futureB) return 1;
      return futureA ? da - db : db - da;
    });

    // Use the nearest tracked month that actually has 2+ logged basis
    // points; fall back through the rest, then to general/nearby.
    let chosen = null;
    let points = [];
    for (const m of sortedByProximity) {
      const pts = prices
        .filter((r) => r.wheat_type === wt && r.basis !== null && r.basis !== undefined && r.delivery_month === m)
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      if (pts.length >= 2) { chosen = m; points = pts; break; }
    }
    if (!chosen) {
      const generalPts = prices
        .filter((r) => r.wheat_type === wt && r.basis !== null && r.basis !== undefined && !r.delivery_month)
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      if (generalPts.length >= 2) points = generalPts;
    }

    return { wt, color: colors[wt], nearest: chosen, points };
  });

  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length < 2) {
    return (
      <div className="card">
        <h3 className="disp" style={{ margin: 0, color: "var(--blue)", textTransform: "uppercase", fontSize: 14 }}>Basis Over Time</h3>
        <p className="mono" style={{ fontSize: 12, color: "var(--muted2)", marginTop: 8 }}>
          Log basis (or both cash and futures) for the nearest tracked month on at least two different dates to see a trend line here.
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
            <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{s.wt}{s.nearest ? ` (${s.nearest})` : " (general/nearby)"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
