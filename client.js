/* 一起看视频 · 客户端插件（浏览器侧）—— 2026-10-31 改为「右侧栏分栏」形态
 *
 * 用户要求：「对话栏要保留，面板是分栏」→ 面板不再占掉整个主区，而是打开在
 * **DSH 右侧边栏（right Sidebar）** 的一个 tab 里：左边对话照常，右边面板，宽度可拖。
 *
 * 用的都是宿主自己公开的机制（asar 里 ui-sidebar-right 的契约）：
 *   ctx.inject(['sidebarRight','sidebarRightTabs'], s => {
 *     s.sidebarRightTabs.register({ id, kind, title(), keepMounted:true })   // 声明一个 tab 类型
 *     ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name:'sidebar.right.pane.tab', key:id }, Body))
 *   })
 *   ctx.sidebarRight.openTab(kind)     // 打开 / 聚焦（会自动展开右栏）
 *   ctx.sidebarRight.isExpanded() / active() / toggleExpanded() / close(tabId)
 *
 * 入口只有一个：会话头部右上角的 🐟（用户明确「只保留鱼图标不要字」）。
 * 点一下 = 展开右栏并显示面板；再点一下 = 收起右栏（对话恢复满宽）。
 *
 * 兜底：若宿主没有 sidebarRight（老版本 / 没有会话在屏上），退回「侧边浮层 + iframe」。
 * **绝不用 window.location.assign**（早先版本这么干，一点就把整个 DSH 界面换成面板页、退不回来）。
 *
 * 面板地址 /video-panel/ 由宿主侧 index.js 的 installPanelRoute 挂到 DSH 自己的 webServer，
 * 同源同端口 → 不用记端口，也不受 GUI 每次重启换端口影响。
 */

(function boot() {
  try {
    var q = '?stage=boot&ok=1&detail=' + encodeURIComponent('client.js 已执行 · loader=' + (typeof window.__ModuleLoader__))
    if (navigator && typeof navigator.sendBeacon === 'function') navigator.sendBeacon('/video-panel/api/plugin-report' + q)
    else if (window.fetch) window.fetch('/video-panel/api/plugin-report' + q, { keepalive: true }).catch(function () {})
  } catch (e) { /* 上报失败绝不影响插件 */ }
})()

