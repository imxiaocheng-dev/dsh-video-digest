// v24 · git 自动快照（契约 G）
//
// 用途：面板大版本 bump 时（例如 'v24'）把工作区当前状态提交成一个快照 commit 并打 tag。
// 调用方（panel_server.mjs 加载阶段，fire-and-forget）：
//   const { snapshotIfVersionChanged } = await import(pathToFileURL(...git-snapshot.mjs));
//   snapshotIfVersionChanged('v24').catch(() => {});
//
// 设计约束（都很重要，别"优化"掉）：
//  1. 绝不抛异常：面板加载阶段调用它，任何 git 问题都只能落日志，不能连累面板。
//  2. DSH 沙箱下 `spawnSync(..., {encoding})` 走管道会 **EPERM**，所以 stdout 一律重定向到临时文件，
//     再用 fs 读回来；stderr 直接 ignore。判定成败只看 exit code。
//  3. 版本没变就立刻返回（同一版本只快照一次），状态在 <DATA>/logs/git-snapshot.json。
//  4. 失败写 <DATA>/logs/git-snapshot.log（一行一个 JSON），不写状态 → 下次加载会重试。
//  5. 只做 add/commit/tag，**绝不** push、reset、clean、checkout，避免动用户工作区。
//
// 环境变量（可选，测试/迁移用）：
//   VD_REPO  指定仓库根（默认从 CODE_ROOT 往上找 .git）
//   VD_GIT   指定 git.exe（默认用 PATH 里的 git，Windows 常见安装位置也会试）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_ROOT, CODE_ROOT } from './paths.mjs';

/** 快照状态：{ version, tag, commit, changed, at, repo } */
export const SNAPSHOT_STATE = path.join(DATA_ROOT, 'logs', 'git-snapshot.json');
/** 失败日志：一行一个 JSON */
export const SNAPSHOT_LOG = path.join(DATA_ROOT, 'logs', 'git-snapshot.log');

const GIT_TIMEOUT_MS = 15000;
const GIT_CANDIDATES = [
  process.env.VD_GIT,
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'git',
].filter(Boolean);

let _gitExe = null;
function gitExe() {
  if (_gitExe) return _gitExe;
  for (const c of GIT_CANDIDATES) {
    try {
      if (c === 'git' || fs.existsSync(c)) { _gitExe = c; return _gitExe; }
    } catch { /* 探测失败继续下一个 */ }
  }
  _gitExe = 'git';
  return _gitExe;
}

/** 仓库根：VD_REPO 优先；否则从代码根往上找 .git（装进 node_modules 时也能找到真正的仓库） */
export function resolveRepoRoot() {
  const env = String(process.env.VD_REPO || '').trim();
  if (env) return path.resolve(env);
  let dir = CODE_ROOT;
  for (let i = 0; i < 8; i++) {
    try { if (fs.existsSync(path.join(dir, '.git'))) return dir; } catch { /* ignore */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return CODE_ROOT;
}

function tmpDir() {
  for (const d of [os.tmpdir(), path.join(DATA_ROOT, 'logs')]) {
    try { fs.mkdirSync(d, { recursive: true }); return d; } catch { /* 下一个 */ }
  }
  return DATA_ROOT;
}

let _tmpSeq = 0;
function tmpFile(tag) {
  _tmpSeq += 1;
  return path.join(tmpDir(), `vdsnap-${process.pid}-${Date.now()}-${_tmpSeq}.${tag}`);
}

/**
 * 跑一条 git 命令。stdout 落临时文件（绕开管道 EPERM），返回 { status, out, error }。
 * status = -1 表示没跑起来（ENOENT/EPERM/超时等），error 里带原因。
 */
export function gitRun(repo, args) {
  const outFile = tmpFile('out');
  let fd = null;
  try {
    fd = fs.openSync(outFile, 'w');
    const r = spawnSync(gitExe(), args, {
      cwd: repo,
      stdio: ['ignore', fd, 'ignore'], // 关键：不用 pipe，DSH 沙箱下 pipe 会 EPERM
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' },
    });
    let out = '';
    try { out = fs.readFileSync(outFile, 'utf8'); } catch { out = ''; }
    return {
      status: r.status == null ? -1 : r.status,
      out,
      signal: r.signal || null,
      error: r.error ? String(r.error.code || r.error.message || r.error) : null,
    };
  } catch (e) {
    return { status: -1, out: '', signal: null, error: String((e && (e.code || e.message)) || e) };
  } finally {
    try { if (fd != null) fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
  }
}

function nowIso() { return new Date().toISOString(); }

/** 本地时间 "2026-11-02 11:05"（commit message 用，别用 Date.toLocaleString 免得中文环境格式漂移） */
function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 读快照状态；文件缺失/损坏都返回 null（损坏当没记过，会重新快照一次） */
export function readSnapshotState() {
  try {
    const j = JSON.parse(fs.readFileSync(SNAPSHOT_STATE, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

function writeSnapshotState(obj) {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_STATE), { recursive: true });
    const tmp = SNAPSHOT_STATE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, SNAPSHOT_STATE);
  } catch { /* 状态写不了不影响 git 操作，下次会重做 */ }
}

/** 失败日志：一行一个 JSON，永不抛 */
export function appendSnapshotLog(rec) {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_LOG), { recursive: true });
    fs.appendFileSync(SNAPSHOT_LOG, JSON.stringify({ at: nowIso(), ...rec }) + '\n', 'utf8');
  } catch { /* ignore */ }
}

