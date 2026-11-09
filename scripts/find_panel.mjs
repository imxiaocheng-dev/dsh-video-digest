/* 找到当前活着的面板端口（DSH 每次重启端口会变）。
   用法：node scripts/find_panel.mjs
   输出：http://127.0.0.1:<port>/video-panel
   实现：扫 40000-65000，GET /video-panel/api/health，2 秒内返回 version 的就是。 */
const lo = 40000, hi = 65000
const probe = async (port) => {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 250)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/video-panel/api/health`, { signal: ctl.signal })
    if (!r.ok) return null
    const j = await r.json()
    if (j && typeof j.version === 'string') return { port, version: j.version, health: j }
    return null
  } catch (e) { return null } finally { clearTimeout(t) }
}
const ports = []
for (let p = lo; p <= hi; p += 1) ports.push(p)
const out = []
for (let i = 0; i < ports.length; i += 200) {
  const batch = ports.slice(i, i + 200)
  const res = await Promise.all(batch.map(probe))
  for (const r of res) if (r) out.push(r)
  if (out.length) break
}
if (!out.length) { console.error('NO_PANEL'); process.exit(2) }
for (const r of out) console.log(`http://127.0.0.1:${r.port}/video-panel  version=${r.version}`)
