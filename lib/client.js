/**
 * dsh-model-vision — browser half.
 *
 * 唯一入口：「设置 → 模型」页模型列表下方的那一行按钮（官方声明好的
 * `settings.models.footer` 插槽）。
 *
 * 代码结构就三块，方便日后跟着 DSH 升级改：
 *   1. CONTRACT —— 所有对外名字集中在这里（插槽名、请求路径、头、协议版本）。
 *      宿主半边 `lib/index.js` 有同一份，`test/contract.test.mjs` 会比对两边，
 *      任何一边改了名字而另一边没跟，测试立刻失败。
 *   2. useDetect —— 一个动作：POST、等、留下结果。没有别的副作用。
 *   3. UI —— 只有一个组件，按钮 + 一句话结果 + 可展开明细。
 *
 * 跨版本策略：主入口是 footer 插槽；万一某个版本没有这个插槽（改名/移除），
 * 4 秒内没注册成功就自动退到「设置 → 视觉能力」单页，用同一个组件渲染。
 * 插件不会因为插槽消失就静默失踪。
 *
 * 本 bundle 手写以适配 shell 的模块加载器契约（kernel 求值 factory 并读取它
 * 留下的 CommonJS exports），因此不是由打包器产出。
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-vision',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    /**
     * Every external name this bundle depends on.
     *
     * `rpcPath` and `rpcHeader` must equal the host's `RPC_PATH` / `RPC_HEADER`;
     * `protocol` must equal the host's `PROTOCOL_VERSION`. Both are checked by
     * `test/contract.test.mjs`, so a rename on one side fails loudly instead of
     * silently breaking the button.
     */
    const CONTRACT = {
      rpcPath: '/plugins/model-vision/detect',
      rpcHeader: 'x-model-vision',
      protocol: 1,
      slot: 'settings.models.footer',
      slotId: 'model-vision',
      fallbackSlot: 'settings.section',
      fallbackWaitMs: 4000,
    }

    const STYLE_ID = 'model-vision-styles'

    const CSS = [
      '.mv-inline { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(128,128,128,0.18); }',
      '.mv-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }',
      '.mv-btn { font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 6px; border: 1px solid rgba(80,130,220,0.55); background: transparent; color: inherit; cursor: pointer; }',
      '.mv-btn:hover:not(:disabled) { background: rgba(80,130,220,0.12); }',
      '.mv-btn:disabled { opacity: 0.45; cursor: default; }',
      '.mv-msg { font-size: 12px; line-height: 1.6; opacity: 0.85; margin: 0; }',
      '.mv-sub { font-size: 11px; opacity: 0.6; margin: 0; }',
      '.mv-bad { color: rgb(226,96,96); opacity: 1; }',
      '.mv-good { color: rgb(60,170,110); opacity: 1; }',
      '.mv-warn { color: rgb(210,160,60); opacity: 1; }',
      '.mv-row { display: flex; gap: 8px; font-size: 12px; line-height: 1.7; padding-left: 2px; }',
      '.mv-id { font-family: ui-monospace, Consolas, monospace; opacity: 0.85; word-break: break-all; }',
      '.mv-more { font: inherit; font-size: 11px; background: 0 0; border: none; color: inherit; opacity: 0.6; cursor: pointer; text-decoration: underline; padding: 0; }',
      '.mv-page { display: flex; flex-direction: column; gap: 12px; padding: 4px 0 28px; max-width: 860px; }',
      '.mv-lede { font-size: 13px; line-height: 1.7; opacity: 0.78; margin: 0; }',
    ].join('\n')

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.textContent = CSS
      document.head.appendChild(element)
    }

    /**
     * The one action this bundle performs.
     *
     * States: idle → running → done | error. `done` keeps the host's report
     * verbatim, so unknown fields from a newer host are simply ignored.
     *
     * @returns `{ state, run }`.
     */
    function useDetect() {
      const [state, setState] = React.useState({ phase: 'idle' })
      const run = React.useCallback(async () => {
        setState({ phase: 'running' })
        try {
          const response = await fetch(CONTRACT.rpcPath, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [CONTRACT.rpcHeader]: String(CONTRACT.protocol) },
            body: '{}',
          })
          const body = await response.json().catch(() => ({}))
          if (response.status === 404) {
            // The host half is versioned separately from this bundle: a stale
            // install, or a DSH that refused to mount the route.
            setState({ phase: 'error', error: '后台服务没响应。重启一次 DSH 再试；还不行就是插件版本和 DSH 不匹配。' })
            return
          }
          if (!response.ok || body.ok !== true) {
            setState({ phase: 'error', error: body.error ?? ('HTTP ' + response.status) })
            return
          }
          setState({ phase: 'done', report: body })
        } catch (error) {
          setState({ phase: 'error', error: '连不上本机服务：' + (error && error.message ? error.message : String(error)) })
        }
      }, [])
      return { state, run }
    }

    /** Flatten every route's result into one list of plain lines. */
    function flatten(report) {
      const rows = []
      for (const route of report.routes ?? []) {
        for (const item of route.changes ?? []) {
          // A name-only change means the declaration was already right and only
          // the picker marker was added — worth saying differently.
          const label = item.inputChanged === false && item.badge === true ? '名字加了「可看图」' : '已补上「图片」'
          rows.push({ tone: 'mv-good', label, id: item.id })
        }
        for (const item of route.held ?? []) rows.push({ tone: 'mv-warn', label: '你写的是纯文字，没动', id: item.id })
        for (const item of route.probedModels ?? []) {
          rows.push({ tone: 'mv-sub', label: item.vision ? '实测能看图' : '实测只能读文字', id: item.id })
        }
        // A budget cut is not a verdict: say so, or the missing models look like
        // the plugin simply forgot them.
        if (route.probeSkipped > 0) {
          rows.push({ tone: 'mv-sub', label: '超出上限跳过 ' + route.probeSkipped + ' 个，再点一次会接着测', id: '' })
        }
        if (route.probeUnknown > 0) {
          rows.push({ tone: 'mv-sub', label: route.probeUnknown + ' 个没问出结论（答非所问），没写声明', id: '' })
        }
        if (route.error) rows.push({ tone: 'mv-bad', label: '这一家的网关没连上：', id: String(route.error) })
      }
      return rows
    }

    /**
     * The button, its one-line answer, and an optional detail list.
     *
     * @param props - `compact` renders the version used inside the settings page
     *   fallback (adds the explanatory paragraph when true).
     */
    function VisionAction(props) {
      ensureStyles()
      const { state, run } = useDetect()
      const [expanded, setExpanded] = React.useState(false)
      const report = state.report
      const rows = report === undefined ? [] : flatten(report)
      const running = state.phase === 'running'

      return React.createElement('div', { className: props.wrapClass ?? 'mv-inline' },
        props.lede === true
          ? React.createElement('p', { className: 'mv-lede' },
            '有些模型能看图，但 DSH 拉模型清单时没记下这条，于是贴图会被拒。点一下这里，它会把你',
            React.createElement('strong', null, '已经配好的模型'),
            '检查一遍：网关说了能力的照它写，没说的就发两张纯色图去问，然后把能看图的标出来（名字后面加「· 可看图」）。不动你的勾选，也不动别的设置。')
          : null,
        React.createElement('div', { className: 'mv-actions' },
          React.createElement('button', {
            className: 'mv-btn',
            disabled: running,
            onClick: run,
            title: '网关自己写了能力的就照它写；没写的会发两张纯色图去问。只改「输入类型」和模型名末尾的「· 可看图」，不碰别的设置，只跟你填的那个 API 地址通信。',
          }, running ? '正在检测…' : '检测并补充视觉能力'),
          React.createElement('span', { className: 'mv-sub' }, running
            ? '正在问网关；它没写能力的模型要各发两张小图，稍等一下'
            : '会补「输入类型：图片」，并在模型名后加「· 可看图」；不动你的勾选')),
        state.phase === 'error'
          ? React.createElement('p', { className: 'mv-msg mv-bad' }, state.error)
          : null,
        state.phase === 'done' && report !== undefined
          ? React.createElement('p', { className: 'mv-msg' + (report.error ? ' mv-bad' : '') }, report.message)
          : null,
        state.phase === 'done' && report !== undefined && report.dryRun === true
          ? React.createElement('p', { className: 'mv-sub' }, '当前是「只看不写」模式，没有改动文件。')
          : null,
        rows.length > 0
          ? React.createElement('button', { className: 'mv-more', onClick: () => setExpanded(!expanded) },
            expanded ? '收起明细' : '展开明细（' + rows.length + ' 条）')
          : null,
        expanded
          ? React.createElement('div', { style: { width: '100%' } },
            rows.map((row, index) => React.createElement('div', { className: 'mv-row', key: row.id + index },
              React.createElement('span', { className: row.tone }, row.label),
              React.createElement('span', { className: 'mv-id' }, row.id))))
          : null)
    }

    /** The compatibility fallback: the same action as a settings page. */
    function VisionPage() {
      ensureStyles()
      return React.createElement('div', { className: 'mv-page' },
        React.createElement(VisionAction, { wrapClass: 'mv-page', lede: true }))
    }

    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      ensureStyles()
      if (ctx === undefined || ctx.slots === undefined || typeof ctx.slots.register !== 'function') return

      let mounted = false
      const mountInFooter = () => {
        mounted = true
        return ctx.slots.register(
          { name: CONTRACT.slot, id: CONTRACT.slotId, order: 20 },
          VisionAction,
        )
      }
      const mountAsPage = () => {
        if (mounted) return undefined
        return ctx.slots.register(
          { name: CONTRACT.fallbackSlot, id: CONTRACT.slotId, order: 19, label: '视觉能力' },
          VisionPage,
        )
      }

      // Waits for the owning page to declare the slot; runs when it appears.
      ctx.slots.inject(CONTRACT.slot, mountInFooter)

      // Cross-version safety net: a release that renames or drops the footer
      // slot would otherwise make the plugin silently vanish from the UI.
      if (typeof setTimeout === 'function') {
        const timer = setTimeout(() => {
          if (mounted) return
          ctx.slots.inject(CONTRACT.fallbackSlot, mountAsPage)
        }, CONTRACT.fallbackWaitMs)
        if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
      }
    }

    return module.exports
  },
})
