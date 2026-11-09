// v52：B 站私信发送 + 入站「收到后先回一句」（ack）的配置与日志 —— 唯一真源
//
// 为什么单独抽出来：sender.mjs 与 panel_server 都要发私信，以前各写一遍表单字段，
// 一旦接口字段变了就只改一处。这里只做三件小事：
//   ① sendDmText(toUid, text)：真的发一条私信（web_im/send_msg），返回 B 站原始 {code,message}
//   ② readInboundAck()：读 config/pacing.json 的 inbound.ack（面板「收到后先回一句」，默认 false）
//   ③ writeAckLog(o)：把每次回执尝试追加到 logs/inbound-ack.log（成不成功都记，方便排查）
// 凭证与 UA 一律复用 lib/bili.mjs（cookie()/headers()），不再自己拼 Cookie。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './paths.mjs';
import { cookie, headers } from './bili.mjs';

export const DM_ENDPOINT = 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg';
/** B 站 web 端固定 dev_id（接口要求，非机密） */
export const DM_DEV_ID = 'A1B2C3D4-E5F6-1234-5678-ABCDEF123456';
const TIMEOUT_MS = 20000;

/**
 * 发一条纯文本私信。
 * @param {string|number} toUid 接收者 uid
 * @param {string} text 文本
 * @returns {Promise<{code:number|null, message:string}>} B 站返回码（code=0 才算发出）
 */
export async function sendDmText(toUid, text) {
  const c = cookie();
  const senderUid = String(c.dede_user_id || c.mid || '');
  if (!c.sessdata || !c.bili_jct) throw new Error('缺 cookie（sessdata/bili_jct）');
  if (!senderUid) throw new Error('缺 dede_user_id/mid');
  const form = new URLSearchParams({
    'msg[sender_uid]': senderUid,
    'msg[receiver_id]': String(toUid),
    'msg[receiver_type]': '1',
    'msg[msg_type]': '1',
    'msg[dev_id]': DM_DEV_ID,
    'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
    'msg[content]': JSON.stringify({ content: String(text == null ? '' : text) }),
    csrf: String(c.bili_jct),
  });
  const r = await fetch(DM_ENDPOINT, {
    method: 'POST',
    headers: { ...headers(c), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const txt = await r.text();
  if (txt.trim().startsWith('<')) throw new Error('被风控（HTML）');
  let j;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('返回非 JSON：' + txt.slice(0, 120)); }
  return { code: j && j.code != null ? Number(j.code) : null, message: String((j && j.message) || '') };
}

/** 面板「入站与投递」页的「收到后先回一句」——以前全仓没有消费点（假开关），现在由面板与插件 tick 共同消费。 */
export function readInboundAck() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'config', 'pacing.json'), 'utf8'));
    const v = p && p.inbound ? p.inbound.ack : false;
    return v === true || v === 'true';
  } catch (e) { return false; }
}

/** 回执尝试日志（一行一条 JSON）：成功失败都记，失败不写去重表（下一拍还能重试）。 */
export function writeAckLog(o) {
  try {
    const file = path.join(DATA_ROOT, 'logs', 'inbound-ack.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      ...(o && typeof o === 'object' ? o : {}),
    }) + '\n');
  } catch (e) { /* 日志失败不影响主流程 */ }
}
