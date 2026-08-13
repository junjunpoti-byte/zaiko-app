import { useState, useEffect, useRef, useCallback } from "react";
import Papa from "papaparse";
import {
  Package, ArrowDownCircle, ArrowUpCircle, PlusCircle, History, ClipboardList,
  Check, Mic, Search, MapPin, Pencil, StickyNote, ChevronRight, Trash2, Upload,
  Download, LogOut,
} from "lucide-react";
import { supabase } from "./supabaseClient";

const BAG_KG = 25;
const HISTORY_PAGE_SIZE = 30;
const APP_VERSION = "2.0.0";

const FLOOR1_OPTIONS = ["なし", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
const FLOOR2_OPTIONS = ["なし", "2階A", "2階B"];
const DEFAULT_LOCATION_PICKS = { rack1: "なし", rack2: "なし", floor2: "なし" };

const COLORS = {
  ink: "#1B2130", paper: "#E9E4D8", paperDark: "#DCD5C4", steel: "#6B7280",
  amber: "#B96F16", amberDark: "#8F5510", rust: "#9C3D2E", line: "#C9C0AC",
};

const FONT_IMPORT = `
@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
@keyframes micPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(156,61,46,.5);} 50% { box-shadow: 0 0 0 6px rgba(156,61,46,0);} }
`;

function nowISO() { return new Date().toISOString(); }
function fmtDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function fmtNum(n) { return Number.isInteger(n) ? `${n}` : n.toFixed(1); }
function pad2(n) { return String(n).padStart(2, "0"); }
function dayKey(iso) { const d = new Date(iso); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function monthKey(iso) { const d = new Date(iso); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }

function breakdownKg(totalKg) {
  const bags = Math.floor(totalKg / BAG_KG + 1e-9);
  let leftover = Math.round((totalKg - bags * BAG_KG) * 10) / 10;
  return { bags, leftover, total: totalKg };
}
function breakdownLabel(totalKg) {
  const { bags, leftover, total } = breakdownKg(totalKg);
  return leftover <= 0 ? `${bags}袋 ＝ ${fmtNum(total)}kg` : `${bags}袋 + ${fmtNum(leftover)}kg ＝ ${fmtNum(total)}kg`;
}
function combineAfterIn(existingBreakdown, deltaKg) {
  const delta = breakdownKg(deltaKg);
  return { bags: existingBreakdown.bags + delta.bags, leftoverA: existingBreakdown.leftover, leftoverB: delta.leftover };
}
function labelCombineAfterIn({ bags, leftoverA, leftoverB }) {
  if (leftoverA > 0 && leftoverB > 0) return `${bags}袋 + ${fmtNum(leftoverA)}+${fmtNum(leftoverB)}kg`;
  const sum = leftoverA + leftoverB;
  return sum <= 0 ? `${bags}袋` : `${bags}袋 + ${fmtNum(sum)}kg`;
}
// current stock, accumulated from each movement's own bag/leftover split —
// bags add normally, but each movement's own leftover is kept as a separate
// addition term rather than summed into a single number
function stockBreakdownOf(productId, movements) {
  const relevant = movements
    .filter((m) => m.product_id === productId)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  let bagsTotal = 0;
  const leftoverTerms = [];
  let total = 0;
  relevant.forEach((m) => {
    const { bags, leftover } = breakdownKg(Number(m.qty));
    const sign = m.type === "in" ? 1 : -1;
    bagsTotal += sign * bags;
    if (leftover !== 0) leftoverTerms.push(sign * leftover);
    total += sign * Number(m.qty);
  });
  return { bags: bagsTotal, leftoverTerms, total: Math.round(total * 10) / 10 };
}
function stockBreakdownLabel(bd) {
  if (bd.leftoverTerms.length === 0) return `${bd.bags}袋 ＝ ${fmtNum(bd.total)}kg`;
  let expr = "";
  bd.leftoverTerms.forEach((t, i) => {
    const sign = t < 0 ? "-" : i === 0 ? "" : "+";
    expr += `${sign}${fmtNum(Math.abs(t))}kg`;
  });
  return `${bd.bags}袋+${expr} ＝ ${fmtNum(bd.total)}kg`;
}
function composeLocationLabel(picks) {
  const p = picks || DEFAULT_LOCATION_PICKS;
  const parts = [];
  const r1 = p.rack1 && p.rack1 !== "なし" ? p.rack1.toUpperCase() : null;
  const r2 = p.rack2 && p.rack2 !== "なし" ? p.rack2.toUpperCase() : null;
  if (r1) parts.push(`1階${r1}`);
  if (r2) parts.push(`1階${r2}`);
  if (p.floor2 && p.floor2 !== "なし") parts.push(p.floor2);
  return parts.length ? parts.join(" ・ ") : "未設定";
}
function mergeLocations(existingLoc, newLoc) {
  const clean = (s) => (s || "").trim();
  const ex = clean(existingLoc), nw = clean(newLoc);
  if (!ex || ex === "未設定") return nw || "未設定";
  if (!nw || nw === "未設定") return ex;
  const parts = new Set([...ex.split(" ・ ").map((x) => x.trim()).filter(Boolean), ...nw.split(" ・ ").map((x) => x.trim()).filter(Boolean)]);
  return Array.from(parts).join(" ・ ");
}
function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const ax = [], bx = [];
  String(a).replace(re, (_, num, str) => { ax.push([num ? parseInt(num, 10) : Infinity, str || ""]); return ""; });
  String(b).replace(re, (_, num, str) => { bx.push([num ? parseInt(num, 10) : Infinity, str || ""]); return ""; });
  while (ax.length && bx.length) {
    const an = ax.shift(), bn = bx.shift();
    const diff = an[0] - bn[0] || an[1].localeCompare(bn[1], "ja");
    if (diff) return diff;
  }
  return ax.length - bx.length;
}

// ---------- Voice input ----------
function useSpeechToText(onResult) {
  const [listening, setListening] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const recognitionRef = useRef(null);
  const start = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setUnsupported(true); return; }
    const recognition = new SR();
    recognition.lang = "ja-JP";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (e) => onResult(e.results[0][0].transcript);
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    try { recognition.start(); } catch (e) { setListening(false); }
  };
  const stop = () => { recognitionRef.current?.stop(); setListening(false); };
  return { listening, unsupported, start, stop };
}

function VoiceField({ label, value, onChange, placeholder, numeric = false, type = "text", suffix, helper }) {
  const { listening, unsupported, start, stop } = useSpeechToText((text) => {
    if (numeric) { const d = text.replace(/[^0-9.]/g, ""); if (d) onChange(d); }
    else onChange(text);
  });
  return (
    <div>
      {label && <label style={styles.label}>{label}</label>}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input style={{ ...styles.input, flex: 1 }} type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        <button type="button" title={unsupported ? "このブラウザは音声入力に対応していません" : "音声入力"} onClick={listening ? stop : start}
          style={{ ...styles.micBtn, ...(listening ? styles.micBtnActive : {}), opacity: unsupported ? 0.4 : 1 }}>
          <Mic size={15} />
        </button>
        {suffix && <span style={styles.fieldSuffix}>{suffix}</span>}
      </div>
      {helper && <div style={styles.fieldHelper}>{helper}</div>}
      {listening && <div style={styles.listeningHint}>● 聞き取り中…</div>}
    </div>
  );
}

