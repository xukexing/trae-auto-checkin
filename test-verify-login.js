"use strict";
/**
 * 临时测试：verifyLoginState 三种场景
 * 1) 真实机器（磁盘有有效登录态）→ 应返回 true，且能拿到真实签到状态
 * 2) 磁盘无任何 Trae 目录（模拟 HOME 指向空目录）→ 应返回 false（快路径，不解密不联网）
 * 3) 磁盘有登录键但内容无效（非法 base64）→ 应返回 false
 * 只做只读查询，绝不调用 claim 接口。
 */
const os = require("os");
const path = require("path");
const fs = require("fs");
const api = require("./trae-api");

let failed = 0;
function assert(cond, name) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failed++;
}

(async () => {
  // 场景 1：真实机器
  const t0 = Date.now();
  const real = await api.verifyLoginState();
  assert(real === true, `场景1 真实有效登录态 → true（耗时 ${Date.now() - t0}ms，含网络）`);

  // 场景 2：空环境（HOME/APPDATA 指向空临时目录）
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-test-"));
  const oldHome = os.homedir;
  const oldAppdata = process.env.APPDATA;
  os.homedir = () => emptyDir;
  process.env.APPDATA = emptyDir;
  // 清除模块缓存，让 candidateOrder 重新求值
  delete require.cache[require.resolve("./trae-api")];
  const apiEmpty = require("./trae-api");
  const t1 = Date.now();
  const none = await apiEmpty.verifyLoginState();
  assert(none === false, `场景2 磁盘无登录态 → false（耗时 ${Date.now() - t1}ms）`);

  // 场景 3：登录键存在但内容非法
  const gsDir = path.join(emptyDir, "Trae CN", "User", "globalStorage");
  fs.mkdirSync(gsDir, { recursive: true });
  fs.writeFileSync(path.join(gsDir, "storage.json"), JSON.stringify({
    "iCubeAuthInfo://icube.cloudide": "!!!not-base64!!!",
  }));
  const t2 = Date.now();
  const bad = await apiEmpty.verifyLoginState();
  assert(bad === false, `场景3 登录键内容无效 → false（耗时 ${Date.now() - t2}ms）`);

  // 恢复环境
  os.homedir = oldHome;
  if (oldAppdata === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppdata;
  fs.rmSync(emptyDir, { recursive: true, force: true });

  console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
})();
