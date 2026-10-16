// 哔哩哔哩纯净模式 —— 内容脚本
//
// 主功能：按一下（按钮或 Alt+L）→ 页面只剩视频画面
//   * 页面里除了视频所在的那条祖先链，其余兄弟节点全部隐藏（推荐区、评论区、顶栏、侧栏…）
//   * 视频容器固定铺满整个视口
//   * 播放器自己的控制条、进度条、音量条、弹幕发送栏、弹幕设置栏一起隐掉
// 再按一下（或 Esc）→ 原样恢复。
//
// 为什么用"沿祖先链藏兄弟"而不是硬编码类名？
//   哔哩哔哩会改版、类名会变；但"视频在 DOM 里的祖先链"这个结构一定成立。
//   所以只要把链上每一层的其他孩子隐掉，页面装饰自然就没了，长期不用维护。
//   播放器*内部*的控制条无法用这招（它们是视频的兄弟而非祖先链的兄弟），
//   所以那部分用属性子串匹配（[class*="control-bottom"] 之类）补一刀。
//
// 附赠两个功能（主按钮不管它们）：
//   * Alt+; 熄屏听剧：整页纯黑、视频继续播放（躺着听）
//   * 纯净模式下按 D：连弹幕一起隐掉 / 显回来
(() => {
  'use strict'
  if (window.__biliCleanModeLoaded) return
  window.__biliCleanModeLoaded = true

  const BUTTON_ID = 'bili-clean-button'
  const OVERLAY_ID = 'bili-clean-overlay'
  const STYLE_ID = 'bili-clean-style'
  const TOAST_ID = 'bili-clean-toast'
  const ROOT_ATTR = 'data-bili-clean'
  const OWN_IDS = new Set([BUTTON_ID, OVERLAY_ID, STYLE_ID, TOAST_ID])
  const VERSION = '0.5.1'

  const PLAYER_SELECTORS = [
    '.bpx-player-container',
    '#bilibili-player',
    '#playerWrap',
    '.bpx-player-video-area',
  ]

  let mode = 'none' // 'none' | 'clean' | 'black'
  let button = null
  let overlay = null
  let hideDanmaku = false
  let hidden = [] // 被隐藏的兄弟节点：[{ el, display }]
  let savedStyles = [] // 被改过内联样式的元素：[{ el, cssText }]
  let idleTimer = 0
  let tickTimer = 0
  let watchTimer = 0
  let lastUrl = location.href
  let fullscreenByUs = false // 全屏是不是我们进的（决定退出时要不要替用户退出全屏）

  // ---- 小工具 -----------------------------------------------------------------
  function video () {
    const all = Array.from(document.querySelectorAll('video'))
    if (all.length === 0) return null
    return all
      .filter((v) => v.clientWidth > 0 && v.clientHeight > 0)
      .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] ?? all[0]
  }

  function playerRoot (target) {
    for (const selector of PLAYER_SELECTORS) {
      const found = document.querySelector(selector)
      if (found && found.contains(target)) return found
    }
    // 兜底启发式：往上走，直到祖先明显比视频大得多（那就是"页面"了）
    const limit = target.clientWidth * target.clientHeight * 3.2
    let node = target
    while (node.parentElement && node.parentElement !== document.body) {
      const parent = node.parentElement
      if (parent.clientWidth * parent.clientHeight > limit) break
      node = parent
    }
    return node
  }

  function title () {
    const node = document.querySelector('.video-title, h1.video-title, .bpx-player-ctrl-title, .tit, .mediainfo_mediaTitle')
    return ((node?.textContent || document.title || '哔哩哔哩').trim()).slice(0, 90)
  }

  function svg (name) {
    const shapes = {
      expand: '<path d="M4 9.5V4h5.5M20 14.5V20h-5.5M4 4l6.5 6.5M20 20l-6.5-6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
      collapse: '<path d="M9.5 4v5.5H4M14.5 20v-5.5H20M9.5 9.5L4 4M14.5 14.5L20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
      lock: '<path d="M7 10V7a5 5 0 0 1 10 0v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="4.5" y="10" width="15" height="10.5" rx="2.5" fill="currentColor"/>',
      unlock: '<path d="M7 10V7a5 5 0 0 1 9.6-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="4.5" y="10" width="15" height="10.5" rx="2.5" fill="currentColor"/>',
      play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>',
      pause: '<rect x="7" y="5.5" width="3.6" height="13" rx="1.2" fill="currentColor"/><rect x="13.4" y="5.5" width="3.6" height="13" rx="1.2" fill="currentColor"/>',
      volume: '<path d="M4 9.5h3.2L11.5 6v12L7.2 14.5H4z" fill="currentColor"/><path d="M15 9.2a4 4 0 0 1 0 5.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    }
    return `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">${shapes[name] ?? ''}</svg>`
  }

  // ---- 画面上可见的提示（诊断用：不用开控制台也能看到结果） -------------------
  function toast (message, ms = 4500) {
    ensureStyle()
    document.getElementById(TOAST_ID)?.remove()
    const el = document.createElement('div')
    el.id = TOAST_ID
    el.textContent = message
    ;(document.fullscreenElement ?? document.body).appendChild(el)
    window.setTimeout(() => el.remove(), ms)
  }

  const HINT_KEY = 'biliCleanHintVersion'
  // 每个版本只在首次打开视频页时提示一次：用来确认"到底跑的是哪一版代码"
  function maybeShowHint () {
    try {
      if (localStorage.getItem(HINT_KEY) === VERSION) return
      localStorage.setItem(HINT_KEY, VERSION)
    } catch {}
    toast(`纯净模式 v${VERSION} 已就绪 · 按钮在屏幕左缘中间（按 Alt+L 也行）`, 6000)
  }

  /**
   * 进真全屏。浏览器要求全屏必须由"用户手势"触发：
   *   点按钮 → 一定有手势 ✅
   *   按 Alt+L → 多数情况也算，但 Alt 组合键可能被浏览器当作菜单快捷键、把手势吃掉 ⚠
   * 所以失败时退一步去点哔哩哔哩自己的全屏按钮（它的逻辑最懂自家播放器）；
   * 再不行就把失败原因显示到画面上，免得只能靠猜。
   */
  async function goFullscreen (root) {
    try {
      await root.requestFullscreen()
      fullscreenByUs = true
      return true
    } catch (error) {
      try {
        const own = document.querySelector('.bpx-player-ctrl-full, [class*="ctrl-full"]')
        if (own) {
          own.click()
          await new Promise((resolve) => window.setTimeout(resolve, 150))
          if (document.fullscreenElement) { fullscreenByUs = true; return true }
        }
      } catch {}
      toast(`未能进入全屏（${error?.name ?? 'Error'}: ${error?.message ?? error}）· 已退回网页全屏`, 7000)
      return false
    }
  }

  /**
   * 诊断：把视口顶部"此刻正在显示"的元素描红，并报出它们的真实类名。
   *
   * 为什么需要它：哔哩哔哩全屏时顶部会浮出一条工具栏（视频标题、它的提示、
   * "关闭网页"的叉）。它的类名我无法凭空知道，而哔哩哔哩改版很勤、硬猜必然翻车。
   * 所以在它显示时按 T，让它自己把类名报出来，再据此写精确的隐藏规则。
   */
  function diagnoseTop () {
    const scope = document.querySelector(`[${ROOT_ATTR}="clean"]`) ?? document.body
    const candidates = []
    for (const el of scope.querySelectorAll('*')) {
      if (el.closest(`#${BUTTON_ID}`) || el.closest(`#${TOAST_ID}`)) continue
      const rect = el.getBoundingClientRect()
      if (rect.width < 8 || rect.height < 8) continue
      if (rect.top > 150) continue // 只看视口顶部 150px 以内
      const style = window.getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) continue
      candidates.push({ el, cls: String(el.className ?? ''), tag: el.tagName })
    }
    // 只留最外层：父节点也在候选里的就跳过，避免把整棵子树都列出来
    const outer = candidates.filter((c) => !candidates.some((o) => o !== c && o.el.contains(c.el)))
    outer.slice(0, 8).forEach((c) => {
      c.el.style.setProperty('outline', '2px solid #e5484d', 'important')
      c.el.style.setProperty('outline-offset', '-2px', 'important')
      window.setTimeout(() => {
        c.el.style.removeProperty('outline')
        c.el.style.removeProperty('outline-offset')
      }, 5000)
    })
    const list = outer.slice(0, 5)
      .map((c) => `${c.tag.toLowerCase()}.${(c.cls.split(' ')[0] || '(无类名)')}`)
      .join('　')
    toast(outer.length
      ? `顶部可见 ${outer.length} 个元素（已描红 5 秒）：${list}`
      : '顶部 150px 内没有可见元素 —— 先把鼠标移到屏幕顶部让那条栏浮出来，再按 T', 12000)
  }

  function ensureStyle () {
    if (document.getElementById(STYLE_ID)) return
    const node = document.createElement('style')
    node.id = STYLE_ID
    node.textContent = `
      /* 纯净模式：播放器铺满视口 */
      [${ROOT_ATTR}="clean"] { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; margin: 0 !important; padding: 0 !important; z-index: 2147483000 !important; background: #000 !important; }
      [${ROOT_ATTR}="clean"] video { width: 100% !important; height: 100% !important; object-fit: contain !important; }
      /* 播放器内部的控制条 / 进度条 / 音量条 / 弹幕发送栏 / 弹幕设置栏 */
      [${ROOT_ATTR}="clean"] [class*="control-bottom"],
      [${ROOT_ATTR}="clean"] [class*="control-wrap"],
      [${ROOT_ATTR}="clean"] [class*="control-progress"],
      [${ROOT_ATTR}="clean"] [class*="control-volume"],
      [${ROOT_ATTR}="clean"] [class*="sending-area"],
      [${ROOT_ATTR}="clean"] [class*="dm-setting"],
      [${ROOT_ATTR}="clean"] [class*="dm-send"],
      [${ROOT_ATTR}="clean"] [class*="control-mask"],
      /* 顶部那条浮出来的工具栏：视频标题、哔哩哔哩的提示、"关闭网页"的叉 */
      [${ROOT_ATTR}="clean"] [class*="control-top"],
      [${ROOT_ATTR}="clean"] [class*="top-wrap"],
      [${ROOT_ATTR}="clean"] [class*="top-bar"],
      [${ROOT_ATTR}="clean"] [class*="top-tool"],
      [${ROOT_ATTR}="clean"] [class*="top-title"],
      [${ROOT_ATTR}="clean"] [class*="player-top"],
      [${ROOT_ATTR}="clean"] [class*="video-top"],
      [${ROOT_ATTR}="clean"] [class*="close-web"],
      [${ROOT_ATTR}="clean"] [class*="fullscreen-top"],
      [${ROOT_ATTR}="clean"] [aria-label*="关闭网页"],
      [${ROOT_ATTR}="clean"] [title*="关闭网页"],
      [${ROOT_ATTR}="clean"] [data-text*="关闭网页"] { display: none !important; }
      /* 可选：连弹幕一起藏掉（纯净模式下按 D 切换） */
      [${ROOT_ATTR}="clean"][${ROOT_ATTR}-danmaku="off"] [class*="danmaku"],
      [${ROOT_ATTR}="clean"][${ROOT_ATTR}-danmaku="off"] [class*="dm-wrap"],
      [${ROOT_ATTR}="clean"][${ROOT_ATTR}-danmaku="off"] [class*="dm-layer"],
      [${ROOT_ATTR}="clean"][${ROOT_ATTR}-danmaku="off"] [class*="row-dm"] { display: none !important; }

      /* 页面右缘的按钮 */
      #${BUTTON_ID} { position: fixed; left: 0; top: 50%; transform: translateY(-50%) translateX(-6px); z-index: 2147483600; display: none; align-items: center; gap: 6px; padding: 8px 12px 8px 10px; border-radius: 0 999px 999px 0; background: rgba(18,18,22,.74); color: #fff; font: 500 13px/1 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; cursor: pointer; opacity: .8; user-select: none; -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); transition: opacity .18s ease, transform .18s ease, background .18s ease; }
      #${BUTTON_ID}.is-visible { display: inline-flex; }
      #${BUTTON_ID}:hover, #${BUTTON_ID}:focus-visible { opacity: 1; transform: translateY(-50%) translateX(0); background: rgba(251,114,153,.92); outline: none; }
      #${BUTTON_ID} .bili-clean-label { white-space: nowrap; }
      #${BUTTON_ID}.is-clean { opacity: .18; }
      #${BUTTON_ID}.is-clean:hover { opacity: 1; }
      /* 静止时把按钮也隐掉，画面真的只剩视频 */
      #${BUTTON_ID}.is-idle { opacity: 0; pointer-events: none; }
      /* 首次出现时抖两下，免得用户在屏幕边缘找不到 */
      #${BUTTON_ID}.is-attention { animation: bili-clean-attn 1.3s ease-in-out 2; }
      @keyframes bili-clean-attn {
        0%, 100% { transform: translateY(-50%) translateX(-6px) scale(1); }
        50% { transform: translateY(-50%) translateX(0) scale(1.14); }
      }

      /* 熄屏听剧的纯黑遮罩 */
      #${OVERLAY_ID} { position: fixed; inset: 0; z-index: 2147483500; display: flex; align-items: center; justify-content: center; background: #000; color: #fff; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; cursor: default; }
      #${OVERLAY_ID}.is-idle { cursor: none; }
      #${OVERLAY_ID} .bili-clean-center { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; padding: 0 24px; }
      #${OVERLAY_ID} .bili-clean-time { font-size: 64px; font-weight: 200; letter-spacing: 2px; font-variant-numeric: tabular-nums; opacity: .92; }
      #${OVERLAY_ID} .bili-clean-title { max-width: 72vw; font-size: 15px; opacity: .55; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${OVERLAY_ID} .bili-clean-hint { font-size: 12px; opacity: .3; }
      #${OVERLAY_ID}.is-idle .bili-clean-time { opacity: .2; }
      #${OVERLAY_ID}.is-idle .bili-clean-title, #${OVERLAY_ID}.is-idle .bili-clean-hint { opacity: .06; }
      #${OVERLAY_ID} .bili-clean-controls { position: absolute; bottom: 42px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 14px; padding: 10px 14px; border-radius: 999px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.1); transition: opacity .25s ease; }
      #${OVERLAY_ID}.is-idle .bili-clean-controls { opacity: 0; pointer-events: none; }
      #${OVERLAY_ID} .bili-clean-btn { display: inline-flex; align-items: center; gap: 6px; border: 0; border-radius: 999px; padding: 8px 14px; background: rgba(255,255,255,.1); color: #fff; font: inherit; font-size: 13px; cursor: pointer; }
      #${OVERLAY_ID} .bili-clean-btn:hover { background: rgba(255,255,255,.2); }
      #${OVERLAY_ID} .bili-clean-btn.is-primary { background: #fb7299; }
      #${OVERLAY_ID} .bili-clean-volume { display: inline-flex; align-items: center; gap: 8px; opacity: .85; }
      #${OVERLAY_ID} .bili-clean-volume input { width: 96px; accent-color: #fb7299; }

      /* 画面提示（诊断用） */
      #${TOAST_ID} { position: fixed; top: 16px; left: 16px; z-index: 2147483601; max-width: min(560px, calc(100vw - 32px)); padding: 10px 14px; border-radius: 10px; background: rgba(18,18,22,.92); color: #fff; font: 500 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.35); pointer-events: none; }
    `
    document.head.appendChild(node)
  }

  // ---- 按钮 -------------------------------------------------------------------
  function ensureButton () {
    if (button && button.isConnected) return button
    button = document.createElement('div')
    button.id = BUTTON_ID
    button.setAttribute('role', 'button')
    button.tabIndex = 0
    const fire = (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (mode === 'clean') exitClean()
      else enterClean()
    }
    button.addEventListener('click', fire)
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') fire(event)
    })
    document.body.appendChild(button)
    return button
  }

  /**
   * 全屏时浏览器只渲染"全屏元素及其子树"，所以按钮必须跟着搬进去，
   * 否则一进全屏按钮就消失、没法再点它退出。
   */
  function ensureButtonHost () {
    const el = ensureButton()
    const host = document.fullscreenElement ?? document.body
    if (el.parentElement !== host) host.appendChild(el)
    return el
  }

  let buttonEverShown = false

  function paintButton () {
    // 关键：按钮的样式就在 ensureStyle() 注入的那个 <style> 里。
    // 之前只在"进入模式"时才注入，导致页面刚加载时按钮是无样式的一行文字 —— 等于看不见。
    // 每次重绘都确认一次，页面若把 <style> 重渲染掉也能自动补回。
    ensureStyle()
    const el = ensureButtonHost()
    const inClean = mode === 'clean'
    const visible = inClean || (mode === 'none' && !!video())
    el.title = inClean ? '退出纯净模式（Alt+L / Esc）' : `纯净模式 v${VERSION}：只看视频画面（Alt+L）`
    // 标签保持干净（不带版本号）；版本号只放在悬停提示里，排查时用得上
    el.innerHTML = `${svg(inClean ? 'collapse' : 'expand')}<span class="bili-clean-label">${inClean ? '退出纯净' : '纯净模式'}</span>`
    el.classList.toggle('is-clean', inClean)
    // 踩过的坑：is-idle 会把按钮压成完全透明，而它只该在"纯净模式里鼠标不动"时出现。
    // 退出纯净模式后若残留这个类，按钮就永远看不见了（表现为"要先进出一次才出现"）——
    // 所以非纯净模式下强制清掉它。
    if (!inClean) el.classList.remove('is-idle')
    el.classList.toggle('is-visible', visible)
    // 首次出现时抖两下，免得用户在屏幕边缘找不到
    if (visible && !buttonEverShown) {
      buttonEverShown = true
      el.classList.add('is-attention')
      window.setTimeout(() => el.classList.remove('is-attention'), 2600)
    }
  }

  // ---- 纯净模式 ---------------------------------------------------------------
  const HIDDEN_ATTR = 'data-bili-clean-hidden'

  function hideElement (el) {
    if (!el || el.hasAttribute(HIDDEN_ATTR)) return
    hidden.push({ el, display: el.style.display })
    el.setAttribute(HIDDEN_ATTR, '')
    el.style.setProperty('display', 'none', 'important')
  }

  /** 弹幕层要留着（用户可按 D 再隐藏它）。用类名 + "含 canvas 但不含 video"双重判断。 */
  function isDanmakuLayer (el) {
    const cls = String(el.className ?? '')
    if (/danmaku|dm-wrap|dm-layer|row-dm/.test(cls)) return true
    if (el.querySelector?.('canvas') && !el.querySelector('video')) return true
    return false
  }

  /**
   * 清场：把"此刻不该出现的东西"再隐藏一轮。
   *
   * 分两段，都不依赖哔哩哔哩的类名：
   *   1. 播放器内部 —— 只保留"视频的祖先链"与弹幕层，其余兄弟全隐
   *      （控制条 / 进度条 / 音量条 / 顶部工具栏 / 退出提示 / 关闭网页的叉…）
   *   2. 播放器之外 —— 沿祖先链隐藏所有兄弟（推荐区 / 评论区 / 顶栏 / 侧栏…）
   *
   * 之所以要反复调用：进入全屏后哔哩哔哩才会**新建**那条"按 ESC 退出全屏"的提示层，
   * 只隐藏一次是抓不到它的。
   */
  function sweepChrome () {
    const root = document.querySelector(`[${ROOT_ATTR}="clean"]`)
    if (!root) return
    const video = root.querySelector('video')

    // 1) 播放器内部
    if (video) {
      const keep = new Set()
      for (let node = video; node && node !== root.parentElement; node = node.parentElement) keep.add(node)
      for (const el of root.querySelectorAll('*')) if (isDanmakuLayer(el)) keep.add(el)

      for (let node = video; node && node !== root; node = node.parentElement) {
        const parent = node.parentElement
        if (!parent) break
        for (const sibling of Array.from(parent.children)) {
          if (sibling === node) continue
          if (OWN_IDS.has(sibling.id)) continue
          if (keep.has(sibling)) continue
          // 里面装着要保留的东西（例如弹幕层）就不能连坐隐藏
          if ([...keep].some((k) => sibling.contains(k))) continue
          hideElement(sibling)
        }
      }
    }

    // 2) 播放器之外
    for (let node = root; node && node !== document.body; node = node.parentElement) {
      const parent = node.parentElement
      if (!parent) break
      for (const sibling of Array.from(parent.children)) {
        if (sibling === node) continue
        if (OWN_IDS.has(sibling.id)) continue
        if (sibling.contains(root)) continue // 绝不能把播放器自己藏了
        if (sibling.querySelector?.(`[${ROOT_ATTR}]`)) continue
        hideElement(sibling)
      }
    }
  }

  function enterClean () {
    const target = video()
    if (!target) return
    const root = playerRoot(target)
    if (!root) return
    ensureStyle()

    mode = 'clean'
    hidden = []
    savedStyles = [{ el: root, cssText: root.getAttribute('style') ?? '' }]

    // 先把播放器铺满，再清场（清场不依赖类名，见 sweepChrome）
    root.setAttribute(ROOT_ATTR, 'clean')
    document.documentElement.setAttribute(ROOT_ATTR, 'clean')
    if (hideDanmaku) document.documentElement.setAttribute(`${ROOT_ATTR}-danmaku`, 'off')
    sweepChrome()

    // 刚进入的几秒内容易冒出提示层（"按 ESC 退出全屏"之类），密集复查几次
    for (const delay of [80, 300, 800, 1600, 3000]) {
      window.setTimeout(() => { if (mode === 'clean') sweepChrome() }, delay)
    }

    // 让播放器重新计算尺寸（它监听 window resize）
    setTimeout(() => window.dispatchEvent(new Event('resize')), 60)
    setTimeout(() => window.dispatchEvent(new Event('resize')), 400)

    // 顺手进真全屏 —— 这就是"全屏纯净模式"。
    // 上面那套 CSS 铺满只是"网页全屏"兜底；真全屏要靠 goFullscreen() 去申请。
    if (!document.fullscreenElement) void goFullscreen(root)

    paintButton()
    wakeButton()
  }

  async function exitClean () {
    if (mode !== 'clean') return
    mode = 'none' // 先置状态，避免下面的 fullscreenchange 递归回来
    // 先退出全屏、再还原 DOM，否则退出过程中会闪一下"半残"的页面
    if (fullscreenByUs && document.fullscreenElement) {
      try { await document.exitFullscreen() } catch {}
    }
    fullscreenByUs = false
    for (const item of hidden) {
      item.el.removeAttribute(HIDDEN_ATTR)
      if (item.display) item.el.style.display = item.display
      else item.el.style.removeProperty('display')
    }
    hidden = []
    for (const item of savedStyles) {
      if (item.cssText) item.el.setAttribute('style', item.cssText)
      else item.el.removeAttribute('style')
    }
    savedStyles = []
    document.documentElement.removeAttribute(ROOT_ATTR)
    document.documentElement.removeAttribute(`${ROOT_ATTR}-danmaku`)
    document.querySelectorAll(`[${ROOT_ATTR}]`).forEach((el) => el.removeAttribute(ROOT_ATTR))
    window.clearTimeout(idleTimer)
    setTimeout(() => window.dispatchEvent(new Event('resize')), 60)
    paintButton()
  }

  // 静止 3 秒后连按钮一起隐掉，画面才真的是"只有视频"
  function wakeButton () {
    if (!button) return
    button.classList.remove('is-idle')
    window.clearTimeout(idleTimer)
    if (mode === 'clean') {
      idleTimer = window.setTimeout(() => button?.classList.add('is-idle'), 3000)
    }
  }

  // ---- 熄屏听剧（附赠） -------------------------------------------------------
  function lockClock () {
    const now = new Date()
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  }

  function renderOverlay () {
    if (!overlay) return
    const time = overlay.querySelector('.bili-clean-time')
    const heading = overlay.querySelector('.bili-clean-title')
    if (time) time.textContent = lockClock()
    if (heading) heading.textContent = title()
    const v = video()
    const paused = !v || v.paused
    const playBtn = overlay.querySelector('[data-act="playpause"]')
    if (playBtn) playBtn.innerHTML = `${svg(paused ? 'play' : 'pause')}<span>${paused ? '播放' : '暂停'}</span>`
    const range = overlay.querySelector('input[type="range"]')
    if (range && v && document.activeElement !== range) range.value = String(Math.round(v.volume * 100))
  }

  function wakeControls () {
    if (!overlay) return
    overlay.classList.remove('is-idle')
    window.clearTimeout(idleTimer)
    idleTimer = window.setTimeout(() => overlay?.classList.add('is-idle'), 3000)
  }

  function enterBlack () {
    if (mode !== 'none' || !video()) return
    mode = 'black'
    ensureStyle()
    overlay = document.createElement('div')
    overlay.id = OVERLAY_ID
    overlay.innerHTML = `
      <div class="bili-clean-center">
        <div class="bili-clean-time"></div>
        <div class="bili-clean-title"></div>
        <div class="bili-clean-hint">视频仍在播放 · 移动鼠标显示控制 · Esc 退出</div>
      </div>
      <div class="bili-clean-controls">
        <button type="button" class="bili-clean-btn" data-act="playpause"></button>
        <div class="bili-clean-volume">${svg('volume')}<input type="range" min="0" max="100" step="1" aria-label="音量"></div>
        <button type="button" class="bili-clean-btn is-primary" data-act="unlock">${svg('unlock')}<span>退出熄屏</span></button>
      </div>`
    overlay.addEventListener('click', (event) => {
      const act = event.target?.closest?.('[data-act]')?.getAttribute('data-act')
      if (act === 'unlock') { event.preventDefault(); exitBlack() }
      if (act === 'playpause') {
        event.preventDefault()
        const v = video()
        if (v) { if (v.paused) v.play().catch(() => {}); else v.pause() }
        renderOverlay()
      }
    })
    overlay.addEventListener('input', (event) => {
      if (event.target instanceof HTMLInputElement && event.target.type === 'range') {
        const v = video()
        if (v) v.volume = Number(event.target.value) / 100
      }
    })
    overlay.addEventListener('mousemove', wakeControls)
    ;(document.fullscreenElement ?? document.body).appendChild(overlay)
    document.documentElement.setAttribute(`${ROOT_ATTR}-black`, 'on')
    renderOverlay()
    wakeControls()
    tickTimer = window.setInterval(renderOverlay, 10000)
    paintButton()
  }

  function exitBlack () {
    if (mode !== 'black') return
    mode = 'none'
    window.clearInterval(tickTimer)
    window.clearTimeout(idleTimer)
    overlay?.remove()
    overlay = null
    document.documentElement.removeAttribute(`${ROOT_ATTR}-black`)
    paintButton()
  }

  // ---- 事件 -------------------------------------------------------------------
  window.addEventListener('keydown', (event) => {
    const altL = event.altKey && (event.key === 'l' || event.key === 'L')
    const altSemicolon = event.altKey && event.key === ';'

    if (mode === 'none') {
      if (altL && video()) { event.preventDefault(); event.stopPropagation(); enterClean() }
      if (altSemicolon && video()) { event.preventDefault(); event.stopPropagation(); enterBlack() }
      return
    }

    if (mode === 'black') {
      if (event.key === 'Escape' || altSemicolon) { event.preventDefault(); event.stopPropagation(); exitBlack(); return }
      const v = video()
      switch (event.key) {
        case ' ': case 'k':
          event.preventDefault(); event.stopPropagation()
          if (v) { if (v.paused) v.play().catch(() => {}); else v.pause() }
          renderOverlay(); break
        case 'ArrowLeft': event.preventDefault(); event.stopPropagation(); if (v) v.currentTime = Math.max(0, v.currentTime - 5); break
        case 'ArrowRight': event.preventDefault(); event.stopPropagation(); if (v) v.currentTime += 5; break
        case 'ArrowUp': event.preventDefault(); event.stopPropagation(); if (v) v.volume = Math.min(1, v.volume + 0.05); renderOverlay(); break
        case 'ArrowDown': event.preventDefault(); event.stopPropagation(); if (v) v.volume = Math.max(0, v.volume - 0.05); renderOverlay(); break
        case 'Tab': case 'Enter': wakeControls(); break
        default:
          if (!event.ctrlKey && !event.metaKey) event.stopPropagation()
          break
      }
      wakeControls()
      return
    }

    // 纯净模式
    if (event.key === 'Escape' || altL) { event.preventDefault(); event.stopPropagation(); exitClean(); return }
    if (event.key === 'd' || event.key === 'D') {
      event.preventDefault(); event.stopPropagation()
      hideDanmaku = !hideDanmaku
      if (hideDanmaku) document.documentElement.setAttribute(`${ROOT_ATTR}-danmaku`, 'off')
      else document.documentElement.removeAttribute(`${ROOT_ATTR}-danmaku`)
      return
    }
    // T：诊断顶部工具栏（描红 + 报类名），用来把"藏不掉的那条"钉死
    if (event.key === 't' || event.key === 'T') {
      event.preventDefault(); event.stopPropagation()
      diagnoseTop()
      return
    }
    wakeButton()
  }, true)

  // 熄屏时挡住页面滚动
  window.addEventListener('wheel', (event) => {
    if (mode === 'black') event.preventDefault()
  }, { passive: false, capture: true })

  // 纯净模式下鼠标一动就把按钮浮回来（否则静止 3 秒隐掉后，鼠标用户找不回它）
  window.addEventListener('mousemove', () => {
    if (mode === 'clean') wakeButton()
  }, true)

  // 全屏只渲染"全屏元素及其子树"：按钮和遮罩都得跟着搬进去，否则全屏后点不到
  document.addEventListener('fullscreenchange', () => {
    const host = document.fullscreenElement ?? document.body
    if (overlay && overlay.parentElement !== host) host.appendChild(overlay)
    if (button && button.parentElement !== host) host.appendChild(button)
    // 在纯净模式里按 Esc 退出全屏 → 纯净模式一起退出（两者是一个状态）
    if (mode === 'clean' && !document.fullscreenElement) void exitClean()
  })

  // 轮询：SPA 换视频、节点被重渲染挤掉、按钮显隐
  // 整段包了 try/catch：一旦内部出错就把原因显示到画面上，
  // 而不是静默地"按钮就是不见了"——那种问题最难查。
  let reported = false
  function reportOnce (error) {
    if (reported) return
    reported = true
    try { toast(`纯净模式内部错误：${error?.message ?? error}`, 9000) } catch {}
    console.log('[纯净模式] 内部错误', error)
  }

  watchTimer = window.setInterval(() => {
    try {
      if (location.href !== lastUrl) {
        lastUrl = location.href
        if (mode !== 'none') { void exitClean(); exitBlack() }
      }
      if (mode === 'clean' && !document.querySelector(`[${ROOT_ATTR}="clean"]`)) void exitClean()
      // 纯净模式里持续复查：哔哩哔哩随时可能新建提示层 / 顶部栏（那些只在进入全屏后才出现）
      if (mode === 'clean') sweepChrome()
      if (mode === 'black' && overlay && !overlay.isConnected) exitBlack()
      if (mode === 'none' || mode === 'clean') paintButton()
      if (mode === 'none' && video()) maybeShowHint() // 每个版本首次打开视频页提示一次，用来确认跑的是哪一版代码
    } catch (error) {
      reportOnce(error)
    }
  }, 1000)

  function boot () {
    try {
      paintButton()
    } catch (error) {
      reportOnce(error)
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
  else boot()
})()
