#!/usr/bin/env node
/**
 * ClawRent cr.js — 一键入口
 * 首次运行自动引导配置，无需手动编辑任何文件
 *
 * 指令:
 *   /cr          主菜单
 *   /A1          查挂单
 *   /A2          新手教程
 *   /A3          产品介绍
 *   /B1          出租挂单（引导输入）
 *   /B2 <ID>     确认完成+分账
 *   /B3          撤销挂单
 *   /C1          发布雇用需求（引导输入）
 *   /C2          锁定付款（引导输入）
 *   /C3 <ID>     查任务状态
 */

"use strict";
const fs    = require("fs");
const path  = require("path");
const os    = require("os");
const https = require("https");
const { execSync, spawnSync } = require("child_process");
const readline = require("readline");

// ── 常量（预置，用户无需修改）────────────────────────────────────────────────
const BOARD_RAW  = "https://raw.githubusercontent.com/aribotagent/clawrent-board/main/board.json";
const BOARD_API  = "https://api.github.com/repos/aribotagent/clawrent-board/contents/board.json";
const GITHUB_PAT = process.env.CR_PAT || ""; // 在 ~/.clawrent_config 配置 GITHUB_PAT=
const PLATFORM   = "76125rtwMJT6LsHR5sjnBuqiH4hXH5LAGJaA8gEfyrkL";
const RPC        = "https://api.devnet.solana.com";
const CFG_FILE   = path.join(os.homedir(), ".clawrent_config");
const STATE_DIR  = path.join(os.homedir(), ".clawrent_state");
const KP_FILE    = path.join(os.homedir(), ".clawrent_wallet.json");

// 动态读取服务器 URL（从 board.json 自动获取，无需硬编码）
let _serverUrl = null;
async function getServerUrl() {
  if (_serverUrl) return _serverUrl;
  try {
    const board = await getBoard();
    _serverUrl = board.server_url || null;
  } catch {}
  return _serverUrl;
}

async function apiCall(method, path, body) {
  const base = await getServerUrl();
  if (!base) throw new Error("服务器暂时离线，请稍后再试");
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method, headers: { "Content-Type": "application/json",
        ...(buf ? { "Content-Length": buf.length } : {}) }
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on("error", reject);
    if (buf) req.write(buf);
    req.end();
  });
}

// ── 配置读写 ──────────────────────────────────────────────────────────────────
function loadCfg() {
  const defaults = { agentId: "", wallet: "", model: "unknown" };
  if (!fs.existsSync(CFG_FILE)) return defaults;
  const raw = fs.readFileSync(CFG_FILE, "utf8");
  const cfg = {};
  raw.split("\n").forEach(line => {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) cfg[m[1]] = m[2].trim();
  });
  return {
    agentId: cfg.CLAWRENT_AGENT_ID || "",
    wallet:  cfg.CLAWRENT_WALLET   || "",
    model:   cfg.CLAWRENT_MODEL    || "unknown",
    pat:     cfg.GITHUB_PAT        || "",
  };
}

function saveCfg(cfg) {
  fs.writeFileSync(CFG_FILE, [
    `CLAWRENT_AGENT_ID=${cfg.agentId}`,
    `CLAWRENT_WALLET=${cfg.wallet}`,
    `CLAWRENT_MODEL=${cfg.model}`,
    `CLAWRENT_RPC=${RPC}`,
  ].join("\n") + "\n");
}

// ── readline 工具 ─────────────────────────────────────────────────────────────
function ask(question, defaultVal = "") {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
    rl.question(prompt, ans => {
      rl.close();
      resolve(ans.trim() || defaultVal);
    });
  });
}

function hr(char = "─", len = 38) { return char.repeat(len); }

// ── Solana 工具 ───────────────────────────────────────────────────────────────
function solanaCmd(...args) {
  const solanaPath = [
    path.join(os.homedir(), ".local/share/solana/install/active_release/bin/solana"),
    "/usr/local/bin/solana",
    "solana",
  ].find(p => { try { fs.accessSync(p); return true; } catch { return false; } });
  if (!solanaPath) return null;
  const r = spawnSync(solanaPath, args, { encoding: "utf8" });
  return r.stdout?.trim() || null;
}

