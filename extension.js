"use strict";
const vscode = require("vscode");
const api = require("./trae-api");

const STATE_KEY_LAST = "traeAutoCheckin.lastSuccessDate"; // 最近一次签到成功的日期（yyyy-MM-dd）
const STATE_KEY_REMIND = "traeAutoCheckin.remindDate";    // 已提醒过签到的日期（避免重复打扰）

let statusItem = null;
let timer = null;

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function getConfig() {
  const c = vscode.workspace.getConfiguration("traeAutoCheckin");
  return {
    enabled: c.get("enabled", true),
    notify: c.get("showNotifications", true),
    retryMinutes: Math.max(1, Number(c.get("retryMinutes", 30)) || 30),
  };
}

function updateStatusBar(text, tooltip, busy) {
  if (!statusItem) {
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.command = "traeAutoCheckin.checkin";
    statusItem.show();
  }
  statusItem.text = text;
  statusItem.tooltip = tooltip;
  statusItem.busy = !!busy;
}

function setIdleBar(checkedIn) {
  updateStatusBar(checkedIn ? "$(check) 已签到" : "$(circle-slash) 未签到",
    checkedIn ? "Trae 今日已签到\n点击可再次尝试" : "Trae 今日尚未签到\n点击立即签到", false);
}

/**
 * 执行签到主流程
 * @returns {{ ok: boolean, already: boolean, gained?: number, message: string }}
 */
async function doCheckin() {
  const client = await api.createClient();
  const status = await api.getCheckinStatus(client);
  if (status.checked_in) {
    return { ok: true, already: true, message: "今日已签到，无需重复领取" };
  }
  const claim = await api.claimCheckin(client);
  const gained = claim.gained_credits ?? claim.credits_gained ?? claim.reward ?? claim.credits;
  return {
    ok: true,
    already: false,
    gained: typeof gained === "number" ? gained : undefined,
    message: `签到成功${gained != null ? `，领取 ${gained} 积分` : ""}`,
  };
}

/** 带状态栏与通知的完整签到流程 */
async function runCheckin({ manual } = {}) {
  const cfg = getConfig();
  const ctx = global.traeCheckinContext;
  updateStatusBar("$(sync~spin) 签到中...", "Trae 正在签到...", true);
  try {
    const result = await doCheckin();
    if (result.ok && !result.already) {
      await ctx.globalState.update(STATE_KEY_LAST, todayStr());
    }
    setIdleBar(true);
    if (cfg.notify) {
      if (result.already) {
        if (manual) vscode.window.showInformationMessage(`Trae 签到：${result.message}`);
      } else {
        vscode.window.showInformationMessage(`Trae 签到：${result.message}`);
      }
    }
    return result;
  } catch (e) {
    setIdleBar(false);
    if (cfg.notify) {
      const act = "重试签到";
      const choice = await vscode.window.showWarningMessage(`Trae 签到失败：${e.message}`, act);
      if (choice === act) runCheckin({ manual: true });
    }
    scheduleRetry();
    return { ok: false, message: e.message };
  }
}

/** 失败后定时重试（可配置间隔），成功或当天已签则不再排程 */
function scheduleRetry() {
  if (timer) return;
  const cfg = getConfig();
  timer = setTimeout(() => {
    timer = null;
    autoCheckin(true);
  }, cfg.retryMinutes * 60 * 1000);
}

/** 未登录时的状态栏文案 */
function setNotLoggedInBar() {
  updateStatusBar("$(circle-slash) 未登录",
    "Trae 未检测到本机登录态\n登录 Trae 后将自动签到\n点击立即重试", false);
}

async function autoCheckin(isRetry) {
  const cfg = getConfig();
  if (!cfg.enabled) return;
  // 深度验证登录态：磁盘有残留登录键但令牌已被服务端拒绝时，视为未登录
  // （不显示"签到中"、不弹窗、不排重试；每小时的状态检查会在登录恢复后自动补签）
  const loggedIn = await api.verifyLoginState();
  if (!loggedIn) {
    setNotLoggedInBar();
    return;
  }
  const ctx = global.traeCheckinContext;
  const last = ctx.globalState.get(STATE_KEY_LAST);
  if (last === todayStr()) {
    setIdleBar(true);
    return;
  }
  if (isRetry || cfg.notify) {
    // 未签到时先在状态栏展示"未签到"，静默执行
    setIdleBar(false);
  }
  await runCheckin({ manual: false });
}

function activate(context) {
  global.traeCheckinContext = context;

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "traeAutoCheckin.checkin";
  setIdleBar(false);
  statusItem.show();

  context.subscriptions.push(
    vscode.commands.registerCommand("traeAutoCheckin.checkin", () => runCheckin({ manual: true })),
    vscode.commands.registerCommand("traeAutoCheckin.showBalance", async () => {
      try {
        const client = await api.createClient();
        const status = await api.getCheckinStatus(client);
        const balance = await api.getCreditsBalance(client);
        let msg = `今日已签到：${status.checked_in ? "是" : "否"}`;
        if (status.credits != null) msg += `\n明日可领：${status.credits}${status.extra_credits != null ? ` + 额外 ${status.extra_credits}` : ""}`;
        if (balance) {
          const total = balance.total_credits ?? balance.credits ?? balance.total;
          const remain = balance.remaining_credits ?? balance.remaining;
          if (total != null) msg += `\n积分总量：${total}`;
          if (remain != null) msg += `\n剩余积分：${remain}`;
        }
        vscode.window.showInformationMessage(`Trae 积分信息：\n${msg}`, { modal: true });
      } catch (e) {
        vscode.window.showErrorMessage(`查询积分失败：${e.message}`);
      }
    }),
    statusItem,
  );

  // 启动即自动签到（每天一次）
  autoCheckin(false);

  // 跨天定时检查：每小时核对一次日期，跨天后自动补签（如编辑器一直开着）
  setInterval(() => autoCheckin(false), 60 * 60 * 1000);
}

function deactivate() {
  if (timer) clearTimeout(timer);
  if (statusItem) statusItem.dispose();
}

module.exports = { activate, deactivate };
