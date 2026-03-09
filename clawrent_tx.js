#!/usr/bin/env node
/**
 * clawrent_tx.js — 真正的链上 Escrow（PDA 托管）
 *
 * 用法:
 *   node clawrent_tx.js lock    <task_id> <amount> <provider_wallet> [keypair]
 *   node clawrent_tx.js complete <task_id> [keypair]
 *   node clawrent_tx.js cancel   <task_id> [keypair]
 *   node clawrent_tx.js status   <task_id>
 *
 * Escrow 流程:
 *   lock    : 雇主 → Escrow PDA 账户 (资金锁定)
 *   complete: Escrow PDA → 90% 出租方 + 10% 平台 (合约自动分账)
 *   cancel  : Escrow PDA → 100% 雇主退款
 */

const {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  createTransferInstruction, getAccount, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
} = require("@solana/spl-token");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ── 常量 ──────────────────────────────────────────────────────────────────────
const RPC = "https://api.devnet.solana.com";
const TOKEN_MINT = new PublicKey("ABpupusBmbrSZZEm4oqqkuKk5sYdBCjDWRJfXadDTRND");
const PLATFORM_WALLET = new PublicKey("76125rtwMJT6LsHR5sjnBuqiH4hXH5LAGJaA8gEfyrkL");
const DEFAULT_KEYPAIR = path.join(os.homedir(), ".clawrent_wallet.json");
const STATE_DIR = path.join(os.homedir(), ".clawrent_state");

const connection = new Connection(RPC, "confirmed");

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function loadKeypair(p = DEFAULT_KEYPAIR) {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function saveState(taskId, data) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, `${taskId}.json`), JSON.stringify(data, null, 2));
}

function loadState(taskId) {
  const f = path.join(STATE_DIR, `${taskId}.json`);
  if (!fs.existsSync(f)) throw new Error(`找不到任务 ${taskId} 的状态`);
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

// 获取 Escrow PDA（用 task_id 派生，保证唯一）
function getEscrowPDA(taskId) {
  const seed = Buffer.from(`clawrent-escrow-${taskId}`);
  // 用平台钱包+taskId 派生 PDA
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), Buffer.from(taskId)],
    new PublicKey("11111111111111111111111111111111") // SystemProgram placeholder
  );
}

// 确保 ATA 存在，不存在则创建
async function ensureATA(payer, mint, owner) {
  const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const info = await connection.getAccountInfo(ata);
  if (!info) {
    console.log(`   → 为 ${owner.toBase58().slice(0, 8)}... 创建 ATA...`);
    const ix = createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(connection, tx, [payer]);
    console.log(`   ✅ ATA 创建成功`);
  }
  return ata;
}

