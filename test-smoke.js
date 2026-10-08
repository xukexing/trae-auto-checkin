"use strict";
/**
 * 临时冒烟测试：用 vscode 桩模块驱动 extension.js 的 activate()，
 * 验证登录检测升级后的状态栏行为（不依赖真实 VSCode/Trae 运行时）。
 *
 * 场景 A（未登录）：trae-api.verifyLoginState 返回 false
 *   → 状态栏只应出现「未登录」，绝不应出现「签到中」
 * 场景 B（已登录且今日未签）：verifyLoginState 返回 true，签到接口成功
 *   → 应出现「签到中」并最终「已签到」，且记录 lastSuccessDate
 * 场景 C（已登录但接口失败）：verifyLoginState true，接口抛错
 *   → 应回退「未签到」并安排重试（不弹窗：notify 配置为 false）
 * 场景 D（真实环境端到端）：真实 trae-api + 真实网络（只读状态查询）
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

let failed = 0;
function assert(cond, name) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failed++;
}

/** 构造 vscode 桩 */
function makeVscodeStub() {
  const shown = [];
  const infos = [];
  const warns = [];
  const statusItem = {
    text: "", tooltip: "", busy: false, command: null,
    show() { shown.push("show"); },
    dispose() {},
  };
  const store = new Map();
  const vscode = {
    StatusBarAlignment: { Right: 2 },
    window: {
      createStatusBarItem: () => statusItem,
      showInformationMessage: (...a) => { infos.push(a[0]); return Promise.resolve(undefined); },
      showWarningMessage: (...a) => { warns.push(a[0]); return Promise.resolve(undefined); },
      showErrorMessage: (...a) => { infos.push(a[0]); return Promise.resolve(undefined); },
    },
    commands: {
      _handlers: {},
      registerCommand: (id, fn) => { vscode.commands._handlers[id] = fn; return { dispose() {} }; },
      executeCommand: (id) => vscode.commands._handlers[id] && vscode.commands._handlers[id](),
    },
    workspace: {
      getConfiguration: () => ({
        get: (k, d) => (k === "showNotifications" ? false : d), // 关闭弹窗避免桩阻塞
      }),
    },
    __statusItem: statusItem, __shown: shown, __infos: infos, __warns: warns, __store: store,
  };
  return vscode;
}

/** 全局共享存储（extension.js 通过 global.traeCheckinContext 访问） */
function makeSharedStore() {
  global.__checkinStore = new Map();
  return global.__checkinStore;
}

/** 加载 extension.js，注入桩 vscode 与可控 trae-api */
function loadExtension(stubVscode, traeApi) {
  const Module = require("module");
  const extPath = require.resolve("./extension.js");
  // Node 16 的相对路径解析缓存会绕过 _resolveFilename 钩子（同目录预加载真实模块时），
  // 因此对 ./trae-api 不走钩子，而是直接把桩播种到其真实路径的缓存键上
  const traeApiPath = require.resolve("./trae-api");
  delete require.cache[extPath];
  delete require.cache[traeApiPath];
  if (Module._pathCache) Object.keys(Module._pathCache).forEach((k) => delete Module._pathCache[k]);
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "vscode") return "__stub_vscode__";
    return origResolve.call(this, request, ...rest);
  };
  require.cache["__stub_vscode__"] = { id: "__stub_vscode__", filename: "vscode", loaded: true, exports: stubVscode };
  require.cache[traeApiPath] = { id: traeApiPath, filename: traeApiPath, loaded: true, exports: traeApi };
  const ext = require("./extension.js");
  Module._resolveFilename = origResolve;
  return ext;
}

function makeContext() {
  return {
    globalState: {
      get: (k) => global.__checkinStore.get(k),
      update: (k, v) => { global.__checkinStore.set(k, v); return Promise.resolve(); },
    },
    subscriptions: [],
  };
}

/** 等待直到条件成立或超时 */
async function waitFor(fn, ms = 8000, step = 50) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return fn();
}

const realApi = require("./trae-api");

(async () => {
  // ---------- 场景 A：未登录 ----------
  {
    const stub = makeVscodeStub();
    makeSharedStore();
    const fakeApi = { verifyLoginState: async () => false };
    const ext = loadExtension(stub, fakeApi);
    await ext.activate(makeContext());
    const ok = await waitFor(() => stub.__statusItem.text.includes("未登录"));
    assert(ok, "A1 未登录 → 状态栏显示「未登录」");
    assert(!stub.__statusItem.text.includes("签到中"), "A2 未登录 → 绝不出现「签到中」");
    assert(stub.__warns.length === 0 && stub.__infos.length === 0, "A3 未登录 → 无任何弹窗");
    await ext.deactivate();
  }

  // ---------- 场景 B：已登录 + 签到成功 ----------
  {
    const stub = makeVscodeStub();
    makeSharedStore();
    const fakeApi = {
      verifyLoginState: async () => true,
      createClient: async () => ({}),
      getCheckinStatus: async () => ({ checked_in: false }),
      claimCheckin: async () => ({ gained_credits: 10 }),
      getCreditsBalance: async () => null,
    };
    const ext = loadExtension(stub, fakeApi);
    await ext.activate(makeContext());
    const sawSpin = await waitFor(() => stub.__statusItem.text.includes("签到中"), 3000);
    const done = await waitFor(() => stub.__statusItem.text.includes("已签到"));
    assert(sawSpin, "B1 已登录未签 → 出现「签到中」");
    assert(done, "B2 签到成功 → 最终显示「已签到」");
    assert(global.__checkinStore.get("traeAutoCheckin.lastSuccessDate") != null, "B3 成功后记录 lastSuccessDate");
    await ext.deactivate();
  }

  // ---------- 场景 C：已登录但接口失败 ----------
  {
    const stub = makeVscodeStub();
    makeSharedStore();
    const fakeApi = {
      verifyLoginState: async () => true,
      createClient: async () => ({}),
      getCheckinStatus: async () => { throw new Error("网络错误(模拟)"); },
      claimCheckin: async () => { throw new Error("不应被调用"); },
      getCreditsBalance: async () => null,
    };
    const ext = loadExtension(stub, fakeApi);
    await ext.activate(makeContext());
    const fallback = await waitFor(() => stub.__statusItem.text.includes("未签到"));
    assert(fallback, "C1 接口失败 → 回退「未签到」");
    assert(stub.__warns.length === 0, "C2 静默模式(notify=false) → 无警告弹窗");
    await ext.deactivate();
  }

  // ---------- 场景 D：真实环境端到端（只读） ----------
  {
    const stub = makeVscodeStub();
    makeSharedStore();
    const ext = loadExtension(stub, realApi);
    await ext.activate(makeContext());
    const finalText = await waitFor(
      () => /已签到|未签到|未登录/.test(stub.__statusItem.text) && !stub.__statusItem.busy,
    ) ? stub.__statusItem.text : "(超时未稳定)";
    console.log(`      [真实环境最终状态栏] ${finalText}`);
    assert(/已签到|未签到|未登录/.test(finalText), "D1 真实环境 → 状态栏收敛到三种合法终态之一");
    assert(!finalText.includes("签到中"), "D2 真实环境 → 不停留在「签到中」");
    await ext.deactivate();
  }

  console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error("测试框架异常:", e); process.exit(1); });