function normTag(version) {
  const v = String(version == null ? '' : version).trim();
  if (!v) return '';
  return v.startsWith('v') ? v : 'v' + v;
}

// 同进程内同版本的并发调用合并成一次（panel 每请求热加载时可能被反复触发）
let _inflight = null;

async function runSnapshot(ver) {
  const started = Date.now();
  const tagName = normTag(ver);
  const repo = resolveRepoRoot();
  try {
    const prev = readSnapshotState();
    if (prev && String(prev.version) === ver) {
      return { skipped: true, version: ver, reason: 'version-unchanged', at: prev.at || null, commit: prev.commit || null, tag: prev.tag || tagName };
    }

    const inside = gitRun(repo, ['rev-parse', '--is-inside-work-tree']);
    if (inside.status !== 0 || inside.out.trim() !== 'true') {
      appendSnapshotLog({ action: 'skip', reason: 'not-a-git-repo', repo, detail: (inside.out || inside.error || '').trim().slice(0, 300) });
      return { skipped: true, version: ver, reason: 'not-a-git-repo', repo };
    }

    // 1) 收进暂存区
    const added = gitRun(repo, ['add', '-A']);
    if (added.status !== 0) {
      appendSnapshotLog({ action: 'add-failed', repo, version: ver, status: added.status, error: added.error, detail: (added.out || '').trim().slice(0, 300) });
      // 继续试：有些权限警告不影响 add 的结果
    }

    // 2) 是否真有改动（只比暂存区，忽略忽略文件）
    const st = gitRun(repo, ['status', '--porcelain']);
    if (st.status !== 0) {
      appendSnapshotLog({ action: 'status-failed', repo, version: ver, status: st.status, error: st.error });
      return { ok: false, version: ver, reason: 'status-failed', repo, error: st.error || `exit ${st.status}` };
    }
    const changes = st.out.split('\n').map(s => s.trim()).filter(Boolean);
    const changed = changes.length > 0;

    // 3) 有改动才 commit
    let committed = false;
    if (changed) {
      const msg = `${tagName} 自动快照（${fmtLocal(new Date())}）`;
      const c = gitRun(repo, ['commit', '-m', msg]);
      if (c.status !== 0) {
        appendSnapshotLog({ action: 'commit-failed', repo, version: ver, status: c.status, error: c.error, detail: (c.out || '').trim().slice(0, 400) });
        return { ok: false, version: ver, reason: 'commit-failed', repo, error: c.error || (c.out || '').trim().slice(0, 200) };
      }
      committed = true;
    }

    // 4) 打 tag（已存在则跳过）
    const head = gitRun(repo, ['rev-parse', '--short', 'HEAD']);
    const commit = head.status === 0 ? head.out.trim() : '';
    const tagList = gitRun(repo, ['tag', '-l', tagName]);
    const tagExists = tagList.status === 0 && tagList.out.split('\n').map(s => s.trim()).includes(tagName);
    let tagged = tagExists;
    let tagError = null;
    if (!tagExists) {
      const t = gitRun(repo, ['tag', tagName]);
      if (t.status === 0) tagged = true;
      else {
        tagError = t.error || `exit ${t.status}`;
        appendSnapshotLog({ action: 'tag-failed', repo, version: ver, tag: tagName, status: t.status, error: t.error, detail: (t.out || '').trim().slice(0, 300) });
      }
    }

    // 5) 记状态（只在 git 操作整体成功时记，失败靠 commit/tag 的 return 提前返回）
    const state = {
      version: ver,
      tag: tagName,
      commit,
      changed,
      committed,
      tagged,
      tagCreated: !tagExists,
      at: nowIso(),
      repo,
      ms: Date.now() - started,
    };
    writeSnapshotState(state);
    return { ok: true, skipped: false, ...state, tagError };
  } catch (e) {
    const error = String((e && (e.message || e)) || e);
    appendSnapshotLog({ action: 'error', repo, version: ver, error });
    return { ok: false, version: ver, reason: 'exception', repo, error };
  }
}

