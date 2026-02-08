import fs from "node:fs/promises";
import path from "node:path";

const CONFIG_PATH = path.resolve("config/btc-targets.json");
const STATE_PATH  = path.resolve("state/btc-alert-state.json");

const PRICE_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot"; // public spot endpoint
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const nowMs = () => Date.now();
const isoNow = () => new Date().toISOString();

async function setOutput(name, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  const d = `__D_${Math.random().toString(16).slice(2)}__`;
  await fs.appendFile(out, `${name}<<${d}\n${value}\n${d}\n`);
}

const num = (x, name) => {
  const n = Number(x);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${name}: ${x}`);
  return n;
};

async function loadJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); }
  catch { return fallback; }
}

async function fetchBtcUsd() {
  const res = await fetch(PRICE_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Price fetch failed: ${res.status} ${res.statusText}`);
  const j = await res.json();
  return num(j?.data?.amount, "BTC spot price USD");
}

function evaluateTarget({ price, threshold, buffer, prev, tNow }) {
  // prev: { armed: boolean, lastAlertAtMs: number|null, lastState: "above"|"below" }
  const armed = prev.armed ?? true;
  const lastAlertAtMs = prev.lastAlertAtMs ?? null;

  const rearmAbove = threshold + buffer;

  // Hysteresis re-arm: only rearm once price >= threshold + buffer
  if (price >= rearmAbove) {
    return { alert: false, next: { armed: true, lastState: "above", lastAlertAtMs } };
  }

  // In the "grey zone" between threshold and threshold+buffer:
  // keep previous armed state (prevents flapping)
  if (price >= threshold && price < rearmAbove) {
    return { alert: false, next: { armed, lastState: "above", lastAlertAtMs } };
  }

  // price < threshold => below
  const within24h = lastAlertAtMs !== null && (tNow - lastAlertAtMs) < ONE_DAY_MS;

  if (armed && !within24h) {
    return {
      alert: true,
      next: { armed: false, lastState: "below", lastAlertAtMs: tNow }
    };
  }

  return { alert: false, next: { armed: false, lastState: "below", lastAlertAtMs } };
}

(async () => {
  const config = await loadJson(CONFIG_PATH, null);
  if (!config?.targets?.length) throw new Error("config/btc-targets.json must define targets[]");

  const state = await loadJson(STATE_PATH, { version: 1, targets: {} });
  state.targets ??= {};

  const price = await fetchBtcUsd();
  const tNow = nowMs();

  const breached = [];
  for (const t of config.targets) {
    const id = t.id;
    const label = t.label ?? id;
    const threshold = num(t.threshold, `threshold for ${id}`);
    const buffer = num(t.buffer ?? 0, `buffer for ${id}`);

    const prev = state.targets[id] ?? {};
    const { alert, next } = evaluateTarget({ price, threshold, buffer, prev, tNow });
    state.targets[id] = next;

    if (alert) breached.push({ id, label, threshold, buffer });
  }

  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");

  if (!breached.length) {
    await setOutput("alert_needed", "false");
    console.log(`[${isoNow()}] BTC=${price} no alerts.`);
    return;
  }

  const subject = `🚨 BTC alert (${price.toFixed(2)} USD): ${breached.map(b => b.label).join(", ")}`;
  const body = [
    `BTC spot (USD): ${price.toFixed(2)}`,
    ``,
    `Triggered targets:`,
    ...breached.map(b => `- ${b.label}: below ${b.threshold} (re-arm at ${b.threshold + b.buffer})`),
    ``,
    `Run: https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    `Time (UTC): ${isoNow()}`
  ].join("\n");

  await setOutput("alert_needed", "true");
  await setOutput("alert_subject", subject);
  await setOutput("alert_body", body);

  console.log(body);
})().catch(e => { console.error(e); process.exit(1); });