window.__ModuleLoader__.load({
  id: 'dsh-video-digest',
  factory: (require) => {
    const raw = require('react')
    const React = (raw && typeof raw.createElement === 'function') ? raw : (raw && raw.default) || {}
    const h = React.createElement

    const PANEL_PATH = '/video-panel/'
    const REPORT = '/video-panel/api/plugin-report'
    const OPEN_API = PANEL_PATH.replace(/\/$/, '') + '/api/open'

    /* tab 类型的 id 同时是正文在 sidebar.right.pane.tab 里的键；kind 是 openTab 用的名字 */
    const TAB_ID = 'dsh-video-digest/panel'
    const TAB_KIND = 'videoDigest'
    const TAB_TITLE = '一起看视频'

    /* 面板地址：优先当前文档 origin（面板挂在同一个 webServer 上）。
       兜底：origin 可能是 "null"（沙箱 iframe / 自定义 scheme），改用 document.baseURI 推导。 */
    const panelUrl = () => {
      try {
        const o = String(window.location.origin || '')
        if (/^https?:\/\//i.test(o)) return o + PANEL_PATH
        const b = String(document.baseURI || '')
        const m = b.match(/^(https?:\/\/[^/]+)/i)
        if (m) return m[1] + PANEL_PATH
        return PANEL_PATH
      } catch (e) { return PANEL_PATH }
    }

    const report = (stage, ok, detail, extra) => {
      try {
        const q = new URLSearchParams({
          stage: String(stage || ''), ok: ok ? '1' : '0',
          detail: String(detail || ''),
          slot: String((extra && extra.slot) || ''),
          href: String(window.location.href || ''),
        })
        const url = REPORT + '?' + q.toString()
        if (navigator && typeof navigator.sendBeacon === 'function') navigator.sendBeacon(url)
        else fetch(url, { method: 'GET', keepalive: true }).catch(() => {})
      } catch (e) { /* 上报失败绝不影响 UI */ }
    }

    report('factory', true, 'factory 被调用 · react=' + (typeof h))

    /* 清掉更早版本留下的普通 DOM 节点（HMR 不会替我们删） */
    const cleanupStale = () => {
      try {
        const stale = document.getElementById('dsh-video-digest-fab')
        if (stale && stale.parentNode) stale.parentNode.removeChild(stale)
      } catch (e) {}
    }
    cleanupStale()

    /* ── 兜底用：提示条与浮层 ── */
    const OVERLAY_ID = 'dsh-video-digest-overlay'
    const HINT_ID = 'dsh-video-digest-hint'
    const hint = (msg) => {
      try {
        const el = document.getElementById(HINT_ID)
        if (el) { el.style.display = 'flex'; el.textContent = msg }
      } catch (e) {}
    }

    const openInBrowser = () => {
      const url = panelUrl()
      try {
        fetch(OPEN_API + '?url=' + encodeURIComponent(url), { method: 'GET', cache: 'no-store', keepalive: true })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then((j) => {
            if (j && j.ok) hint('已在系统浏览器打开：' + String(j.opened || url))
            else throw new Error(String((j && j.error) || 'unknown'))
          })
          .catch((e) => {
            try { navigator.clipboard.writeText(url) } catch (x) {}
            hint('宿主没让系统浏览器打开（' + String((e && e.message) || e) + '）。地址已尝试复制：' + url)
          })
      } catch (e) {}
    }

    const closeOverlay = () => {
      try {
        const el = document.getElementById(OVERLAY_ID)
        if (el && el.parentNode) el.parentNode.removeChild(el)
        document.documentElement.style.overflow = ''
        document.removeEventListener('keydown', onKey, true)
      } catch (e) {}
    }
    const onKey = (ev) => { if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) { ev.stopPropagation(); closeOverlay() } }

    const mkBtn = (label, title, onClick) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      if (title) b.title = title
      b.style.cssText = [
        'padding:4px 10px', 'border-radius:8px', 'cursor:pointer',
        'border:1px solid rgba(127,127,127,.40)', 'background:rgba(255,255,255,.06)',
        'color:#dfe8f2', 'font:13px/20px system-ui', 'white-space:nowrap',
      ].join(';')
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick() })
      return b
    }

    /* 只有「宿主没有 sidebarRight」时才走这里 */
    const openOverlay = () => {
      const url = panelUrl()
      if (document.getElementById(OVERLAY_ID)) { closeOverlay(); return }
      const wrap = document.createElement('div')
      wrap.id = OVERLAY_ID
      wrap.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483000',
        'display:flex', 'align-items:stretch', 'justify-content:flex-end',
        'background:rgba(6,9,13,.55)',
      ].join(';')
      wrap.addEventListener('click', (e) => { if (e.target === wrap) closeOverlay() })

      const card = document.createElement('div')
      card.style.cssText = [
        'display:flex', 'flex-direction:column', 'min-width:0',
        'width:min(1240px,95vw)', 'height:96vh', 'margin:2vh 1vw 2vh 0',
        'background:#0f1419', 'color:#d7e0ea',
        'border:1px solid rgba(127,127,127,.35)', 'border-radius:14px',
        'box-shadow:0 24px 80px rgba(0,0,0,.55)', 'overflow:hidden',
      ].join(';')
      card.addEventListener('click', (e) => e.stopPropagation())

      const bar = document.createElement('div')
      bar.style.cssText = [
        'display:flex', 'align-items:center', 'gap:10px', 'flex:0 0 auto',
        'padding:10px 12px', 'border-bottom:1px solid rgba(127,127,127,.22)',
        'background:rgba(255,255,255,.03)',
      ].join(';')
      const title = document.createElement('div')
      title.textContent = TAB_TITLE + ' · 面板'
      title.style.cssText = 'font:600 14px/22px system-ui;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      const tip = document.createElement('div')
      tip.textContent = 'ESC 关'
      tip.style.cssText = 'font:12px/20px system-ui;opacity:.55;flex:0 0 auto'
      bar.appendChild(title)
      bar.appendChild(tip)
      bar.appendChild(mkBtn('↗ 浏览器打开', '用系统默认浏览器新标签打开', openInBrowser))
      bar.appendChild(mkBtn('✕', '关闭（ESC）', closeOverlay))

      const frameBox = document.createElement('div')
      frameBox.style.cssText = 'position:relative;flex:1 1 auto;min-height:0;background:#0f1419'
      const fallback = document.createElement('div')
      fallback.id = HINT_ID
      fallback.textContent = '正在加载面板…（若一直空白：点右上角「↗ 浏览器打开」，或用浏览器直接访问 ' + url + '）'
      fallback.style.cssText = [
        'position:absolute', 'inset:0', 'display:flex', 'align-items:center', 'justify-content:center',
        'padding:24px', 'text-align:center', 'font:13px/1.9 system-ui',
        'color:#8b98a6', 'background:#0f1419', 'word-break:break-all', 'user-select:text',
      ].join(';')
      const frame = document.createElement('iframe')
      frame.src = url
      frame.title = '视频面板'
      frame.setAttribute('allow', 'clipboard-write; clipboard-read')
      frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#0f1419'
      frame.addEventListener('load', () => { try { fallback.style.display = 'none' } catch (e) {} })

      frameBox.appendChild(fallback)
      frameBox.appendChild(frame)
      card.appendChild(bar)
      card.appendChild(frameBox)
      wrap.appendChild(card)
      document.body.appendChild(wrap)
      document.documentElement.style.overflow = 'hidden'
      document.addEventListener('keydown', onKey, true)
      report('render', true, 'overlay opened(fallback): ' + url, { slot: 'overlay' })
    }

    /* ── 右栏 tab 的正文：iframe 铺满整个 pane（pane 正文贴到每条边）── */
    const TabBody = () => h('div', {
      style: {
        display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0,
        width: '100%', height: '100%', background: '#0f1419',
      },
    }, h('iframe', {
      src: panelUrl(),
      title: TAB_TITLE + ' · 面板',
      allow: 'clipboard-write; clipboard-read',
      style: { flex: '1 1 auto', width: '100%', minHeight: 0, border: 0, display: 'block', background: '#0f1419' },
    }))

    /* ── 面板开关：在右栏分屏打开 / 收起 ── */
    let sidebarRight = null

    const safe = (fn, dflt) => { try { return fn() } catch (e) { return dflt } }

    const openPanel = () => {
      const sr = sidebarRight
      if (sr && typeof sr.openTab === 'function') {
        try {
          const active = safe(() => sr.active(), null)
          const expanded = safe(() => sr.isExpanded(), false)
          if (expanded && active && active.kind === TAB_KIND) {
            sr.toggleExpanded()                       // 再点一次 = 收起右栏，对话恢复满宽
            report('click', true, 'collapse right sidebar', { slot: 'header' })
            return
          }
          sr.openTab(TAB_KIND, { params: {} })        // 打开/聚焦并自动展开右栏
          report('click', true, 'openTab(' + TAB_KIND + ') in sidebarRight', { slot: 'header' })
          return
        } catch (e) {
          report('click', false, 'sidebarRight 调用失败，退回浮层：' + String((e && e.message) || e), { slot: 'header' })
        }
      } else {
        report('click', false, '没有 sidebarRight 服务，退回浮层', { slot: 'header' })
      }
      openOverlay()
    }

    /* ── 会话头部右上角的 🐟（只保留这一处入口，无文字）── */
    const iconStyle = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 28, height: 28, padding: 0, margin: 0,
      borderRadius: 8, cursor: 'pointer',
      border: '1px solid rgba(127,127,127,.30)', background: 'transparent',
      color: 'inherit', fontSize: 15, lineHeight: '16px',
      fontFamily: '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",inherit',
      textDecoration: 'none', userSelect: 'none',
    }

    let renderedHeader = false
    function HeaderIcon() {
      if (!renderedHeader) { renderedHeader = true; report('render', true, 'first render', { slot: 'header' }) }
      return h('button', {
        type: 'button',
        onClick: (ev) => { try { ev.preventDefault() } catch (e) {} openPanel() },
        title: '打开视频面板（右侧分栏，对话保留；再点收起）',
        'aria-label': '打开视频面板',
        style: iconStyle,
      }, '🐟')
    }

    /* 上一次 apply 的注销器：HMR 会重跑 apply，不清理就会叠出重复的 tab 类型/行 */
    let disposers = []
    const disposeAll = () => {
      for (const off of disposers) { try { if (typeof off === 'function') off() } catch (e) {} }
      disposers = []
    }
    const keep = (off) => { if (typeof off === 'function') disposers.push(off) }

    function apply(ctx) {
      report('apply', true, 'client plugin apply 开始 · ctx.slots=' + typeof (ctx && ctx.slots))
      cleanupStale()

      const slots = ctx && ctx.slots
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        report('register', false, 'ctx.slots 不可用', { slot: 'header' })
        return
      }

      disposeAll()

      /* ① 右栏：注册 tab 类型 + 正文席位，并取到控制服务 ctx.sidebarRight */
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scoped) => {
            const tabs = scoped && scoped.sidebarRightTabs
            const ctrl = scoped && scoped.sidebarRight
            if (ctrl && typeof ctrl.openTab === 'function') sidebarRight = ctrl

            if (tabs && typeof tabs.register === 'function') {
              try {
                keep(tabs.register({
                  id: TAB_ID,
                  kind: TAB_KIND,
                  title: () => TAB_TITLE,
                  keepMounted: true,   // 切 tab / 收起栏时不销毁 iframe，避免反复重载面板
                }))
                report('register', true, 'tab 类型已注册 kind=' + TAB_KIND, { slot: 'sidebarRight' })
              } catch (e) {
                report('register', false, 'tab 类型注册失败：' + String((e && e.message) || e), { slot: 'sidebarRight' })
              }
            } else {
              report('register', false, 'sidebarRightTabs 不可用', { slot: 'sidebarRight' })
            }

            try {
              slots.inject('sidebar.right.pane.tab', () => keep(slots.register(
                { name: 'sidebar.right.pane.tab', key: TAB_ID }, TabBody,
              )))
              report('register', true, '右栏正文已注册 key=' + TAB_ID, { slot: 'pane' })
            } catch (e) {
              report('register', false, '右栏正文注册失败：' + String((e && e.message) || e), { slot: 'pane' })
            }
          })
        }
      } catch (e) {
        report('register', false, 'sidebarRight 注入失败：' + String((e && e.message) || e), { slot: 'sidebarRight' })
      }

      /* ② 会话头部右上角的 🐟（唯一入口） */
      try {
        slots.inject('conversation.session.header.utilities', () => {
          const off = slots.register({
            name: 'conversation.session.header.utilities',
            id: 'video-digest-open-panel',
            order: 30,
            registrant: 'dsh-video-digest',
          }, HeaderIcon)
          keep(off)
          report('register', true, 'header（🐟 图标）', { slot: 'header' })
          return off
        })
      } catch (e) {
        report('register', false, 'header 注册失败：' + String((e && e.message) || e), { slot: 'header' })
      }

      report('apply', true, 'client plugin apply 结束（右侧栏分栏模式）')
    }

    const exports = {}
    exports.apply = apply
    exports.inject = ['slots']
    return exports
  },
})

try {
  if (navigator && typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon('/video-panel/api/plugin-report?stage=registered&ok=1&detail=' + encodeURIComponent('__ModuleLoader__.load 已登记（右侧栏分栏版）'))
  }
} catch (e) {}
