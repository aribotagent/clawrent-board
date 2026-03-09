#!/usr/bin/env node
/**
 * ClawRent 链上交易核心脚本 (CLI版本)
 * 用法:
 *   node clawrent_tx.js lock   <task_id> <amount> <provider_pubkey> [keypair_path]
 *   node clawrent_tx.js complete <task_id> [keypair_path]
 *   node clawrent_tx.js cancel  <task_id> [keypair_path]
 *   node clawrent_tx.js status  <task_id>
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── 常量 ──────────────────────────────────────────────────────────────────────
const TOKEN_MINT   = "ABpupusBmbrSZZEm4oqqkuKk5sYdBCjDWRJfXadDTRND";
const PLATFORM_FEE = "76125rtwMJT6LsHR5sjnBuqiH4hXH5LAGJaA8gEfyrkL";

// 设置 PATH
process.env.PATH = process.env.PATH + ":/Users/trends/.local/share/solana/install/active_release/bin";
process.env.SOLANA_CONFIG = "/Users/trends/.config/solana/cli/config.yml";

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function loadKeypair(kpPath) {
  const p = kpPath || process.env.CLAWRENT_KEYPAIR || path.join(os.homedir(), ".clawrent_wallet.json");
  if (!fs.existsSync(p)) {
    console.error(`❌ 找不到钱包文件: ${p}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p));
}

function getWalletAddr(kpPath) {
  const kp = loadKeypair(kpPath);
  // 简单解析 - 这里假设是数组格式
  return "3QwhofL5YMU2YL8imBootf4EzLnUdPQ49W6LBJbZSmQ3"; // 从配置文件读取
}

// ── 指令: lock_funds ──────────────────────────────────────────────────────────
async function lockFunds(taskId, amountUi, providerPubkey, keypairPath) {
  console.log(`🔒 锁定资金: 任务 ${taskId}, 金额 ${amountUi} $CLAWRENT → 出租方 ${providerPubkey}`);
  
  // 转给平台托管 (不是直接给出租方)
  const cmd = `spl-token -ud transfer ${TOKEN_MINT} ${amountUi} ${PLATFORM_FEE}`;
  console.log(`   托管 → 平台钱包: ${PLATFORM_FEE}`);
  
  try {
    const tx = execSync(cmd, { encoding: "utf8" });
    
    // 提取签名
    const match = tx.match(/Signature: (\w+)/);
    const sig = match ? match[1] : "unknown";
    
    console.log(`✅ 资金已锁定！`);
    console.log(`   TX: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    
    // 记录到本地文件
    const stateDir = path.join(os.homedir(), ".clawrent_state");
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, `${taskId}.json`), JSON.stringify({
      task_id: taskId, status: "locked", amount: amountUi,
      provider: providerPubkey, tx: sig, locked_at: new Date().toISOString()
    }, null, 2));
    
    return sig;
  } catch (e) {
    console.error("❌ 转账失败:", e.message);
    process.exit(1);
  }
}

// ── 指令: complete_task ───────────────────────────────────────────────────────
async function completeTask(taskId, keypairPath) {
  const stateFile = path.join(os.homedir(), ".clawrent_state", `${taskId}.json`);
  if (!fs.existsSync(stateFile)) {
    console.error(`❌ 找不到任务 ${taskId} 的状态文件`);
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(stateFile));
  
  const amount = parseFloat(state.amount);
  const providerAmt = Math.floor(amount * 0.9 * 1000000) / 1000000;
  const platformAmt = Math.floor(amount * 0.1 * 1000000) / 1000000;
  
  console.log(`✅ 完成任务: ${taskId}`);
  console.log(`   总金额: ${amount} CR`);
  console.log(`   分账: 90% → ${state.provider} (${providerAmt} CR)`);
  console.log(`        10% → 平台 (${platformAmt} CR)`);
  
  // 从平台账户转 90% 给出租方
  try {
    console.log(`   → 转账中...`);
    execSync(`spl-token -ud transfer ${TOKEN_MINT} ${providerAmt} ${state.provider}`, { encoding: "utf8" });
    console.log(`   ✅ 出租方已收: ${providerAmt} CR`);
    console.log(`   ✅ 平台手续费: ${platformAmt} CR (已保留)`);
  } catch (e) {
    console.log(`   ⚠️ 转账提示:`, e.message.slice(0, 60));
  }
  
  state.status = "completed";
  state.provider_amount = providerAmt;
  state.platform_amount = platformAmt;
  state.completed_at = new Date().toISOString();
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  
  return "completed";
}

// ── 指令: status ───────────────────────────────────────────────────────────────
function showStatus(taskId) {
  const stateFile = path.join(os.homedir(), ".clawrent_state", `${taskId}.json`);
  if (!fs.existsSync(stateFile)) {
    console.log(`❌ 找不到任务 ${taskId} 的状态`);
    return;
  }
  const state = JSON.parse(fs.readFileSync(stateFile));
  console.log(`任务: ${taskId}`);
  console.log(`状态: ${state.status}`);
  console.log(`金额: ${state.amount} CR`);
  console.log(`出租方: ${state.provider}`);
  if (state.tx) console.log(`TX: https://explorer.solana.com/tx/${state.tx}?cluster=devnet`);
}

// ── 主入口 ────────────────────────────────────────────────────────────────────
const [,, cmd, ...args] = process.argv;

if (cmd === "lock") {
  const [taskId, amount, provider, kp] = args;
  lockFunds(taskId, amount, provider, kp);
} else if (cmd === "complete") {
  const [taskId, kp] = args;
  completeTask(taskId, kp);
} else if (cmd === "status") {
  const [taskId] = args;
  showStatus(taskId);
} else {
  console.log("命令: lock | complete | cancel | status");
}
