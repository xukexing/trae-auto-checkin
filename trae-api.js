"use strict";
/**
 * Trae 本地账号鉴权 + 签到 API 模块（只读登录态）
 *
 * 原理：
 *  1. 从本机 Trae 客户端的 globalStorage/storage.json 读取加密登录态
 *     （键：iCubeAuthInfo://icube.cloudide）
 *  2. 按 Trae 客户端相同的「tc 格式」解密出 accessToken
 *  3. 调用官方签到接口：查询状态 -> 未签则领取
 *
 * 安全约定：令牌仅在内存中使用，绝不打印、不落盘、不上传。
 * 加密格式逆向自官方客户端，可能随客户端版本变化。
 */
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");

const AUTH_KEY = "iCubeAuthInfo://icube.cloudide";
const API_HOST_FALLBACK = "https://api.trae.cn";

/** 候选客户端目录（含国际版 / SOLO 版），按修改时间新→旧排序后依次尝试 */
function storageCandidates() {
  const home = os.homedir();
  const roots = [
    process.env.APPDATA || path.join(home, "AppData", "Roaming"),
    path.join(home, "Library", "Application Support"),
  ];
  const names = ["Trae CN", "TRAE SOLO CN", "Trae", "TRAE SOLO"];
  const out = [];
  for (const root of roots) {
    for (const n of names) {
      out.push(path.join(root, n, "User", "globalStorage", "storage.json"));
    }
  }
  return out;
}