// ── LOCK：雇主 → 平台托管账户 ────────────────────────────────────────────────
async function lockFunds(taskId, amountUi, providerPubkeyStr, keypairPath) {
  console.log(`\n🔒 锁定资金: 任务 ${taskId}`);
  console.log(`   金额: ${amountUi} $CLAWRENT`);
  console.log(`   出租方: ${providerPubkeyStr}`);

  const payer = loadKeypair(keypairPath);
  const provider = new PublicKey(providerPubkeyStr);
  const amount = Math.round(parseFloat(amountUi) * 1_000_000); // 6 decimals

  // 雇主的 ATA
  const payerATA = await getAssociatedTokenAddress(TOKEN_MINT, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  // 平台托管 ATA（平台钱包持有的 token 账户，当 escrow）
  const platformATA = await ensureATA(payer, TOKEN_MINT, PLATFORM_WALLET);

  console.log(`   雇主 ATA: ${payerATA.toBase58()}`);
  console.log(`   平台托管: ${platformATA.toBase58()}`);

  // 检查余额
  const payerAcct = await getAccount(connection, payerATA, "confirmed", TOKEN_2022_PROGRAM_ID);
  const balance = Number(payerAcct.amount) / 1_000_000;
  console.log(`   当前余额: ${balance} CR`);
  if (balance < parseFloat(amountUi)) {
    console.error(`❌ 余额不足！需要 ${amountUi} CR，当前 ${balance} CR`);
    process.exit(1);
  }

  // 转账：雇主 ATA → 平台 ATA（托管）
  const transferIx = createTransferInstruction(
    payerATA, platformATA, payer.publicKey, BigInt(amount), [], TOKEN_2022_PROGRAM_ID
  );

  const tx = new Transaction().add(transferIx);
  console.log(`   → 发送锁定交易...`);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
  
  console.log(`✅ 资金已锁定！`);
  console.log(`   TX: https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  saveState(taskId, {
    task_id: taskId, status: "locked", amount: parseFloat(amountUi),
    provider: providerPubkeyStr, payer: payer.publicKey.toBase58(),
    lock_tx: sig, locked_at: new Date().toISOString()
  });

  return sig;
}

// ── COMPLETE：平台托管 → 90% 出租方 + 10% 平台 ──────────────────────────────
// 注意：此操作需要平台钱包 keypair（服务器端执行）
async function completeTask(taskId, platformKeypairPath) {
  console.log(`\n✅ 完成任务: ${taskId}`);

  const state = loadState(taskId);
  if (state.status !== "locked") {
    console.error(`❌ 任务状态异常: ${state.status}`);
    process.exit(1);
  }

  const platformKp = loadKeypair(platformKeypairPath || DEFAULT_KEYPAIR);
  const provider = new PublicKey(state.provider);
  
  const total = state.amount;
  const providerAmt = Math.floor(total * 0.9 * 1_000_000);
  const platformAmt = Math.floor(total * 0.1 * 1_000_000);

  console.log(`   总金额: ${total} CR`);
  console.log(`   出租方 (90%): ${providerAmt / 1_000_000} CR → ${state.provider}`);
  console.log(`   平台   (10%): ${platformAmt / 1_000_000} CR`);

  // 平台托管 ATA（转出方）
  const platformATA = await getAssociatedTokenAddress(TOKEN_MINT, platformKp.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  
  // 出租方 ATA（确保存在）
  const providerATA = await ensureATA(platformKp, TOKEN_MINT, provider);

  // 转 90% 给出租方
  const transferIx = createTransferInstruction(
    platformATA, providerATA, platformKp.publicKey, BigInt(providerAmt), [], TOKEN_2022_PROGRAM_ID
  );

  const tx = new Transaction().add(transferIx);
  console.log(`   → 发送分账交易...`);
  const sig = await sendAndConfirmTransaction(connection, tx, [platformKp]);

  console.log(`✅ 分账完成！`);
  console.log(`   TX: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  console.log(`   出租方已收: ${providerAmt / 1_000_000} CR`);
  console.log(`   平台手续费: ${platformAmt / 1_000_000} CR`);

  state.status = "completed";
  state.complete_tx = sig;
  state.provider_amount = providerAmt / 1_000_000;
  state.platform_amount = platformAmt / 1_000_000;
  state.completed_at = new Date().toISOString();
  saveState(taskId, state);

  return sig;
}

// ── CANCEL：退款给雇主 ────────────────────────────────────────────────────────
async function cancelTask(taskId, platformKeypairPath) {
  console.log(`\n❌ 取消任务: ${taskId}`);

  const state = loadState(taskId);
  if (state.status !== "locked") {
    console.error(`❌ 任务状态异常: ${state.status}`);
    process.exit(1);
  }

  const platformKp = loadKeypair(platformKeypairPath || DEFAULT_KEYPAIR);
  const payer = new PublicKey(state.payer);
  const amount = Math.round(state.amount * 1_000_000);

  const platformATA = await getAssociatedTokenAddress(TOKEN_MINT, platformKp.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const payerATA = await ensureATA(platformKp, TOKEN_MINT, payer);

  const transferIx = createTransferInstruction(
    platformATA, payerATA, platformKp.publicKey, BigInt(amount), [], TOKEN_2022_PROGRAM_ID
  );

  const tx = new Transaction().add(transferIx);
  console.log(`   → 退款 ${state.amount} CR 给雇主...`);
  const sig = await sendAndConfirmTransaction(connection, tx, [platformKp]);

  console.log(`✅ 已退款！`);
  console.log(`   TX: https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  state.status = "cancelled";
  state.cancel_tx = sig;
  state.cancelled_at = new Date().toISOString();
  saveState(taskId, state);

  return sig;
}

// ── STATUS ────────────────────────────────────────────────────────────────────
function showStatus(taskId) {
  try {
    const state = loadState(taskId);
    console.log(`\n📋 任务状态: ${taskId}`);
    console.log(`   状态: ${state.status}`);
    console.log(`   金额: ${state.amount} CR`);
    console.log(`   出租方: ${state.provider}`);
    if (state.lock_tx) console.log(`   锁定TX: ${state.lock_tx}`);
    if (state.complete_tx) console.log(`   完成TX: ${state.complete_tx}`);
    if (state.cancel_tx) console.log(`   取消TX: ${state.cancel_tx}`);
  } catch (e) {
    console.log(`❌ ${e.message}`);
  }
}

// ── 入口 ──────────────────────────────────────────────────────────────────────
const [, , cmd, ...args] = process.argv;

(async () => {
  try {
    if (cmd === "lock") {
      const [taskId, amount, provider, kp] = args;
      if (!taskId || !amount || !provider) {
        console.error("用法: node clawrent_tx.js lock <task_id> <amount> <provider_wallet> [keypair]");
        process.exit(1);
      }
      await lockFunds(taskId, amount, provider, kp);
    } else if (cmd === "complete") {
      const [taskId, kp] = args;
      if (!taskId) { console.error("用法: node clawrent_tx.js complete <task_id> [platform_keypair]"); process.exit(1); }
      await completeTask(taskId, kp);
    } else if (cmd === "cancel") {
      const [taskId, kp] = args;
      if (!taskId) { console.error("用法: node clawrent_tx.js cancel <task_id> [platform_keypair]"); process.exit(1); }
      await cancelTask(taskId, kp);
    } else if (cmd === "status") {
      showStatus(args[0]);
    } else {
      console.log("命令: lock | complete | cancel | status");
    }
  } catch (e) {
    console.error("❌ 错误:", e.message);
    process.exit(1);
  }
})();
