import { neon } from "@neondatabase/serverless";

// Darwin Paper executor, intentionally isolated from the Second cerveau database.
// Schedule: one invocation per UTC minute. Orders only when DARWIN_TRADING_ENABLED=true.
export const config = { schedule: "* * * * *" };
const SYMBOL = "ETH/USD";
const TERMINAL = new Set(["filled", "canceled", "expired", "rejected"]);
const env = (name) => globalThis.Netlify?.env?.get?.(name) || process.env[name] || "";
const num = (v) => Number(v || 0);
const roundDown = (n, digits) => Math.floor((n + Number.EPSILON) * 10 ** digits) / 10 ** digits;
const isoMinute = (d) => new Date(Math.floor(d.getTime() / 60000) * 60000).toISOString();
const sqlValue = (v) => v === undefined ? null : v;

function paperBase() {
  const value = env("ALPACA_BASE_URL").replace(/\/+$/, "");
  if (!/^https:\/\/paper-api\.alpaca\.markets(?:\/v2)?$/.test(value)) {
    throw new Error("Paper-only protection: ALPACA_BASE_URL must be paper-api.alpaca.markets");
  }
  return "https://paper-api.alpaca.markets";
}
async function request(url, options = {}) {
  const headers = {
    "APCA-API-KEY-ID": env("ALPACA_API_KEY"),
    "APCA-API-SECRET-KEY": env("ALPACA_SECRET_KEY"),
    ...(options.body ? { "Content-Type": "application/json" } : {}),
  };
  const response = await fetch(url, {
    ...options, headers: { ...headers, ...options.headers },
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.text();
  let value;
  try { value = JSON.parse(body); } catch { value = { message: body.slice(0, 240) }; }
  if (!response.ok) {
    const error = new Error("HTTP " + response.status + ": " + String(value.message || "").slice(0, 160));
    error.status = response.status;
    throw error;
  }
  return value;
}
async function broker(path, opts) { return request(paperBase() + path, opts); }
async function getOrder(clientId) {
  try {
    return await broker("/v2/orders:by_client_order_id?client_order_id=" + encodeURIComponent(clientId));
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}
async function getBars(timeframe, now) {
  const q = new URLSearchParams({
    symbols: SYMBOL,
    timeframe,
    start: new Date(now.getTime() - 1000 * 60 * 100).toISOString(),
    end: now.toISOString(),
    limit: "300",
    sort: "asc",
  });
  const data = await request("https://data.alpaca.markets/v1beta3/crypto/us/bars?" + q);
  const ms = timeframe === "5Min" ? 300000 : 60000;
  return (data.bars?.[SYMBOL] || [])
    .filter((b) => Number.isFinite(num(b.c)) && new Date(b.t).getTime() + ms <= now.getTime() - 2000)
    .sort((a, b) => new Date(a.t) - new Date(b.t));
}
async function ownedPosition(sql) {
  const a = await sql.query("SELECT * FROM darwin_engine_positions WHERE symbol=$1 AND qty>0", [SYMBOL]);
  return a[0] || null;
}
function getBrokerPosition(positions) {
  return positions.find((p) => (p.symbol || "").replace("/", "") === SYMBOL.replace("/", "")) || null;
}
async function fillRecorded(sql, row, order) {
  // Broker is source of truth. Never book a Paper execution before broker confirms filled.
  if (order.status !== "filled" || !order.id || !order.filled_at) return false;
  const qty = num(order.filled_qty);
  const price = num(order.filled_avg_price);
  if (!(qty > 0 && price > 0)) return false;
  let netAvailable = null;
  if (row.side === "buy") {
    const positions = await broker("/v2/positions");
    const position = getBrokerPosition(positions);
    netAvailable = num(position?.qty_available);
    if (!(netAvailable > 0)) return false;
  }
  await sql.query(
    "INSERT INTO trades(strategy_id,symbol,side,order_type,requested_notional_usd,requested_qty,filled_qty,avg_fill_price_usd,status,broker,broker_order_id,idempotency_key,signal_reason,filled_at) SELECT $1,$2,$3,'market',$4,$5,$6,$7,'filled','alpaca_paper',$8,$9,$10,$11::timestamptz WHERE NOT EXISTS (SELECT 1 FROM trades WHERE broker_order_id=$8)",
    [row.strategy_id, SYMBOL, row.side, row.requested_notional, row.requested_qty, qty, price, order.id, row.client_order_id, "Darwin minute executor: confirmed Alpaca Paper", order.filled_at]
  );
  if (row.side === "buy") {
    await sql.query(
      "INSERT INTO darwin_engine_positions(symbol,strategy_id,buy_client_order_id,qty,avg_fill_price,acquired_at,updated_at) VALUES($1,$2,$3,$4,$5,$6::timestamptz,now()) ON CONFLICT(symbol) DO UPDATE SET strategy_id=excluded.strategy_id,buy_client_order_id=excluded.buy_client_order_id,qty=excluded.qty,avg_fill_price=excluded.avg_fill_price,acquired_at=excluded.acquired_at,updated_at=now()",
      [SYMBOL, row.strategy_id, row.client_order_id, netAvailable, price, order.filled_at]
    );
  } else {
    await sql.query("UPDATE darwin_engine_positions SET qty=0,updated_at=now() WHERE symbol=$1", [SYMBOL]);
  }
  await sql.query(
    "UPDATE darwin_engine_orders SET broker_order_id=$2,broker_status=$3,status='filled',filled_qty=$4,filled_avg_price=$5,updated_at=now() WHERE client_order_id=$1",
    [row.client_order_id, order.id, order.status, qty, price]
  );
  return true;
}
async function reconcilePending(sql) {
  const rows = await sql.query(
    "SELECT * FROM darwin_engine_orders WHERE status IN ('prepared','submitted','pending_new','partially_filled','filled_pending_sync') ORDER BY created_at ASC LIMIT 20"
  );
  for (const row of rows) {
    const order = await getOrder(row.client_order_id);
    if (!order) return { ready: false, reason: "unresolved_intent_" + row.client_order_id };
    if (order.status === "filled") {
      const ok = await fillRecorded(sql, row, order);
      if (!ok) return { ready: false, reason: "filled_pending_reconciliation_" + row.client_order_id };
    } else if (TERMINAL.has(order.status)) {
      await sql.query("UPDATE darwin_engine_orders SET status=$2,broker_status=$2,broker_order_id=$3,updated_at=now() WHERE client_order_id=$1",
        [row.client_order_id, order.status, order.id]);
    } else return { ready: false, reason: "broker_order_pending_" + row.client_order_id };
  }
  return { ready: true };
}
async function sendOrder(sql, strategyId, side, candle, params) {
  const t = new Date(candle.t);
  const minute = isoMinute(t).replace(/[-:TZ.]/g, "").slice(0, 12);
  const id = "darwin-" + strategyId + "-" + minute + "-" + side;
  const requestedNotional = params.notional ?? null;
  const requestedQty = params.qty ?? null;
  const inserted = await sql.query(
    "INSERT INTO darwin_engine_orders(client_order_id,strategy_id,symbol,side,signal_bar_utc,requested_notional,requested_qty,status) VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,'prepared') ON CONFLICT DO NOTHING RETURNING client_order_id",
    [id, strategyId, SYMBOL, side, t.toISOString(), requestedNotional, requestedQty]
  );
  if (!inserted.length) return { action: "duplicate_signal", id };
  let order;
  try {
    order = await broker("/v2/orders", {
      method: "POST",
      body: JSON.stringify({ symbol: SYMBOL, side, type: "market", time_in_force: "ioc", client_order_id: id, ...params }),
    });
  } catch (error) {
    // A timeout is ambiguous. Preserve intent and reconcile via Alpaca's client-order-ID endpoint.
    await sql.query(
      "UPDATE darwin_engine_orders SET status=$2,error=$3,updated_at=now() WHERE client_order_id=$1",
      [id, error.status && error.status < 500 && error.status !== 429 ? "rejected" : "prepared", String(error.message).slice(0, 300)]
    );
    throw error;
  }
  await sql.query(
    "UPDATE darwin_engine_orders SET status=$2,broker_status=$2,broker_order_id=$3,updated_at=now() WHERE client_order_id=$1",
    [id, order.status === "filled" ? "filled_pending_sync" : (order.status || "submitted"), order.id]
  );
  if (order.status !== "filled") order = await getOrder(id) || order;
  if (order.status === "filled") {
    const row = (await sql.query("SELECT * FROM darwin_engine_orders WHERE client_order_id=$1", [id]))[0];
    const ok = await fillRecorded(sql, row, order);
    if (!ok) await sql.query("UPDATE darwin_engine_orders SET status='filled_pending_sync',updated_at=now() WHERE client_order_id=$1", [id]);
    return { action: side, id, broker: order.id, status: order.status, synchronized: ok };
  }
  return { action: side, id, broker: order.id, status: order.status };
}
async function run(sql, now) {
  paperBase(); // Fail closed before any order if endpoint is not strictly Alpaca Paper.
  if (!env("ALPACA_API_KEY") || !env("ALPACA_SECRET_KEY")) throw new Error("Missing Paper API credentials");
  const account = await broker("/v2/account");
  if (account.status !== "ACTIVE" || account.trading_blocked || account.account_blocked) {
    throw new Error("Alpaca Paper account not tradable");
  }
  const synced = await reconcilePending(sql);
  if (!synced.ready) return { action: "waiting", reason: synced.reason };
  const [orders, positions] = await Promise.all([
    broker("/v2/orders?status=open&limit=100"),
    broker("/v2/positions"),
  ]);
  if (orders.some((o) => (o.symbol || "").replace("/", "") === SYMBOL.replace("/", ""))) {
    return { action: "waiting", reason: "open_eth_order" };
  }
  let owned = await ownedPosition(sql);
  const brokerPosition = getBrokerPosition(positions);
  if (!owned && num(brokerPosition?.qty_available) > 0) {
    return { action: "waiting", reason: "unowned_eth_position_preserved" };
  }
  const strategyRows = await sql.query("SELECT id,genome FROM strategies WHERE id IN (23,24) AND status='paper_trial'");
  const p23 = strategyRows.find((s) => Number(s.id) === 23)?.genome;
  const p24 = strategyRows.find((s) => Number(s.id) === 24)?.genome;
  if (!p23 || !p24) return { action: "waiting", reason: "inactive_strategy_genome" };
  const [m1, m5] = await Promise.all([getBars("1Min", now), getBars("5Min", now)]);
  if (m1.length < 6 || m5.length < 5) return { action: "waiting", reason: "insufficient_closed_bars" };
  const last1 = m1.at(-1), prev1 = m1.at(-2), last5 = m5.at(-1);
  const momentum5 = num(last5.c) / num(m5.at(-4).c) - 1;
  const last5Return = num(last5.c) / num(m5.at(-2).c) - 1;
  if (owned) {
    const available = num(brokerPosition?.qty_available);
    const held = num(owned.qty);
    if (!(available > 0)) return { action: "waiting", reason: "position_reconciliation_required" };
    const r = num(last1.c) / num(owned.avg_fill_price) - 1;
    const ageMinutes = (now.getTime() - new Date(owned.acquired_at).getTime()) / 60000;
    const active = Number(owned.strategy_id) === 23 ? p23 : p24;
    const target = Number(active.profit_target);
    const stop = Number(active.stop_threshold);
    const maxAge = Number(active.max_hold_minutes);
    if (!(target > 0 && stop < 0 && maxAge > 0)) throw new Error("Invalid strategy exit parameters");
    const closeIt = (r >= target || r <= stop || ageMinutes >= maxAge ||
      (Number(owned.strategy_id) === 23 && momentum5 <= 0 && ageMinutes >= 1));
    if (!closeIt) return { action: "hold", strategy: owned.strategy_id };
    const quantity = roundDown(Math.min(available, held), 9);
    if (!(quantity > 0)) return { action: "waiting", reason: "no_sellable_quantity" };
    return sendOrder(sql, Number(owned.strategy_id), "sell", last1, { qty: String(quantity) });
  }
  let strategyId = null;
  if (momentum5 > Number(p23.momentum_threshold)) strategyId = 23;
  else if (last5Return <= Number(p24.reversion_trigger) && num(last1.c) > num(prev1.h)) strategyId = 24;
  if (!strategyId) return { action: "no_signal" };
  const cash = Math.min(num(account.cash), num(account.buying_power));
  const notional = roundDown(cash / 1.0025 - 0.01, 2); // reserve estimated broker fee, not a trading cap
  if (!(notional > 0)) return { action: "waiting", reason: "no_cash" };
  const asset = await broker("/v2/assets/ETHUSD");
  if (!asset.tradable) return { action: "waiting", reason: "asset_not_tradable" };
  if (num(asset.min_order_size) > 0 && notional / num(last1.c) < num(asset.min_order_size)) {
    return { action: "waiting", reason: "broker_asset_min_order_size" };
  }
  return sendOrder(sql, strategyId, "buy", strategyId === 23 ? last5 : last1, { notional: String(notional) });
}
export default async function handler() {
  const mode = env("DARWIN_TRADING_ENABLED");
  if (mode !== "true" && mode !== "verify") {
    console.log("Darwin Paper executor staged but not activated.");
    return new Response(null, { status: 204 });
  }
  const connection = env("DARWIN_DATABASE_URL");
  if (!connection || !/\/darwin_trading_lab(?:\?|$)/.test(connection)) throw new Error("Wrong Neon database: refuse trading");
  const sql = neon(connection);
  if (mode === "verify") {
    const [account, dbCheck] = await Promise.all([
      broker("/v2/account"),
      sql.query("SELECT COUNT(*)::int AS n FROM strategies WHERE status='paper_trial' AND id IN (23,24)"),
    ]);
    if (account.status !== "ACTIVE" || account.trading_blocked || Number(dbCheck[0]?.n) !== 2) {
      throw new Error("Darwin read-only verification failed");
    }
    console.log("DARWIN_VERIFY_OK: Paper account accessible; Darwin strategies 23 and 24 accessible; orders disabled");
    return new Response(null, { status: 204 });
  }
  const now = new Date();
  const tick = isoMinute(now);
  const claimed = await sql.query(
    "INSERT INTO darwin_engine_ticks(minute_utc,status) VALUES($1::timestamptz,'started') ON CONFLICT DO NOTHING RETURNING minute_utc",
    [tick]
  );
  if (!claimed.length) return new Response(null, { status: 204 });
  try {
    const outcome = await run(sql, now);
    const executed = outcome.status === "filled" ? 1 : 0;
    await sql.query(
      "UPDATE darwin_engine_ticks SET status='completed',note=$2,orders_filled=$3,completed_at=now() WHERE minute_utc=$1::timestamptz",
      [tick, JSON.stringify(outcome).slice(0, 1000), executed]
    );
    console.log("Darwin cycle", tick, JSON.stringify(outcome));
    return new Response(null, { status: 204 });
  } catch (error) {
    await sql.query(
      "UPDATE darwin_engine_ticks SET status='error',note=$2,completed_at=now() WHERE minute_utc=$1::timestamptz",
      [tick, String(error.message || error).slice(0, 1000)]
    );
    console.error("Darwin cycle failed:", String(error.message || error).slice(0, 500));
    throw error;
  }
}