function candidateOrder() {
  return storageCandidates()
    .filter((p) => fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

// iCube 登录态解密常量（与 Trae 客户端加密格式对应）
const SALT_A = Uint8Array.from([82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37]);
const SALT_B = Uint8Array.from([31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125]);

function xor(a, b, n) {
  const r = new Uint8Array(n);
  for (let i = 0; i < n; i++) r[i] = a[i] ^ b[i];
  return r;
}

/** 解密 tc 格式登录态，返回 { token, refreshToken, userId, host, expiredAt, ... } */
function decryptAuthValue(b64) {
  const buf = Buffer.from(b64, "base64");
  const hd = buf.slice(0, 6);
  const rb = buf.slice(6, 38);
  const enc = buf.slice(38);
  if (!(hd[0] === 0x74 && hd[1] === 0x63 && hd[2] === 0x05 && hd[3] === 0x10 && hd[4] === 0 && hd[5] === 0)) {
    throw new Error("未知的登录态加密格式（header 不匹配）");
  }
  const salt = xor(SALT_A, SALT_B, 64);
  const finalHash = crypto
    .createHash("sha512")
    .update(Buffer.concat([crypto.createHash("sha512").update(rb).digest(), Buffer.from(salt)]))
    .digest();
  const dc = crypto.createDecipheriv("aes-128-cbc", finalHash.slice(0, 16), finalHash.slice(16, 32));
  const plain = Buffer.concat([dc.update(enc), dc.final()]);
  const stored = plain.slice(0, 64);
  const payload = plain.slice(64);
  const computed = crypto.createHash("sha512").update(payload).digest();
  if (!stored.equals(computed)) throw new Error("解密校验失败（SHA-512 不符）");
  return JSON.parse(payload.toString("utf8"));
}

/** 轻量检测本机是否存在 Trae 登录态（只看键是否存在，不校验解密有效性） */
function hasLoginState() {
  for (const p of candidateOrder()) {
    try {
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      if (s[AUTH_KEY]) return true;
    } catch (e) { /* ignore */ }
  }
  return false;
}

/**
 * 深度验证登录态是否真实可用：
 * 磁盘存在登录键且能成功解密，再调签到状态接口确认令牌未被服务端拒绝。
 * 客户端"界面登出"可能残留 storage.json 登录键，只有接口验证才能确认。
 * @returns {Promise<boolean>} true = 令牌真实有效
 */
async function verifyLoginState() {
  if (!hasLoginState()) return false;
  try {
    const client = await createClient();
    await getCheckinStatus(client);
    return true;
  } catch (e) {
    return false;
  }
}

/** 读取本机登录态；国际版为明文 JSON，CN 版为加密串 */
function loadAuth() {
  for (const p of candidateOrder()) {
    try {
      const storage = JSON.parse(fs.readFileSync(p, "utf8"));
      const enc = storage[AUTH_KEY];
      if (!enc) continue;
      if (String(enc).trim().startsWith("{")) return JSON.parse(enc);
      return decryptAuthValue(String(enc));
    } catch (e) {
      // 单个文件读取/解密失败则尝试下一个候选
    }
  }
  throw new Error("未找到 Trae 本地登录态，请先在本机 Trae 客户端登录后再使用本插件。");
}

/** 读取本机稳定的设备标识，避免每次请求随机生成导致指纹漂移 */
function readDeviceIds() {
  const out = {};
  for (const p of candidateOrder()) {
    try {
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      const machineId = s["telemetry.machineId"];
      if (typeof machineId === "string" && machineId) out.machineId = machineId;
      for (const k of Object.keys(s)) {
        const m = /^iCubeAuthInfo:\/\/icube-dc:(\d+)$/.exec(k);
        if (m && m[1]) { out.deviceId = m[1]; break; }
      }
    } catch (e) { /* ignore */ }
    break;
  }
  return out;
}

/** 读取本端已安装客户端的版本号（如 2.3.40353），读不到回退默认值 */
function readClientVersion() {
  for (const p of candidateOrder()) {
    try {
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      const v = s["iCubeLastVersion"];
      if (typeof v === "string" && v.trim()) {
        return { ideVersion: v.trim(), ideVersionCode: v.replace(/\./g, "") };
      }
    } catch (e) { /* ignore */ }
    break;
  }
  return null;
}

function detectOs() {
  const platform = process.platform;
  const release = os.release();
  let deviceType = "unknown";
  let osVersion = platform;
  if (platform === "darwin") { deviceType = "mac"; osVersion = `Darwin ${release}`; }
  else if (platform === "win32") { deviceType = "windows"; osVersion = `Windows ${release}`; }
  else if (platform === "linux") { deviceType = "linux"; osVersion = `Linux ${release}`; }
  return { deviceType, osVersion };
}

/** Node < 18 无全局 fetch 时的 https.post 回退实现 */
function httpsPostJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: { ...headers, "Content-Length": data.length },
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = {};
          try { json = JSON.parse(text); } catch (e) { /* ignore */ }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const httpPost = (url, headers, body) =>
  (typeof fetch === "function" ? fetchJson(url, headers, body) : httpsPostJson(url, headers, body));

async function fetchJson(url, headers, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let json = {};
    try { json = await resp.json(); } catch (e) { /* ignore */ }
    return { status: resp.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function buildHeaders(token, uid, fp = {}) {
  const osInfo = detectOs();
  return {
    "Authorization": `Cloud-IDE-JWT ${token}`,
    "X-Cloudide-Token": token,
    "x-uid": String(uid),
    "x-app-id": "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
    "x-device-id": fp.deviceId || crypto.randomUUID().replace(/-/g, ""),
    "x-machine-id": fp.machineId || crypto.randomBytes(32).toString("hex"),
    "x-request-id": crypto.randomUUID(),
    "x-ide-version": fp.ideVersion || "3.3.67",
    "x-ide-version-code": fp.ideVersionCode || "20260401",
    "x-device-type": osInfo.deviceType,
    "x-os-version": osInfo.osVersion,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

/**
 * 创建带鉴权的 API 客户端
 * 返回 { post(path, body) -> { status, json } }，401 时自动用 refreshToken 换新后重试
 */
async function createClient() {
  const auth = loadAuth();
  const host = auth.host || API_HOST_FALLBACK;
  const uid = String(auth.userId || "");
  const device = readDeviceIds();
  const ver = readClientVersion();
  const fingerprint = {
    deviceId: device.deviceId,
    machineId: device.machineId,
    ideVersion: ver && ver.ideVersion,
    ideVersionCode: ver && ver.ideVersionCode,
  };
  let token = auth.token;
  let refreshing = null;

  async function refresh() {
    if (!auth.refreshToken) return false;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const r = await httpPost(`${host}/cloudide/api/v3/trae/oauth/ExchangeToken`, {
          "Content-Type": "application/json",
        }, {
          ClientID: "ono9krqynydwx5",
          RefreshToken: auth.refreshToken,
          ClientSecret: "-",
          UserID: uid,
        });
        if (r.json && r.json.Result && r.json.Result.Token) { token = r.json.Result.Token; return true; }
        return false;
      } catch (e) {
        return false;
      }
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }

  // 访问令牌临近过期（<30 分钟）则先行刷新
  if (!auth.expiredAt || new Date(auth.expiredAt).getTime() - Date.now() < 30 * 60 * 1000) {
    await refresh();
  }

  return {
    host,
    userId: uid,
    async post(p, body) {
      const doFetch = () => httpPost(`${host}${p}`, buildHeaders(token, uid, fingerprint), body);
      let resp = await doFetch();
      if (resp.status === 401) {
        const ok = await refresh();
        if (ok) resp = await doFetch();
      }
      return { status: resp.status, json: resp.json };
    },
  };
}

/** 查询今日签到状态，返回接口原始 JSON（code=0 时 checked_in 表示是否已签） */
async function getCheckinStatus(client) {
  const r = await client.post("/trae/api/v2/ug/checkin_credits/status", {});
  if (!(r.json && r.json.code === 0)) {
    throw new Error(`查询签到状态失败: ${(r.json && r.json.message) || "HTTP " + r.status}`);
  }
  return r.json;
}

/** 领取今日签到积分，返回接口原始 JSON */
async function claimCheckin(client) {
  const r = await client.post("/trae/api/v2/ug/checkin_credits/claim", {});
  if (!(r.json && r.json.code === 0)) {
    throw new Error(`签到失败: ${(r.json && r.json.message) || "HTTP " + r.status}`);
  }
  return r.json;
}

/** 查询积分余额，返回接口原始 JSON；失败返回 null（不作为主流程依赖） */
async function getCreditsBalance(client) {
  try {
    const r = await client.post("/trae/api/v2/ug/credits/balance", {});
    if (r.json && r.json.code === 0) return r.json;
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = { createClient, getCheckinStatus, claimCheckin, getCreditsBalance, loadAuth, hasLoginState, verifyLoginState };
