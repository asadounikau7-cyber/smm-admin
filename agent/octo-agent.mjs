#!/usr/bin/env node
/**
 * Octo agent: runs on the computer where Octo Browser is open (variant A).
 * It polls the admin over HTTPS (no open ports needed) and relays commands to Octo's Local API.
 *
 * Requirements: Node.js 22+ (built-in fetch and WebSocket), Octo Browser running.
 * Config: agent/config.json next to this file, or env vars ADMIN_URL, AGENT_TOKEN, OCTO_API_TOKEN.
 *
 * On the Starter plan Octo has no API: the agent still reports that Octo is running,
 * and profile commands fail with a clear message. On Base+ everything works.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";
const here = path.dirname(fileURLToPath(import.meta.url));
const cfgFile = path.join(here, "config.json");
const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : {};
const ADMIN_URL = (process.env.ADMIN_URL ?? cfg.adminUrl ?? "").replace(/\/$/, "");
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? cfg.agentToken ?? "";
const OCTO_API_TOKEN = process.env.OCTO_API_TOKEN ?? cfg.octoApiToken ?? "";
const OCTO_DIR = process.env.OCTO_DIR ?? cfg.octoDir ?? path.join(homedir(), ".Octo Browser");
const POLL_MS = 5000;

if (!ADMIN_URL || !AGENT_TOKEN) {
  console.error("Укажите adminUrl и agentToken в agent/config.json (см. config.example.json)");
  process.exit(1);
}

function octoPort() {
  // Octo writes its Local API port to ~/.Octo Browser/local_port; 58888 is the usual default.
  try {
    return Number(readFileSync(path.join(OCTO_DIR, "local_port"), "utf8").trim()) || 58888;
  } catch {
    return 58888;
  }
}

async function octo(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${octoPort()}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(130_000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`Octo ${p}: HTTP ${res.status} ${typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function octoStatus() {
  const st = { reachable: false, apiAvailable: false, username: null };
  let running = null;
  try {
    const u = await octo("GET", "/api/username");
    st.reachable = true;
    st.username = typeof u === "object" ? u.username ?? null : null;
  } catch {
    return { st, running };
  }
  try {
    const active = await octo("GET", "/api/profiles/active");
    st.apiAvailable = true;
    const list = Array.isArray(active) ? active : active?.data ?? [];
    running = list.map((p) => p.uuid).filter(Boolean);
  } catch {
    /* Starter plan or older client: no profile API */
  }
  return { st, running };
}

/** Opens a tab in the started profile through the Chrome DevTools Protocol. */
async function openTab(wsEndpoint, url) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsEndpoint);
    const t = setTimeout(() => { ws.close(); reject(new Error("CDP timeout")); }, 15_000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url } }));
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === 1) { clearTimeout(t); ws.close(); msg.error ? reject(new Error(msg.error.message)) : resolve(); }
    };
    ws.onerror = () => { clearTimeout(t); reject(new Error("CDP connection failed")); };
  });
}

async function run(cmd) {
  switch (cmd.type) {
    case "START_PROFILE": {
      if (!cmd.octoUuid) throw new Error("У профиля нет UUID");
      const r = await octo("POST", "/api/profiles/start", { uuid: cmd.octoUuid, headless: false, debug_port: true, timeout: 120 });
      if (cmd.url && r?.ws_endpoint) await openTab(r.ws_endpoint, cmd.url).catch((e) => console.warn("open tab:", e.message));
      return { started: true };
    }
    case "STOP_PROFILE":
      if (!cmd.octoUuid) throw new Error("У профиля нет UUID");
      await octo("POST", "/api/profiles/stop", { uuid: cmd.octoUuid });
      return { stopped: true };
    case "LIST_PROFILES": {
      if (!OCTO_API_TOKEN) throw new Error("Для загрузки списка нужен octoApiToken (тариф Base+)");
      const profiles = [];
      for (let page = 0; page < 20; page++) {
        const res = await fetch(`https://app.octobrowser.net/api/v2/automation/profiles?page_len=100&page=${page}&fields=title`, {
          headers: { "X-Octo-Api-Token": OCTO_API_TOKEN },
        });
        if (!res.ok) throw new Error(`Octo Cloud API: HTTP ${res.status}`);
        const j = await res.json();
        const items = j.data ?? [];
        profiles.push(...items.map((p) => ({ uuid: p.uuid, title: p.title })));
        if (items.length < 100) break;
      }
      return { profiles };
    }
    default:
      throw new Error(`Неизвестная команда ${cmd.type}`);
  }
}

async function admin(p, body) {
  const res = await fetch(`${ADMIN_URL}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${AGENT_TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Админка ${p}: HTTP ${res.status}`);
  return res.json();
}

async function tick() {
  const { st, running } = await octoStatus();
  const { commands } = await admin("/api/agent/poll", { hostname: hostname(), version: VERSION, octo: st, running });
  for (const cmd of commands) {
    console.log(new Date().toLocaleTimeString(), cmd.type, cmd.title ?? "");
    try {
      if (!st.reachable) throw new Error("Octo Browser не запущен на этом компьютере");
      if (!st.apiAvailable && cmd.type !== "LIST_PROFILES") throw new Error("API Octo недоступен: нужен тариф Base или выше");
      const result = await run(cmd);
      await admin("/api/agent/result", { id: cmd.id, ok: true, result });
    } catch (e) {
      console.warn("  ошибка:", e.message);
      await admin("/api/agent/result", { id: cmd.id, ok: false, error: e.message }).catch(() => {});
    }
  }
}

console.log(`Octo agent ${VERSION} → ${ADMIN_URL}`);
let warned = false;
for (;;) {
  try {
    await tick();
    warned = false;
  } catch (e) {
    if (!warned) console.warn("Нет связи:", e.message);
    warned = true;
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