/**
 * 版本变了就快照：git add -A → 有改动则 commit「v<version> 自动快照（时间）」→ 打 tag v<version>。
 * 版本没变直接 {skipped:true}。**永不抛异常**（内部全 try/catch），失败只落 logs/git-snapshot.log。
 * @param {string} version 如 'v24' / '24'
 * @returns {Promise<{skipped?:boolean, ok?:boolean, version:string, reason?:string, commit?:string, tag?:string, changed?:boolean}>}
 */
export async function snapshotIfVersionChanged(version) {
  const ver = String(version == null ? '' : version).trim();
  if (!ver) return { skipped: true, version: '', reason: 'no-version' };
  if (_inflight && _inflight.version === ver) return _inflight.promise;
  const p = runSnapshot(ver);
  _inflight = { version: ver, promise: p };
  try {
    return await p;
  } catch (e) {
    // runSnapshot 理论上不会抛，这里兜底一次
    appendSnapshotLog({ action: 'error', version: ver, error: String((e && (e.message || e)) || e) });
    return { ok: false, version: ver, reason: 'exception', error: String((e && (e.message || e)) || e) };
  } finally {
    if (_inflight && _inflight.promise === p) _inflight = null;
  }
}

/** 只读体检：仓库状态 + 最近 commit/tag + 快照状态（CLI --status 用） */
export function gitSnapshotStatus() {
  const repo = resolveRepoRoot();
  const inside = gitRun(repo, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.out.trim() !== 'true') {
    return { repo, isRepo: false, git: gitExe(), error: inside.error || (inside.out || '').trim() || `exit ${inside.status}` };
  }
  const branch = gitRun(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = gitRun(repo, ['log', '--oneline', '-5']);
  const tags = gitRun(repo, ['tag', '--sort=-creatordate']);
  const st = gitRun(repo, ['status', '--porcelain']);
  const files = gitRun(repo, ['ls-files']);
  const dirtyLines = st.out.split('\n').map(s => s.trim()).filter(Boolean);
  return {
    repo,
    isRepo: true,
    git: gitExe(),
    branch: branch.out.trim(),
    head: head.out.split('\n').map(s => s.trim()).filter(Boolean),
    tags: tags.out.split('\n').map(s => s.trim()).filter(Boolean),
    dirty: dirtyLines.length,
    dirtyFiles: dirtyLines.slice(0, 20),
    trackedFiles: files.out.split('\n').filter(Boolean).length,
    state: readSnapshotState(),
    stateFile: SNAPSHOT_STATE,
    logFile: SNAPSHOT_LOG,
  };
}