// ==================== AUTH ====================
function AuthScreen() {
  const [mode, setMode] = useState("signin"); // signin | signup
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(""); setMsg(""); setBusy(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMsg("登録しました。確認メールの設定によっては、そのままログインできます。");
      }
    } catch (e) {
      setErr(e.message || "エラーが発生しました。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...styles.root, alignItems: "center", justifyContent: "center", display: "flex" }}>
      <style>{FONT_IMPORT}</style>
      <div style={{ ...styles.modalCard, maxWidth: 320 }}>
        <div style={styles.stampBadge}><Package size={20} color={COLORS.paper} /></div>
        <div style={styles.modalTitle}>在庫管理台帳</div>
        <div style={styles.modalSub}>{mode === "signin" ? "ログイン" : "新規登録"}してください。</div>
        <input style={styles.input} type="email" placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input style={styles.input} type="password" placeholder="パスワード" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        {err && <div style={styles.inlineError}>{err}</div>}
        {msg && <div style={styles.inlineSuccess}>{msg}</div>}
        <button style={styles.primaryBtn} onClick={submit} disabled={busy}>
          {busy ? "処理中…" : mode === "signin" ? "ログイン" : "登録する"}
        </button>
        <button style={styles.smallGhostBtn} onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setErr(""); setMsg(""); }}>
          {mode === "signin" ? "アカウントを新規作成" : "ログイン画面に戻る"}
        </button>
      </div>
    </div>
  );
}