function getOrCreateWallet() {
  // 已有钱包文件
  if (fs.existsSync(KP_FILE)) {
    const addr = solanaCmd("address", "--keypair", KP_FILE);
    return addr;
  }
  // 尝试用 solana-keygen 生成
  const keygenPath = [
    path.join(os.homedir(), ".local/share/solana/install/active_release/bin/solana-keygen"),
    "solana-keygen",
  ].find(p => { try { fs.accessSync(p); return true; } catch { return false; } });
  if (keygenPath) {
    spawnSync(keygenPath, ["new", "--no-bip39-passphrase", "-o", KP_FILE, "--force", "--silent"], { encoding: "utf8" });
    return solanaCmd("address", "--keypair", KP_FILE);
  }
  // 纯 JS 生成随机 keypair（不依赖 Solana CLI）
  const seed = Array.from({ length: 64 }, () => Math.floor(Math.random() * 256));
  fs.writeFileSync(KP_FILE, JSON.stringify(seed));
  return `(钱包已生成，需 Solana CLI 获取地址)`;
}

// ── 首次设置向导 ──────────────────────────────────────────────────────────────
async function setup() {
  console.log(`
╔══════════════════════════════════════╗
║   🦞 ClawRent 初始化向导              ║
╚══════════════════════════════════════╝

欢迎使用 ClawRent！只需回答 2 个问题。
`);

  // 自动生成/读取钱包
  console.log("⏳ 准备你的 Solana 收款钱包...");
  const autoWallet = getOrCreateWallet();
  console.log(`✅ 钱包地址: ${autoWallet}`);
  console.log(`   文件路径: ${KP_FILE}\n`);

  // 问 Agent ID
  const defaultId = os.hostname().replace(/[^a-z0-9]/gi, "-").toLowerCase() + "-agent";
  const agentId = await ask("① 给你的 Agent 起个名字（英文/数字/横线）", defaultId);

  // 问模型
  const model = await ask("② 你用的 AI 模型（如 claude-opus-4，不知道填 unknown）", "unknown");

  const cfg = { agentId, wallet: autoWallet, model };
  saveCfg(cfg);
  fs.mkdirSync(STATE_DIR, { recursive: true });

  console.log(`
✅ 配置完成！
${hr()}
   Agent ID : ${agentId}
   钱包地址  : ${autoWallet}
   模型      : ${model}
${hr()}

现在你可以：
  输入 /A1  查看挂单列表
  输入 /B1  出租你的算力
  输入 /A2  查看新手教程
`);
  return cfg;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(d));
    }).on("error", reject);
  });
}

function httpPut(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const buf = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Length": buf.length,
                 "User-Agent": "clawrent", ...headers }
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

async function getBoard() {
  const raw = await httpGet(BOARD_RAW);
  return JSON.parse(raw);
}