// ==================== MAIN APP ====================
export default function App() {
  const [session, setSession] = useState(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setCheckingAuth(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (checkingAuth) {
    return <div style={{ ...styles.root, alignItems: "center", justifyContent: "center", display: "flex" }}><style>{FONT_IMPORT}</style></div>;
  }
  if (!session) return <AuthScreen />;
  return <MainApp session={session} />;
}

function MainApp({ session }) {
  const [products, setProducts] = useState([]);
  const [movements, setMovements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState("");
  const [tab, setTab] = useState("stock");
  const [stamp, setStamp] = useState(null);
  const [jumpToProductId, setJumpToProductId] = useState(null);

  const displayName = session.user.user_metadata?.display_name || session.user.email;

  // initial fetch
  useEffect(() => {
    (async () => {
      const [{ data: p, error: pe }, { data: m, error: me }] = await Promise.all([
        supabase.from("products").select("*").order("created_at", { ascending: true }),
        supabase.from("movements").select("*").order("created_at", { ascending: false }),
      ]);
      if (pe || me) setSaveError("データの取得に失敗しました。");
      setProducts(p || []);
      setMovements(m || []);
      setLoading(false);
    })();
  }, []);

  // realtime sync: reflects changes from any device/user immediately
  useEffect(() => {
    const channel = supabase
      .channel("inventory-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "products" }, (payload) => {
        setProducts((prev) => {
          if (payload.eventType === "INSERT") return [...prev, payload.new];
          if (payload.eventType === "UPDATE") return prev.map((p) => (p.id === payload.new.id ? payload.new : p));
          if (payload.eventType === "DELETE") return prev.filter((p) => p.id !== payload.old.id);
          return prev;
        });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "movements" }, (payload) => {
        setMovements((prev) => {
          if (payload.eventType === "INSERT") return [payload.new, ...prev];
          if (payload.eventType === "UPDATE") return prev.map((m) => (m.id === payload.new.id ? payload.new : m));
          if (payload.eventType === "DELETE") return prev.filter((m) => m.id !== payload.old.id);
          return prev;
        });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  const stockKgOf = (productId) =>
    movements.filter((m) => m.product_id === productId).reduce((acc, m) => acc + (m.type === "in" ? Number(m.qty) : -Number(m.qty)), 0);

  const addProduct = async ({ sku, name }) => {
    const cleanSku = sku.trim();
    const cleanName = name.trim() || cleanSku;
    const { error } = await supabase.from("products").insert({
      sku: cleanSku, name: cleanName, location: "未設定", memo: "", created_by: session.user.id,
    });
    if (error) setSaveError("登録に失敗しました: " + error.message); else setSaveError("");
  };

  const updateProductField = async (productId, field, value) => {
    const { error } = await supabase.from("products").update({ [field]: value }).eq("id", productId);
    if (error) setSaveError("更新に失敗しました: " + error.message); else setSaveError("");
  };

  const updateProductLocationPicks = async (productId, picks) => {
    const label = composeLocationLabel(picks);
    const { error } = await supabase.from("products").update({ location: label, location_picks: picks }).eq("id", productId);
    if (error) setSaveError("更新に失敗しました: " + error.message); else setSaveError("");
  };

  const deleteProduct = async (productId) => {
    const { error } = await supabase.from("products").delete().eq("id", productId);
    if (error) setSaveError("削除に失敗しました: " + error.message); else setSaveError("");
  };

  const recordMovement = async ({ productId, type, qty }) => {
    const { error } = await supabase.from("movements").insert({
      product_id: productId, type, qty, person: displayName, user_id: session.user.id,
    });
    if (error) { setSaveError("記録に失敗しました: " + error.message); return; }
    setSaveError("");
    setStamp({ type, qty });
    setTimeout(() => setStamp(null), 1100);
  };

  const detectCsvConflicts = (rows) => {
    const freshRows = [], conflicts = [];
    rows.forEach((row) => {
      const sku = (row["商品"] || "").trim();
      if (!sku) return;
      const existing = products.find((p) => (p.sku || "").trim().toLowerCase() === sku.toLowerCase());
      if (existing) conflicts.push({ row, existing, resolution: "skip" });
      else freshRows.push(row);
    });
    return { freshRows, conflicts };
  };

  const commitCsvImport = async ({ freshRows, conflicts }) => {
    let added = 0, merged = 0, skipped = 0, addedAsNew = 0;

    for (const row of freshRows) {
      const sku = (row["商品"] || "").trim();
      if (!sku) continue;
      const name = (row["色"] || "").trim() || sku;
      const location = (row["保管場所"] || "").trim() || "未設定";
      const kg = parseFloat(row["キロ数"]);
      const { data: inserted, error } = await supabase.from("products")
        .insert({ sku, name, location, memo: "", created_by: session.user.id })
        .select().single();
      if (error) continue;
      if (!isNaN(kg) && kg > 0) {
        await supabase.from("movements").insert({ product_id: inserted.id, type: "in", qty: kg, person: displayName, user_id: session.user.id });
      }
      added++;
    }

    for (const { row, existing, resolution } of conflicts) {
      const newLocation = (row["保管場所"] || "").trim() || "未設定";
      const newKg = parseFloat(row["キロ数"]);
      if (resolution === "skip") { skipped++; continue; }
      if (resolution === "merge") {
        const combinedLocation = mergeLocations(existing.location, newLocation);
        await supabase.from("products").update({ location: combinedLocation }).eq("id", existing.id);
        if (!isNaN(newKg) && newKg !== 0) {
          await supabase.from("movements").insert({ product_id: existing.id, type: newKg > 0 ? "in" : "out", qty: Math.abs(newKg), person: displayName, user_id: session.user.id });
        }
        merged++;
        continue;
      }
      if (resolution === "addNew") {
        const sku = (row["商品"] || "").trim();
        const name = (row["色"] || "").trim() || sku;
        const newSku = `${sku}-${Date.now().toString().slice(-5)}`;
        const { data: inserted, error } = await supabase.from("products")
          .insert({ sku: newSku, name, location: newLocation, memo: "", created_by: session.user.id })
          .select().single();
        if (!error && !isNaN(newKg) && newKg > 0) {
          await supabase.from("movements").insert({ product_id: inserted.id, type: "in", qty: newKg, person: displayName, user_id: session.user.id });
        }
        addedAsNew++;
      }
    }
    return { added, merged, skipped, addedAsNew };
  };

  const exportBackup = () => {
    const payload = { exportedAt: nowISO(), version: APP_VERSION, products, movements };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inventory-backup-${dayKey(nowISO())}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const restoreBackup = async (file) => {
    const text = await file.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error("JSONの形式が正しくありません。"); }
    const backupProducts = parsed.products || [];
    const backupMovements = parsed.movements || [];
    // upsert by id so restoring is safe to re-run
    if (backupProducts.length) {
      const cleaned = backupProducts.map((p) => ({
        id: p.id, sku: p.sku, name: p.name, location: p.location || "未設定",
        location_picks: p.location_picks || null, memo: p.memo || "", created_at: p.created_at, created_by: p.created_by || session.user.id,
      }));
      await supabase.from("products").upsert(cleaned);
    }
    if (backupMovements.length) {
      const cleaned = backupMovements.map((m) => ({
        id: m.id, product_id: m.product_id, type: m.type, qty: m.qty,
        person: m.person, user_id: m.user_id || session.user.id, created_at: m.created_at,
      }));
      await supabase.from("movements").upsert(cleaned);
    }
    const [{ data: p }, { data: m }] = await Promise.all([
      supabase.from("products").select("*").order("created_at", { ascending: true }),
      supabase.from("movements").select("*").order("created_at", { ascending: false }),
    ]);
    setProducts(p || []);
    setMovements(m || []);
    return { products: backupProducts.length, movements: backupMovements.length };
  };

  const goToRecord = (productId) => { setJumpToProductId(productId); setTab("record"); };

  if (loading) {
    return (
      <div style={{ ...styles.root, alignItems: "center", justifyContent: "center", display: "flex" }}>
        <style>{FONT_IMPORT}</style>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", color: COLORS.steel }}>読み込み中…</div>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      <style>{FONT_IMPORT}</style>
      {stamp && <StampOverlay type={stamp.type} qty={stamp.qty} />}
      <Header displayName={displayName} onSignOut={() => supabase.auth.signOut()} />
      {saveError && <div style={styles.errorBanner}>{saveError}</div>}

      <nav style={styles.tabs}>
        <TabButton icon={<ClipboardList size={15} />} label="在庫一覧" active={tab === "stock"} onClick={() => setTab("stock")} />
        <TabButton icon={<ArrowDownCircle size={15} />} label="入荷と消費" active={tab === "record"} onClick={() => setTab("record")} />
        <TabButton icon={<History size={15} />} label="履歴" active={tab === "history"} onClick={() => setTab("history")} />
        <TabButton icon={<PlusCircle size={15} />} label="商品登録" active={tab === "products"} onClick={() => setTab("products")} />
      </nav>

      <main style={styles.main}>
        {tab === "stock" && (
          <StockList products={products} movements={movements} onUpdateField={updateProductField} onUpdateLocation={updateProductLocationPicks} onGoToRecord={goToRecord} />
        )}
        {tab === "record" && (
          <RecordMovement products={products} movements={movements} stockKgOf={stockKgOf} onSubmit={recordMovement} presetProductId={jumpToProductId} onConsumedPreset={() => setJumpToProductId(null)} />
        )}
        {tab === "history" && <HistoryList movements={movements} products={products} />}
        {tab === "products" && (
          <ProductForm
            onSubmit={addProduct} products={products} movements={movements} stockKgOf={stockKgOf}
            onDelete={deleteProduct} onDetectConflicts={detectCsvConflicts} onCommitImport={commitCsvImport}
            onExportBackup={exportBackup} onRestoreBackup={restoreBackup}
          />
        )}
      </main>

      <footer style={styles.footer}>
        全メンバーとリアルタイムで共有されます(Supabase接続)。
        <div style={{ marginTop: 2, opacity: 0.7 }}>在庫管理台帳 v{APP_VERSION}</div>
      </footer>
    </div>
  );
}

function Header({ displayName, onSignOut }) {
  return (
    <header style={styles.header}>
      <div style={styles.headerLeft}>
        <div style={styles.stampBadge}><Package size={20} color={COLORS.paper} /></div>
        <div>
          <div style={styles.title}>在庫管理台帳</div>
          <div style={styles.subtitle}>STOCK LEDGER — 社内共有</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={styles.nameChip}>{displayName}</span>
        <button style={styles.iconBtn} title="ログアウト" onClick={onSignOut}><LogOut size={15} /></button>
      </div>
    </header>
  );
}

function TabButton({ icon, label, active, onClick }) {
  return (
    <button onClick={onClick} style={{ ...styles.tabBtn, color: active ? COLORS.ink : COLORS.steel, borderBottom: active ? `2px solid ${COLORS.amber}` : "2px solid transparent", fontWeight: active ? 600 : 500 }}>
      {icon}<span>{label}</span>
    </button>
  );
}

// ---------- Stock list ----------
function StockList({ products, movements, onUpdateField, onUpdateLocation, onGoToRecord }) {
  const [query, setQuery] = useState("");
  const [pickerProduct, setPickerProduct] = useState(null);
  const [visibleCount, setVisibleCount] = useState(HISTORY_PAGE_SIZE);

  useEffect(() => { setVisibleCount(HISTORY_PAGE_SIZE); }, [query]);

  if (products.length === 0) return <EmptyState text="まだ商品が登録されていません。「商品登録」タブから追加してください。" />;

  const lastActivityOf = (productId) => {
    let latest = 0;
    movements.forEach((m) => { if (m.product_id === productId) { const t = new Date(m.created_at).getTime(); if (t > latest) latest = t; } });
    return latest;
  };
  const sortedProducts = [...products].sort((a, b) => lastActivityOf(b.id) - lastActivityOf(a.id));
  const q = query.trim().toLowerCase();
  const filtered = q ? sortedProducts.filter((p) => [p.sku, p.name, p.location, p.memo].some((f) => (f || "").toLowerCase().includes(q))) : sortedProducts;
  const visible = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visible.length;

  return (
    <div>
      <div style={styles.searchWrap}><Search size={15} color={COLORS.steel} /><VoiceField value={query} onChange={setQuery} placeholder="商品・色・保管場所・メモで検索" /></div>
      {pickerProduct && (
        <LocationPickerModal initialPicks={pickerProduct.location_picks} onCancel={() => setPickerProduct(null)}
          onSave={(picks) => { onUpdateLocation(pickerProduct.id, picks); setPickerProduct(null); }} />
      )}
      {filtered.length === 0 ? <EmptyState text={`「${query}」に一致する商品が見つかりません。`} /> : (
        <>
          <div style={styles.historyCount}>{filtered.length}件中 {visible.length}件を表示</div>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead><tr>
                <th style={styles.th}>商品 / 色</th><th style={styles.th}>保管場所</th><th style={styles.th}>メモ</th>
                <th style={{ ...styles.th, textAlign: "right" }}>現在庫（25kg = 1袋）</th>
              </tr></thead>
              <tbody>
                {visible.map((p) => {
                  const bd = stockBreakdownOf(p.id, movements);
                  return (
                    <tr key={p.id}>
                      <td style={styles.td}>
                        <button style={styles.productLinkBtn} onClick={() => onGoToRecord(p.id)}>
                          <div>
                            <div style={{ fontWeight: 600 }}>{p.sku}</div>
                            <div style={{ fontSize: 11.5, color: COLORS.steel }}>色: {p.name}</div>
                          </div>
                          <ChevronRight size={14} color={COLORS.steel} />
                        </button>
                      </td>
                      <td style={{ ...styles.td, minWidth: 160 }}>
                        <button style={styles.locationBtn} onClick={() => setPickerProduct(p)}>
                          <MapPin size={11} /><span>{p.location || "未設定"}</span><Pencil size={11} style={{ opacity: 0.6, marginLeft: 2 }} />
                        </button>
                      </td>
                      <td style={{ ...styles.td, minWidth: 160 }}>
                        <EditableCell icon={<StickyNote size={11} />} value={p.memo} placeholder="例: 賞味期限に注意" emptyLabel="メモを追加" onSave={(v) => onUpdateField(p.id, "memo", v.trim())} />
                      </td>
                      <td style={{ ...styles.td, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, whiteSpace: "nowrap" }}>{stockBreakdownLabel(bd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {hasMore && <button style={styles.loadMoreBtn} onClick={() => setVisibleCount((v) => v + HISTORY_PAGE_SIZE)}>さらに表示</button>}
        </>
      )}
    </div>
  );
}

function EditableCell({ icon, value, placeholder, emptyLabel, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const save = () => { onSave(draft); setEditing(false); };
  if (editing) {
    return (
      <div style={{ minWidth: 200 }}>
        <VoiceField value={draft} onChange={setDraft} placeholder={placeholder} />
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <button style={styles.smallPrimaryBtn} onClick={save}>保存</button>
          <button style={styles.smallGhostBtn} onClick={() => { setDraft(value || ""); setEditing(false); }}>キャンセル</button>
        </div>
      </div>
    );
  }
  return <button style={styles.locationBtn} onClick={() => setEditing(true)}>{icon}<span>{value || emptyLabel}</span><Pencil size={11} style={{ opacity: 0.6, marginLeft: 2 }} /></button>;
}

function ScrollPickerColumn({ title, options, value, onChange }) {
  return (
    <div style={styles.pickerColumn}>
      <div style={styles.pickerColumnTitle}>{title}</div>
      <div style={styles.pickerColumnList}>
        {options.map((opt) => (
          <button key={opt} onClick={() => onChange(opt)} style={{ ...styles.pickerOption, ...(value === opt ? styles.pickerOptionActive : {}) }}>{opt}</button>
        ))}
      </div>
    </div>
  );
}

function LocationPickerModal({ initialPicks, onSave, onCancel }) {
  const init = initialPicks || DEFAULT_LOCATION_PICKS;
  const [rack1, setRack1] = useState(init.rack1 || "なし");
  const [rack2, setRack2] = useState(init.rack2 || "なし");
  const [floor2, setFloor2] = useState(init.floor2 || "なし");
  return (
    <div style={styles.modalOverlay}>
      <div style={{ ...styles.modalCard, maxWidth: 420 }}>
        <div style={styles.modalTitle}>保管場所を選択</div>
        <div style={styles.modalSub}>それぞれのリストからスクロールして選べます。</div>
        <div style={styles.pickerRow}>
          <ScrollPickerColumn title="1階 (ラックA)" options={FLOOR1_OPTIONS} value={rack1} onChange={setRack1} />
          <ScrollPickerColumn title="1階 (ラックB)" options={FLOOR1_OPTIONS} value={rack2} onChange={setRack2} />
          <ScrollPickerColumn title="2階" options={FLOOR2_OPTIONS} value={floor2} onChange={setFloor2} />
        </div>
        <div style={styles.pickerPreview}>{composeLocationLabel({ rack1, rack2, floor2 })}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ ...styles.primaryBtn, flex: 1, marginTop: 0 }} onClick={() => onSave({ rack1, rack2, floor2 })}>保存</button>
          <button style={{ ...styles.smallGhostBtn, flex: "0 0 auto", padding: "0 16px" }} onClick={onCancel}>キャンセル</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Record movement ----------
function RecordMovement({ products, movements, stockKgOf, onSubmit, presetProductId, onConsumedPreset }) {
  const sortedProducts = [...products].sort((a, b) => naturalCompare(a.sku, b.sku));
  const [productId, setProductId] = useState(presetProductId || (sortedProducts[0] && sortedProducts[0].id) || "");
  const [type, setType] = useState("in");
  const [qty, setQty] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => { if (presetProductId) onConsumedPreset && onConsumedPreset(); }, []); // eslint-disable-line
  useEffect(() => { if (!productId && sortedProducts.length > 0) setProductId(sortedProducts[0].id); }, [sortedProducts, productId]);

  if (products.length === 0) return <EmptyState text="先に「商品登録」タブで商品を登録してください。" />;

  const selected = products.find((p) => p.id === productId);
  const currentKg = selected ? stockKgOf(selected.id) : 0;
  const qtyNum = Number(qty) || 0;

  const submit = () => {
    const n = Number(qty);
    if (!productId || !n || n <= 0) { setErr("数量は0より大きい数字で入力してください。"); return; }
    if (type === "out" && n > currentKg) { setErr(`消費量が現在庫（${fmtNum(currentKg)}kg）を超えています。`); return; }
    setErr("");
    onSubmit({ productId, type, qty: n });
    setQty("");
  };

  return (
    <div style={styles.formCard}>
      {selected && (
        <div style={styles.selectedProductBanner}>
          <div style={{ fontWeight: 600 }}>{selected.sku}</div>
          <div style={{ fontSize: 11.5, color: COLORS.steel }}>色: {selected.name}</div>
        </div>
      )}
      <label style={styles.label}>商品</label>
      <select style={styles.input} value={productId} onChange={(e) => setProductId(e.target.value)}>
        {sortedProducts.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}（現在庫 {fmtNum(stockKgOf(p.id))}kg）</option>)}
      </select>
      <label style={styles.label}>区分</label>
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={() => setType("in")} style={{ ...styles.typeBtn, ...(type === "in" ? styles.typeBtnInActive : {}) }}><ArrowDownCircle size={16} />入荷</button>
        <button onClick={() => setType("out")} style={{ ...styles.typeBtn, ...(type === "out" ? styles.typeBtnOutActive : {}) }}><ArrowUpCircle size={16} />消費</button>
      </div>
      <VoiceField label="数量（kg）" value={qty} onChange={setQty} placeholder="0" numeric
        helper={qtyNum > 0 ? (type === "in" ? `入荷 ${breakdownLabel(qtyNum)} → 記録後: ${labelCombineAfterIn(combineAfterIn(stockBreakdownOfSimple(selected, movements), qtyNum))}` : `消費 ${breakdownLabel(qtyNum)} → 記録後: ${breakdownLabel(Math.max(currentKg - qtyNum, 0))}`) : "25kg＝1袋で換算されます"} />
      {err && <div style={styles.inlineError}>{err}</div>}
      <button style={styles.primaryBtn} onClick={submit}>記録する</button>
    </div>
  );
}
// simplified breakdown (bags, leftover as single summed number) for the "記録後" preview
function stockBreakdownOfSimple(product, movements) {
  if (!product) return { bags: 0, leftover: 0 };
  const bd = stockBreakdownOf(product.id, movements);
  const leftover = bd.leftoverTerms.reduce((a, b) => a + b, 0);
  return { bags: bd.bags, leftover };
}

// ---------- History ----------
function HistoryList({ movements, products }) {
  const [query, setQuery] = useState("");
  const [filterMode, setFilterMode] = useState("all");
  const [filterDate, setFilterDate] = useState("");
  const [filterMonth, setFilterMonth] = useState("");
  const [visibleCount, setVisibleCount] = useState(HISTORY_PAGE_SIZE);

  useEffect(() => { setVisibleCount(HISTORY_PAGE_SIZE); }, [query, filterMode, filterDate, filterMonth]);

  if (movements.length === 0) return <EmptyState text="まだ入荷・消費の記録がありません。" />;

  const productOf = (id) => products.find((p) => p.id === id);
  const q = query.trim().toLowerCase();
  const sorted = [...movements].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const filtered = sorted.filter((m) => {
    if (q) {
      const p = productOf(m.product_id);
      if (!p) return false;
      const hay = `${p.sku || ""} ${p.name || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filterMode === "day" && filterDate && dayKey(m.created_at) !== filterDate) return false;
    if (filterMode === "month" && filterMonth && monthKey(m.created_at) !== filterMonth) return false;
    return true;
  });
  const visible = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visible.length;

  return (
    <div>
      <div style={styles.searchWrap}><Search size={15} color={COLORS.steel} /><VoiceField value={query} onChange={setQuery} placeholder="商品・色で検索" /></div>
      <div style={styles.filterRow}>
        <select style={{ ...styles.input, flex: "0 0 auto", width: "auto" }} value={filterMode} onChange={(e) => setFilterMode(e.target.value)}>
          <option value="all">全期間</option><option value="day">日別</option><option value="month">月別</option>
        </select>
        {filterMode === "day" && <input type="date" style={{ ...styles.input, flex: 1 }} value={filterDate} onChange={(e) => setFilterDate(e.target.value)} />}
        {filterMode === "month" && <input type="month" style={{ ...styles.input, flex: 1 }} value={filterMonth} onChange={(e) => setFilterMonth(e.target.value)} />}
      </div>
      {filtered.length === 0 ? <EmptyState text="条件に一致する記録が見つかりません。" /> : (
        <>
          <div style={styles.historyCount}>{filtered.length}件中 {visible.length}件を表示</div>
          <div style={styles.historyList}>
            {visible.map((m) => {
              const p = productOf(m.product_id);
              return (
                <div key={m.id} style={styles.historyRow}>
                  <div style={{ ...styles.historyIcon, background: m.type === "in" ? COLORS.amber : COLORS.rust }}>
                    {m.type === "in" ? <ArrowDownCircle size={14} color={COLORS.paper} /> : <ArrowUpCircle size={14} color={COLORS.paper} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={styles.historyTop}>
                      <span style={{ fontWeight: 600 }}>{p ? p.sku : "(削除された商品)"}</span>
                      <span style={{ color: COLORS.steel, fontSize: 12 }}>{p ? `色: ${p.name}` : "—"}</span>
                    </div>
                    <div style={styles.historyMeta}>{fmtDate(m.created_at)} ・ {m.person}{p && <> ・ {p.location || "未設定"}</>}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, color: m.type === "in" ? COLORS.amberDark : COLORS.rust, whiteSpace: "nowrap" }}>
                      {m.type === "in" ? "+" : "−"}{fmtNum(Number(m.qty))}kg
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {hasMore && <button style={styles.loadMoreBtn} onClick={() => setVisibleCount((v) => v + HISTORY_PAGE_SIZE)}>さらに読み込む</button>}
        </>
      )}
    </div>
  );
}

// ---------- Product form (register / delete / CSV import / backup) ----------
function ProductForm({ onSubmit, products, movements, stockKgOf, onDelete, onDetectConflicts, onCommitImport, onExportBackup, onRestoreBackup }) {
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const fileInputRef = useRef(null);
  const [importMsg, setImportMsg] = useState("");
  const [importing, setImporting] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState("");
  const [confirmProduct, setConfirmProduct] = useState(null);
  const [pendingImport, setPendingImport] = useState(null);
  const backupFileRef = useRef(null);
  const [backupMsg, setBackupMsg] = useState("");
  const [restoring, setRestoring] = useState(false);

  const submit = () => {
    if (!sku.trim()) { setErr("商品は必須です。"); return; }
    setErr("");
    onSubmit({ sku, name });
    setSku(""); setName(""); setDone(true);
    setTimeout(() => setDone(false), 1800);
  };

  const handleFileChange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setImporting(true); setImportMsg("");
    Papa.parse(file, {
      header: true, skipEmptyLines: true, transformHeader: (h) => h.trim(),
      complete: async (results) => {
        try {
          const { freshRows, conflicts } = onDetectConflicts(results.data);
          if (conflicts.length === 0) {
            const summary = await onCommitImport({ freshRows, conflicts: [] });
            setImportMsg(`${summary.added}件登録しました`);
          } else {
            setPendingImport({ freshRows, conflicts });
          }
        } catch (e) { setImportMsg("読み込みに失敗しました。CSVの形式を確認してください。"); }
        finally { setImporting(false); if (fileInputRef.current) fileInputRef.current.value = ""; }
      },
      error: () => { setImportMsg("読み込みに失敗しました。"); setImporting(false); },
    });
  };

  const setConflictResolution = (idx, resolution) => {
    setPendingImport((prev) => {
      if (!prev) return prev;
      return { ...prev, conflicts: prev.conflicts.map((c, i) => (i === idx ? { ...c, resolution } : c)) };
    });
  };

  const runImport = async () => {
    if (!pendingImport) return;
    const summary = await onCommitImport(pendingImport);
    const parts = [`${summary.added}件新規登録`];
    if (summary.merged > 0) parts.push(`${summary.merged}件合算`);
    if (summary.addedAsNew > 0) parts.push(`${summary.addedAsNew}件を別商品として追加`);
    if (summary.skipped > 0) parts.push(`${summary.skipped}件スキップ`);
    setImportMsg(parts.join(" ・ "));
    setPendingImport(null);
  };

  const handleRestoreFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setRestoring(true); setBackupMsg("");
    try {
      const result = await onRestoreBackup(file);
      setBackupMsg(`復元しました（商品${result.products}件・記録${result.movements}件）`);
    } catch (err2) {
      setBackupMsg("復元に失敗しました: " + (err2.message || ""));
    } finally {
      setRestoring(false);
      if (backupFileRef.current) backupFileRef.current.value = "";
    }
  };

  const targetProduct = products.find((p) => p.id === deleteTargetId);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={styles.formCard}>
        <VoiceField label="商品" value={sku} onChange={setSku} placeholder="例: 飼料用トウモロコシ" />
        <VoiceField label="色（任意・未入力の場合は商品と同じになります）" value={name} onChange={setName} placeholder="例: 白" />
        <div style={styles.fieldHelper}>保管場所・メモは登録後、在庫一覧からいつでも設定・変更できます。</div>
        {err && <div style={styles.inlineError}>{err}</div>}
        {done && <div style={styles.inlineSuccess}><Check size={14} /> 登録しました</div>}
        <button style={styles.primaryBtn} onClick={submit}>商品を登録</button>
      </div>

      <div style={styles.formCard}>
        <div style={styles.sectionTitle}>CSVから一括登録</div>
        <div style={styles.fieldHelper}>列は「商品」「色」「保管場所」「キロ数」の順を想定しています（色は未入力の場合、商品と同じになります）。</div>
        <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileChange} style={{ display: "none" }} />
        <button style={styles.secondaryBtn} onClick={() => fileInputRef.current && fileInputRef.current.click()} disabled={importing}>
          <Upload size={15} />{importing ? "読み込み中…" : "CSVファイルを選択"}
        </button>
        {importMsg && <div style={styles.inlineSuccess}>{importMsg}</div>}
      </div>

      <div style={styles.formCard}>
        <div style={styles.sectionTitle}>バックアップ</div>
        <div style={styles.fieldHelper}>全データ(商品・入荷/消費履歴)をJSONファイルとして書き出し、あとで同じ内容を復元できます。</div>
        <button style={styles.secondaryBtn} onClick={onExportBackup}><Download size={15} />バックアップをエクスポート</button>
        <input ref={backupFileRef} type="file" accept=".json" onChange={handleRestoreFile} style={{ display: "none" }} />
        <button style={styles.secondaryBtn} onClick={() => backupFileRef.current && backupFileRef.current.click()} disabled={restoring}>
          <Upload size={15} />{restoring ? "復元中…" : "バックアップから復元"}
        </button>
        {backupMsg && <div style={styles.inlineSuccess}>{backupMsg}</div>}
      </div>

      <div style={styles.formCard}>
        <div style={styles.sectionTitle}>商品の削除</div>
        {products.length === 0 ? <div style={styles.fieldHelper}>削除できる商品がありません。</div> : (
          <>
            <label style={styles.label}>削除する商品を選択</label>
            <select style={styles.input} value={deleteTargetId} onChange={(e) => setDeleteTargetId(e.target.value)}>
              <option value="">選択してください</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}
            </select>
            <button style={{ ...styles.dangerBtn, opacity: targetProduct ? 1 : 0.5 }} disabled={!targetProduct} onClick={() => setConfirmProduct(targetProduct)}>
              <Trash2 size={15} />削除する
            </button>
          </>
        )}
      </div>

      {confirmProduct && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalCard}>
            <div style={styles.modalTitle}>本当に削除しますか？</div>
            <div style={styles.confirmInfoBox}>
              <div style={styles.confirmInfoRow}><span style={styles.confirmInfoLabel}>商品</span><span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{confirmProduct.sku}</span></div>
              <div style={styles.confirmInfoRow}><span style={styles.confirmInfoLabel}>色</span><span>{confirmProduct.name}</span></div>
              <div style={styles.confirmInfoRow}><span style={styles.confirmInfoLabel}>保管場所</span><span>{confirmProduct.location || "未設定"}</span></div>
              <div style={styles.confirmInfoRow}><span style={styles.confirmInfoLabel}>現在庫</span><span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{stockBreakdownLabel(stockBreakdownOf(confirmProduct.id, movements))}</span></div>
            </div>
            <div style={styles.modalSub}>この操作は元に戻せません。入荷・消費の履歴は保持されますが、商品は「(削除された商品)」と表示されます。</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={{ ...styles.dangerBtn, flex: 1, justifyContent: "center" }} onClick={() => { onDelete(confirmProduct.id); setConfirmProduct(null); setDeleteTargetId(""); }}>
                <Trash2 size={15} />削除する
              </button>
              <button style={{ ...styles.smallGhostBtn, flex: "0 0 auto", padding: "0 16px" }} onClick={() => setConfirmProduct(null)}>キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {pendingImport && (
        <div style={styles.modalOverlay}>
          <div style={{ ...styles.modalCard, maxWidth: 520, maxHeight: "85vh", overflowY: "auto" }}>
            <div style={styles.modalTitle}>同じ商品が見つかりました</div>
            <div style={styles.modalSub}>{pendingImport.conflicts.length}件が既存の商品と同じです。それぞれどう扱うか選んでください。</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {pendingImport.conflicts.map((c, idx) => {
                const newLocation = (c.row["保管場所"] || "").trim() || "未設定";
                const newKgRaw = parseFloat(c.row["キロ数"]);
                const newKg = isNaN(newKgRaw) ? null : newKgRaw;
                const currentBd = stockBreakdownOf(c.existing.id, movements);
                return (
                  <div key={idx} style={styles.conflictCard}>
                    <div style={styles.conflictName}>{c.existing.sku}</div>
                    <div style={styles.conflictCompareRow}>
                      <div style={styles.conflictCol}>
                        <div style={styles.conflictColTitle}>既存</div>
                        <div style={styles.conflictColLine}>{c.existing.location || "未設定"}</div>
                        <div style={{ ...styles.conflictColLine, fontFamily: "'IBM Plex Mono', monospace" }}>{stockBreakdownLabel(currentBd)}</div>
                      </div>
                      <div style={styles.conflictCol}>
                        <div style={styles.conflictColTitle}>CSV（新）</div>
                        <div style={styles.conflictColLine}>{newLocation}</div>
                        <div style={{ ...styles.conflictColLine, fontFamily: "'IBM Plex Mono', monospace" }}>{newKg === null ? "—" : breakdownLabel(newKg)}</div>
                      </div>
                    </div>
                    <div style={styles.conflictActions}>
                      <button style={{ ...styles.conflictActionBtn, ...(c.resolution === "merge" ? styles.conflictActionBtnActive : {}) }} onClick={() => setConflictResolution(idx, "merge")}>合算する</button>
                      <button style={{ ...styles.conflictActionBtn, ...(c.resolution === "skip" ? styles.conflictActionBtnActive : {}) }} onClick={() => setConflictResolution(idx, "skip")}>スキップ</button>
                      <button style={{ ...styles.conflictActionBtn, ...(c.resolution === "addNew" ? styles.conflictActionBtnActive : {}) }} onClick={() => setConflictResolution(idx, "addNew")}>別商品として追加</button>
                    </div>
                    {c.resolution === "merge" && <div style={styles.conflictMergeNote}>合算する: キロ数は既存+CSVで加算、保管場所は両方とも保持します</div>}
                  </div>
                );
              })}
            </div>
            {pendingImport.freshRows.length > 0 && <div style={styles.fieldHelper}>他に{pendingImport.freshRows.length}件は新しい商品として、そのまま登録されます。</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button style={{ ...styles.primaryBtn, flex: 1, marginTop: 0 }} onClick={runImport}>インポートを実行</button>
              <button style={{ ...styles.smallGhostBtn, flex: "0 0 auto", padding: "0 16px" }} onClick={() => setPendingImport(null)}>キャンセル</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({ text }) {
  return <div style={styles.empty}><Package size={28} color={COLORS.steel} strokeWidth={1.5} /><div style={{ marginTop: 10 }}>{text}</div></div>;
}

function StampOverlay({ type, qty }) {
  const isIn = type === "in";
  return (
    <div style={styles.stampOverlayWrap}>
      <div style={{ ...styles.stampGraphic, borderColor: isIn ? COLORS.amber : COLORS.rust, color: isIn ? COLORS.amber : COLORS.rust }}>
        <div style={{ fontSize: 13, letterSpacing: 2 }}>{isIn ? "入荷" : "消費"}</div>
        <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace" }}>{isIn ? "+" : "−"}{fmtNum(Number(qty))}kg</div>
      </div>
      <style>{`@keyframes stampThump {0%{transform:scale(2.2) rotate(-14deg);opacity:0;}55%{transform:scale(.95) rotate(-8deg);opacity:1;}70%{transform:scale(1.05) rotate(-8deg);}100%{transform:scale(1) rotate(-8deg);opacity:1;}}`}</style>
    </div>
  );
}

const styles = {
  root: { minHeight: "100vh", background: COLORS.paper, fontFamily: "'IBM Plex Sans', sans-serif", color: COLORS.ink, display: "flex", flexDirection: "column" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px 14px", borderBottom: `2px solid ${COLORS.ink}`, background: COLORS.paper },
  headerLeft: { display: "flex", alignItems: "center", gap: 12 },
  stampBadge: { width: 38, height: 38, borderRadius: 6, background: COLORS.ink, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  title: { fontFamily: "'Oswald', sans-serif", fontSize: 20, fontWeight: 600, letterSpacing: 0.3, lineHeight: 1.1 },
  subtitle: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: COLORS.steel, letterSpacing: 1, marginTop: 2 },
  nameChip: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, border: `1px solid ${COLORS.line}`, borderRadius: 4, padding: "6px 10px", color: COLORS.ink },
  iconBtn: { width: 30, height: 30, borderRadius: 5, border: `1px solid ${COLORS.line}`, background: "#fff", color: COLORS.steel, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },
  errorBanner: { background: "#F3E3DE", color: COLORS.rust, fontSize: 13, padding: "8px 16px" },
  tabs: { display: "flex", borderBottom: `1px solid ${COLORS.line}`, background: COLORS.paperDark, overflowX: "auto" },
  tabBtn: { display: "flex", alignItems: "center", gap: 6, padding: "12px 14px", background: "transparent", border: "none", fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" },
  main: { flex: 1, padding: 16, paddingBottom: 90 },
  footer: { textAlign: "center", fontSize: 11, color: COLORS.steel, padding: "10px 16px 18px", fontFamily: "'IBM Plex Mono', monospace" },
  searchWrap: { display: "flex", alignItems: "center", gap: 8, background: "#F2EEE3", border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: "8px 10px", marginBottom: 12 },
  filterRow: { display: "flex", gap: 8, marginBottom: 12 },
  historyCount: { fontSize: 11.5, color: COLORS.steel, marginBottom: 8, fontFamily: "'IBM Plex Mono', monospace" },
  loadMoreBtn: { width: "100%", marginTop: 10, padding: "10px 0", borderRadius: 6, border: `1px solid ${COLORS.line}`, background: "#F2EEE3", color: COLORS.ink, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  tableWrap: { border: `1px solid ${COLORS.line}`, borderRadius: 6, overflow: "hidden", background: "#F2EEE3", overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "10px 10px", fontSize: 11, color: COLORS.steel, borderBottom: `1px solid ${COLORS.line}`, fontWeight: 600, whiteSpace: "nowrap" },
  td: { padding: "10px 10px", borderBottom: `1px solid ${COLORS.line}`, verticalAlign: "top" },
  productLinkBtn: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, background: "transparent", border: "none", padding: 0, cursor: "pointer", textAlign: "left", color: COLORS.ink, width: "100%", minWidth: 140 },
  selectedProductBanner: { background: COLORS.paperDark, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: "8px 12px", marginBottom: 4 },
  formCard: { background: "#F2EEE3", border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: 18, display: "flex", flexDirection: "column", gap: 10, maxWidth: 480 },
  label: { fontSize: 11.5, color: COLORS.steel, display: "block", marginBottom: 4 },
  input: { fontSize: 14, padding: "10px 12px", borderRadius: 5, border: `1px solid ${COLORS.line}`, background: "#fff", color: COLORS.ink, outline: "none", width: "100%", boxSizing: "border-box" },
  micBtn: { width: 34, height: 34, borderRadius: 5, border: `1px solid ${COLORS.line}`, background: "#fff", color: COLORS.steel, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 },
  micBtnActive: { background: COLORS.rust, borderColor: COLORS.rust, color: "#fff", animation: "micPulse 1s infinite" },
  fieldSuffix: { fontSize: 12, color: COLORS.steel, fontFamily: "'IBM Plex Mono', monospace", whiteSpace: "nowrap" },
  fieldHelper: { fontSize: 11.5, color: COLORS.amberDark, marginTop: 4, fontFamily: "'IBM Plex Mono', monospace" },
  listeningHint: { fontSize: 11, color: COLORS.rust, marginTop: 4 },
  typeBtn: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "10px 0", borderRadius: 5, border: `1px solid ${COLORS.line}`, background: "#fff", color: COLORS.steel, fontSize: 13, cursor: "pointer", fontWeight: 600 },
  typeBtnInActive: { background: COLORS.amber, borderColor: COLORS.amber, color: "#fff" },
  typeBtnOutActive: { background: COLORS.rust, borderColor: COLORS.rust, color: "#fff" },
  primaryBtn: { marginTop: 8, padding: "12px 0", borderRadius: 6, border: "none", background: COLORS.ink, color: COLORS.paper, fontSize: 14, fontWeight: 600, cursor: "pointer" },
  secondaryBtn: { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "11px 0", borderRadius: 6, border: `1px solid ${COLORS.line}`, background: "#fff", color: COLORS.ink, fontSize: 13.5, fontWeight: 600, cursor: "pointer" },
  dangerBtn: { display: "flex", alignItems: "center", gap: 8, marginTop: 4, padding: "11px 16px", borderRadius: 6, border: "none", background: COLORS.rust, color: "#fff", fontSize: 13.5, fontWeight: 600, cursor: "pointer" },
  sectionTitle: { fontFamily: "'Oswald', sans-serif", fontSize: 15, fontWeight: 600, color: COLORS.ink },
  confirmInfoBox: { background: COLORS.paperDark, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 },
  confirmInfoRow: { display: "flex", justifyContent: "space-between", fontSize: 13, gap: 10 },
  confirmInfoLabel: { color: COLORS.steel, fontSize: 11.5, flexShrink: 0 },
  conflictCard: { background: COLORS.paperDark, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 },
  conflictName: { fontWeight: 600, fontSize: 13.5 },
  conflictCompareRow: { display: "flex", gap: 10 },
  conflictCol: { flex: 1, background: "#fff", border: `1px solid ${COLORS.line}`, borderRadius: 5, padding: "6px 8px" },
  conflictColTitle: { fontSize: 10.5, color: COLORS.steel, marginBottom: 3 },
  conflictColLine: { fontSize: 12.5, color: COLORS.ink },
  conflictActions: { display: "flex", gap: 6 },
  conflictActionBtn: { flex: 1, padding: "7px 4px", borderRadius: 5, border: `1px solid ${COLORS.line}`, background: "#fff", color: COLORS.steel, fontSize: 12, fontWeight: 600, cursor: "pointer" },
  conflictActionBtnActive: { background: COLORS.ink, borderColor: COLORS.ink, color: COLORS.paper },
  conflictMergeNote: { fontSize: 11, color: COLORS.amberDark, fontFamily: "'IBM Plex Mono', monospace" },
  locationBtn: { display: "inline-flex", alignItems: "center", gap: 4, background: "transparent", border: `1px dashed ${COLORS.line}`, borderRadius: 5, padding: "4px 8px", fontSize: 12.5, color: COLORS.steel, cursor: "pointer" },
  pickerRow: { display: "flex", gap: 8 },
  pickerColumn: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0 },
  pickerColumnTitle: { fontSize: 10.5, color: COLORS.steel, textAlign: "center", marginBottom: 4, fontFamily: "'IBM Plex Mono', monospace" },
  pickerColumnList: { height: 160, overflowY: "auto", border: `1px solid ${COLORS.line}`, borderRadius: 6, background: "#fff", display: "flex", flexDirection: "column" },
  pickerOption: { padding: "9px 4px", border: "none", borderBottom: `1px solid ${COLORS.paperDark}`, background: "transparent", fontSize: 13, color: COLORS.ink, cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace", textAlign: "center" },
  pickerOptionActive: { background: COLORS.amber, color: "#fff", fontWeight: 700 },
  pickerPreview: { textAlign: "center", fontSize: 12.5, color: COLORS.amberDark, fontFamily: "'IBM Plex Mono', monospace", padding: "6px 0 2px" },
  empty: { textAlign: "center", color: COLORS.steel, padding: "48px 20px", fontSize: 13.5, border: `1px dashed ${COLORS.line}`, borderRadius: 8 },
  historyList: { display: "flex", flexDirection: "column", gap: 8 },
  historyRow: { display: "flex", gap: 10, alignItems: "flex-start", background: "#F2EEE3", border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: "10px 12px" },
  historyIcon: { width: 24, height: 24, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 },
  historyTop: { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13.5 },
  historyMeta: { fontSize: 11, color: COLORS.steel, marginTop: 4, fontFamily: "'IBM Plex Mono', monospace" },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(27,33,48,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 },
  modalCard: { background: COLORS.paper, borderRadius: 8, padding: 22, width: "100%", maxWidth: 320, display: "flex", flexDirection: "column", gap: 10, border: `1px solid ${COLORS.line}` },
  modalTitle: { fontFamily: "'Oswald', sans-serif", fontSize: 17, fontWeight: 600 },
  modalSub: { fontSize: 12.5, color: COLORS.steel, marginBottom: 2 },
  smallPrimaryBtn: { padding: "6px 12px", borderRadius: 5, border: "none", background: COLORS.ink, color: COLORS.paper, fontSize: 12, fontWeight: 600, cursor: "pointer" },
  smallGhostBtn: { padding: "6px 12px", borderRadius: 5, border: `1px solid ${COLORS.line}`, background: "transparent", color: COLORS.steel, fontSize: 12, cursor: "pointer" },
  inlineError: { color: COLORS.rust, fontSize: 12.5 },
  inlineSuccess: { color: COLORS.amberDark, fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 },
  stampOverlayWrap: { position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, pointerEvents: "none" },
  stampGraphic: { border: "4px solid", borderRadius: 10, padding: "16px 26px", background: "rgba(233,228,216,0.92)", textAlign: "center", fontFamily: "'Oswald', sans-serif", fontWeight: 700, transform: "rotate(-8deg)", animation: "stampThump 0.6s cubic-bezier(.2,1.6,.4,1)" },
};