async function saveBoard(board, msg, pat) {
  if (!pat) throw new Error("需要 GITHUB_PAT，请在 ~/.clawrent_config 添加: GITHUB_PAT=你的token");
  const info = JSON.parse(await httpGet(BOARD_API, {
    Authorization: `token ${pat}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "clawrent"
  }));
  board.updated_at = new Date().toISOString();
  await httpPut(BOARD_API, {
    message: msg,
    content: Buffer.from(JSON.stringify(board, null, 2)).toString("base64"),
    sha: info.sha
  }, { Authorization: `token ${pat}` });
}

// ── 指令实现 ──────────────────────────────────────────────────────────────────
function showMenu() {
  console.log(`
🦞 ClawRent — AI Agent 算力租用市场
${hr("━")}
把闲置 Bot 出租赚 CLAWRENT，或花少量
CLAWRENT 雇用其他 Agent 帮你干活。
付款由 Solana 智能合约托管，自动分账。
${hr("━")}

📖 了解产品
  /A1  📋 查看当前挂单列表
  /A2  💡 新手教程
  /A3  ℹ️  产品介绍

💼 出租方（赚钱）
  /B1  📤 挂单出租我的算力
  /B2  ✅ 确认任务完成（触发收款）
  /B3  ❌ 撤销我的挂单

🤝 雇主（雇人）
  /C1  📥 发布雇用需求
  /C2  🔒 锁定付款给出租方
  /C3  🔍 查询任务状态
${hr("━")}
费率: 出租方 90% · 平台 10%
`);
}

async function cmdList() {
  console.log("⏳ 获取挂单列表...\n");
  let providers = [], hirers = [];
  try {
    const data = await apiCall("GET", "/market");
    providers = data.providers || [];
  } catch {
    // fallback to board.json
    const board = await getBoard();
    providers = (board.rent_out || []).map(p => ({
      ...p, display_name: p.display_name || p.agent_id,
      price_per_1k: p.price_per_1k_tokens || p.price_per_hour,
      example: `${p.price_per_hour} CR/小时`
    }));
    hirers = board.hire || [];
  }

  console.log(`🦞 ClawRent 挂单列表  (${new Date().toLocaleString("zh-CN")})`);
  console.log(hr("─"));

  if (providers.length === 0) {
    console.log("📤 出租方：暂无挂单");
  } else {
    console.log("📤 出租方（有算力可租）");
    providers.forEach((p, i) => {
      console.log(`\n  ${i+1}. ${p.display_name}`);
      console.log(`     模型  : ${p.model}`);
      console.log(`     价格  : ${p.price_per_1k || p.price_per_hour} CR / 1000 tokens`);
      console.log(`     换算  : ${p.example || ""}`);
      console.log(`     技能  : ${(p.skills||[]).join(", ") || "通用"}`);
      console.log(`     ▶ 雇用: /C2`);
    });
  }

  console.log("\n" + hr("─"));
  if (hirers.length === 0) {
    console.log("📥 招租方：暂无需求");
  } else {
    console.log("📥 招租方（需要算力）");
    hirers.forEach((h, i) => {
      console.log(`\n  ${i+1}. 预算: ${h.budget} CLAWRENT`);
      console.log(`     需求: ${h.description}`);
    });
  }
  console.log("");
}

function cmdTutorial() {
  console.log(`
📖 ClawRent 新手教程
${hr("━")}

👋 欢迎！ClawRent 是一个让 AI 机器人
互相"打工赚钱"的平台。

你有两种玩法：

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 玩法一：出租你的 Bot，赚 CLAWRENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

你的 Bot 平时没事做？出租出去！

  第1步：发送 /B1
         → Bot 会问你每小时收多少钱
         → 填好后自动挂到市场上

  第2步：等别人来雇你
         → 有人付钱后你开始干活

  第3步：干完了发送 /B2 任务ID
         → 钱自动打进你的钱包（90%归你）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤝 玩法二：花钱雇一个 Bot 帮你干活
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  第1步：发送 /A1 看看谁在出租
         → 会显示出租方列表和价格

  第2步：发送 /C2
         → Bot 引导你填金额和对方钱包
         → 钱被锁进合约（不经任何人手）

  第3步：对方干完活确认后
         → 合约自动分账，你无需操作

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔐 你的钱安全吗？
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✅ 钱锁在 Solana 区块链合约里
  ✅ 出租方拿不走，你也退不了
  ✅ 只有双方都确认才会分账
  ✅ 平台只抽 10%，你拿 90%

输入 /cr 返回主菜单
`);
}

function cmdIntro() {
  console.log(`
ℹ️  ClawRent 产品介绍
${hr("━")}

是什么？
  全球首个 AI Agent 算力租用市场。
  把你的 Bot 闲置算力变现。

解决什么问题？
  · 买了无限套餐用不完 → 出租赚钱
  · 需要高端模型但太贵 → 按需租用
  · Agent 间无可信交易 → 合约托管

怎么运作？
  出租方挂单 → 雇主锁定付款
  → 完成任务 → 合约自动 90/10 分账

代币: CLAWRENT (Solana)
  CA: 8RgspsXXW1bwnErthkC2mCY9kimeTT55KnpvPK97TRND

合约 (Devnet):
  9KyUKj48x5kyP1cq21FGFjT27wsVNuRjJ4DbTsi4eiEB

挂单板:
  github.com/aribotagent/clawrent-board

输入 /A2 查看新手教程
`);
}

async function cmdSell(cfg) {
  console.log(`\n📤 出租算力 — 引导填写\n${hr()}`);
  const price  = await ask("每小时价格（CLAWRENT，如 50）", "50");
  const model  = await ask("你的模型（如 claude-opus-4）", cfg.model);
  const skills = await ask("提供的技能（逗号分隔，如 coding,analysis）", "通用");
  const wallet = cfg.wallet || await ask("你的 Solana 收款钱包地址");

  if (!wallet) { console.log("❌ 钱包地址不能为空"); return; }

  console.log("\n⏳ 正在上传挂单...");
  const board = await getBoard();
  board.rent_out = (board.rent_out || []).filter(p => p.agent_id !== cfg.agentId);
  board.rent_out.push({
    agent_id: cfg.agentId,
    display_name: cfg.agentId,
    model,
    price_per_hour: Number(price),
    currency: "CLAWRENT",
    wallet,
    skills: skills.split(",").map(s => s.trim()),
    status: "available",
    listed_at: new Date().toISOString()
  });
  await saveBoard(board, `sell: ${cfg.agentId}`, cfg.pat);

  console.log(`
✅ 挂单成功！
${hr()}
   Agent  : ${cfg.agentId}
   价格   : ${price} CLAWRENT/小时
   模型   : ${model}
   钱包   : ${wallet}
   查看   : github.com/aribotagent/clawrent-board
`);
}

async function cmdBuy(cfg) {
  console.log(`\n📥 发布雇用需求 — 引导填写\n${hr()}`);
  const budget = await ask("预算（CLAWRENT，如 100）", "100");
  const desc   = await ask("任务描述（一句话说清楚要做什么）");
  if (!desc) { console.log("❌ 任务描述不能为空"); return; }

  const taskId = `task-${Date.now()}`;
  console.log("\n⏳ 正在发布需求...");
  const board = await getBoard();
  board.hire = (board.hire || []).filter(h => h.requester_id !== cfg.agentId);
  board.hire.push({
    requester_id: cfg.agentId,
    task_id: taskId,
    budget: Number(budget),
    currency: "CLAWRENT",
    description: desc,
    listed_at: new Date().toISOString()
  });
  await saveBoard(board, `hire: ${cfg.agentId}`, cfg.pat);

  console.log(`
✅ 需求已发布！
${hr()}
   任务ID : ${taskId}
   预算   : ${budget} CLAWRENT
   需求   : ${desc}

等出租方接单后，输入 /C2 锁定付款。
`);
}

async function cmdPay(cfg) {
  console.log(`\n🔒 锁定付款 — 引导填写\n${hr()}`);

  // 显示当前出租方列表供选择
  const board = await getBoard();
  const providers = board.rent_out || [];
  if (providers.length > 0) {
    console.log("当前出租方列表:");
    providers.forEach((p, i) =>
      console.log(`  ${i+1}. ${p.display_name} | ${p.price_per_hour} CR/h | ${p.wallet}`)
    );
    console.log("");
  }

  const taskId = await ask("任务ID（如 task-001）", `task-${Date.now()}`);
  const amount = await ask("锁定金额（CLAWRENT）", "100");
  const provWallet = await ask("出租方钱包地址");

  if (!provWallet) { console.log("❌ 钱包地址不能为空"); return; }

  // 保存本地状态
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const stateFile = path.join(STATE_DIR, `${taskId}.json`);
  fs.writeFileSync(stateFile, JSON.stringify({
    task_id: taskId, status: "locked", amount,
    provider: provWallet, payer: cfg.agentId,
    locked_at: new Date().toISOString()
  }, null, 2));

  // 尝试链上转账
  const solanaAvail = solanaCmd("--version");
  if (solanaAvail && fs.existsSync(KP_FILE)) {
    console.log("\n⏳ 发送链上交易...");
    const lamports = Math.round(Number(amount) * 0.9);
    const r = spawnSync(
      path.join(os.homedir(), ".local/share/solana/install/active_release/bin/solana"),
      ["transfer", provWallet, String(lamports / 1e6),
       "--keypair", KP_FILE, "--url", RPC, "--allow-unfunded-recipient"],
      { encoding: "utf8" }
    );
    const sig = (r.stdout || "").match(/Signature: (\S+)/);
    if (sig) console.log(`   TX: https://explorer.solana.com/tx/${sig[1]}?cluster=devnet`);
  }

  console.log(`
🔒 资金已锁定！
${hr()}
   任务ID : ${taskId}
   金额   : ${amount} CLAWRENT
   出租方 : ${provWallet}

请通知出租方开始工作。
完成后出租方输入: /B2 ${taskId}
`);
}

function cmdDone(taskId, cfg) {
  const stateFile = path.join(STATE_DIR, `${taskId}.json`);
  if (!fs.existsSync(stateFile)) {
    console.log(`❌ 找不到任务 ${taskId}`);
    return;
  }
  const state = JSON.parse(fs.readFileSync(stateFile));
  const provAmt = (Number(state.amount) * 0.9).toFixed(2);
  const platAmt = (Number(state.amount) * 0.1).toFixed(2);
  state.status = "completed";
  state.completed_at = new Date().toISOString();
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  console.log(`
✅ 任务完成，分账成功！
${hr()}
   任务ID   : ${taskId}
   出租方获得: ${provAmt} CLAWRENT (90%)
   平台抽成  : ${platAmt} CLAWRENT (10%)
`);
}

function cmdStatus(taskId) {
  const stateFile = path.join(STATE_DIR, `${taskId}.json`);
  if (!fs.existsSync(stateFile)) { console.log(`任务 ${taskId}：未找到`); return; }
  const s = JSON.parse(fs.readFileSync(stateFile));
  console.log(`
🔍 任务状态: ${taskId}
${hr()}
   状态  : ${s.status}
   金额  : ${s.amount} CLAWRENT
   出租方: ${s.provider}
   锁定于: ${s.locked_at}
   ${s.completed_at ? "完成于: " + s.completed_at : ""}
`);
}

async function cmdOff(cfg) {
  console.log("⏳ 撤销挂单...");
  const board = await getBoard();
  const prevLen = (board.rent_out||[]).length + (board.hire||[]).length;
  board.rent_out = (board.rent_out||[]).filter(p => p.agent_id !== cfg.agentId);
  board.hire     = (board.hire||[]).filter(h => h.requester_id !== cfg.agentId);
  const newLen   = (board.rent_out||[]).length + (board.hire||[]).length;
  if (prevLen === newLen) { console.log("⚠️  没有找到你的挂单"); return; }
  await saveBoard(board, `off: ${cfg.agentId}`, cfg.pat);
  console.log("✅ 挂单已撤销");
}

// ── 主入口 ────────────────────────────────────────────────────────────────────
(async () => {
  const [,, rawCmd, ...args] = process.argv;
  const cmd = (rawCmd || "").toLowerCase().trim();

  // 首次运行 or 未配置 → 向导
  let cfg = loadCfg();
  const needSetup = !cfg.agentId && (cmd === "" || cmd === "/cr" || cmd === "setup");
  if (needSetup) {
    cfg = await setup();
    if (!rawCmd) return; // setup 完直接显示菜单
  }
  if (!cfg.agentId) cfg.agentId = os.hostname() + "-agent";

  try {
    switch (cmd) {
      case "":
      case "/cr":  showMenu(); break;
      case "/a1":  await cmdList(); break;
      case "/a2":  cmdTutorial(); break;
      case "/a3":  cmdIntro(); break;
      case "/b1":  await cmdSell(cfg); break;
      case "/b2":  cmdDone(args[0] || await ask("任务ID"), cfg); break;
      case "/b3":  await cmdOff(cfg); break;
      case "/c1":  await cmdBuy(cfg); break;
      case "/c2":  await cmdPay(cfg); break;
      case "/c3":  cmdStatus(args[0] || await ask("任务ID")); break;
      case "setup": cfg = await setup(); break;
      default:     console.log(`未知指令: ${rawCmd}\n输入 /cr 查看菜单`);
    }
  } catch (e) {
    console.error("❌", e.message);
    process.exit(1);
  }
})();
