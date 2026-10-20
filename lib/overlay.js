/**
 * dsh-lens — injected overlay.
 *
 * Runs INSIDE the previewed app document, on its own loopback preview origin.
 * Owns everything the user touches: element picking, the drag-a-box region
 * selection, the live style panel, the comment card, the pins, and the
 * "Ctrl+click means write it and ship it" gesture.
 *
 * Two rules shape the code:
 *
 *  1. **A clean page is a feature.** All interaction listeners are bound through
 *     one AbortController that is aborted when annotation mode ends; the layer
 *     leaves the DOM entirely; every inline style this overlay wrote is put back
 *     the way it was. While idle the only global listener left is the panel's
 *     control channel.
 *  2. **The panel owns the review, this file owns the page.** They talk over
 *     postMessage only, addressed to the harness origin. Nothing here imports
 *     React or reaches across the frame boundary.
 *
 * Everything is wrapped defensively: a broken overlay must never break the app.
 */
;(function () {
  'use strict'

  var cfg = window.__DSH_LENS__
  if (!cfg || !cfg.isolated) return
  if (window.__dshLensReady) return
  window.__dshLensReady = true

  var CHANNEL = 'dsh-lens-overlay'
  var HOST = 'dsh-lens-panel'
  var STORE_PREFIX = 'dsh-lens:v1:'
  var MARKER = '#f0a05a'
  var session = String(window.__DSH_LENS_SESSION__ || 'standalone')
  var currentPage = location.pathname + location.search + location.hash

  var state = {
    mode: 'idle', // 'idle' | 'picking' | 'writing'
    hover: null,
    selected: null,
    drafting: null, // { id, kind, detail, comment, styleFrom }
    viewing: null, // id of the annotation whose card is open
    sendOnCommit: false,
    annotations: [],
    anchor: null,
    busy: false,
    box: null, // { x0, y0, x1, y1 } while dragging
    region: null, // pending region selection while dragging
  }

  // Inline styles this overlay applied, so every one of them can be put back.
  var previews = new Map() // key `${annId}:${prop}` -> { el, prop, original, value }
  var controller = null
  var historyPatched = null

  // --------------------------------------------------------------- utilities

  function isDark() {
    try {
      var bg = getComputedStyle(document.body).backgroundColor || ''
      var match = bg.match(/rgba?\(([^)]+)\)/)
      if (!match) return true
      var parts = match[1].split(',').map(Number)
      var luminance = (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255
      var alpha = parts.length > 3 ? parts[3] : 1
      if (alpha < 0.2) return true
      return luminance < 0.5
    } catch (error) {
      return true
    }
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
    })
  }

  function clip(text, max) {
    var value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
    return value.length > max ? value.slice(0, max - 1) + '…' : value
  }

  function css() {
    var dark = isDark()
    var ink = dark ? '#f2f3f5' : '#16181d'
    var muted = dark ? 'rgba(242,243,245,.62)' : 'rgba(22,24,29,.58)'
    var panelBg = dark ? 'rgba(20,22,27,.92)' : 'rgba(252,252,253,.95)'
    var hair = dark ? 'rgba(255,255,255,.16)' : 'rgba(16,18,22,.14)'
    var fieldBg = dark ? 'rgba(255,255,255,.06)' : 'rgba(16,18,22,.04)'
    return [
      // Viewport-fixed: apps often scroll an inner container, where document
      // coordinates never change and absolutely-placed pins would sit still.
      '.dl-layer{position:fixed;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;overflow:visible;background:transparent;z-index:2147483000;pointer-events:none;',
      'font:12px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:' + ink + '}',
      '.dl-layer *{box-sizing:border-box}.dl-layer::backdrop{display:none}',
      '.dl-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}',
      'html[data-dl-mode] body,html[data-dl-mode] body *{cursor:crosshair!important}',
      // measurement frame
      '.dl-frame{position:absolute;z-index:3;pointer-events:none;border:1px solid ' + MARKER + ';',
      'background:color-mix(in srgb,' + MARKER + ' 8%,transparent);transition:opacity .12s ease}',
      '.dl-frame[data-state="hover"]{border-style:dashed;opacity:.85}',
      '.dl-frame i{position:absolute;width:7px;height:7px;border:1px solid ' + MARKER + ';background:' + panelBg + '}',
      '.dl-frame i:nth-child(1){left:-4px;top:-4px}.dl-frame i:nth-child(2){right:-4px;top:-4px}',
      '.dl-frame i:nth-child(3){left:-4px;bottom:-4px}.dl-frame i:nth-child(4){right:-4px;bottom:-4px}',
      // the drag box and the stored region outline
      '.dl-box{position:absolute;z-index:4;pointer-events:none;border:1px dashed ' + MARKER + ';',
      'background:color-mix(in srgb,' + MARKER + ' 12%,transparent);border-radius:2px}',
      '.dl-region{position:absolute;z-index:2;pointer-events:none;border:1px dashed color-mix(in srgb,' + MARKER + ' 70%,transparent);',
      'background:color-mix(in srgb,' + MARKER + ' 5%,transparent);border-radius:3px}',
      '.dl-region b{position:absolute;left:-1px;top:-17px;padding:0 4px;border-radius:3px;background:' + MARKER + ';color:#20160c;',
      'font:600 9px/14px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}',
      // hover readout
      '.dl-readout{position:absolute;z-index:6;pointer-events:none;display:flex;gap:8px;align-items:center;',
      'padding:3px 7px;border:1px solid ' + hair + ';border-radius:3px;background:' + panelBg + ';',
      'box-shadow:0 6px 20px -12px rgba(0,0,0,.6);white-space:nowrap;max-width:min(560px,80vw);overflow:hidden}',
      '.dl-readout b{color:' + MARKER + ';font-weight:600}',
      '.dl-readout span{color:' + muted + '}',
      // pins
      '.dl-pin{appearance:none;padding:0;min-width:0;min-height:0;max-width:none;max-height:none;display:block;position:absolute;z-index:5;pointer-events:auto;width:20px;height:20px;margin:-10px 0 0 -10px;',
      'border-radius:50%;background:' + MARKER + ';color:#20160c;border:1.5px solid ' + panelBg + ';',
      'font:600 11px/17px ui-monospace,SFMono-Regular,Menlo,monospace;text-align:center;cursor:pointer;',
      'box-shadow:0 2px 10px -2px rgba(0,0,0,.55);transform-origin:center;',
      'animation:dl-pop .18s cubic-bezier(.2,1.4,.4,1)}',
      '.dl-pin:hover{transform:scale(1.14)}.dl-pin[hidden]{display:none!important}.dl-pin:focus-visible{outline:2px solid ' + ink + ';outline-offset:3px}',
      '.dl-pin[data-status="done"]{background:' + panelBg + ';color:' + MARKER + ';border-color:' + MARKER + '}',
      '.dl-layer button:focus-visible{outline:2px solid ' + MARKER + ';outline-offset:2px}',
      '.dl-pin[data-open="true"]{outline:2px solid color-mix(in srgb,' + MARKER + ' 45%,transparent);outline-offset:2px}',
      '@keyframes dl-pop{from{transform:scale(.4);opacity:0}to{transform:scale(1);opacity:1}}',
      // comment + style card
      '.dl-card{position:absolute;z-index:8;width:min(360px,calc(100vw - 16px));max-height:min(78vh,640px);overflow:auto;pointer-events:auto;color:' + ink + ';',
      'background:' + panelBg + ';border:1px solid ' + hair + ';border-radius:12px;',
      'box-shadow:0 24px 60px -28px rgba(0,0,0,.7);backdrop-filter:blur(18px) saturate(160%);',
      'border-left:3px solid ' + MARKER + ';animation:dl-rise .16s ease-out}',
      '@keyframes dl-rise{from{transform:translateY(4px);opacity:0}to{transform:none;opacity:1}}',
      '.dl-card header{display:flex;align-items:center;gap:8px;padding:7px 8px 7px 10px;border-bottom:1px solid ' + hair + '}',
      '.dl-card header .dl-tag{flex:none;color:' + MARKER + ';font-weight:600}',
      '.dl-card header .dl-clip{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' + muted + '}',
      '.dl-card header button{all:unset;cursor:pointer;width:20px;height:20px;line-height:18px;text-align:center;border-radius:4px;color:' + muted + '}',
      '.dl-card header button:hover{background:' + fieldBg + ';color:' + ink + '}',
      '.dl-card textarea{display:block;width:100%;min-height:58px;max-height:200px;resize:vertical;border:0;outline:none;',
      'padding:9px 10px;background:transparent;color:inherit;font:inherit;font-size:12.5px}',
      '.dl-comment-text{padding:12px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px}',
      '.dl-hintbar{margin:0 10px 8px;padding:8px 10px;border-radius:8px;font-size:11.5px;line-height:1.55;',
      'color:' + MARKER + ';background:color-mix(in srgb,' + MARKER + ' 12%,transparent);border:1px solid color-mix(in srgb,' + MARKER + ' 30%,transparent)}',
      // style panel
      '.dl-styles{padding:2px 10px 8px;border-top:1px solid ' + hair + '}',
      '.dl-styles[data-open="false"]{display:none}',
      '.dl-btn[data-on="true"]{border-color:' + MARKER + ';color:' + MARKER + '}',
      '.dl-styles h5{display:flex;align-items:center;gap:6px;margin:8px 0 6px;color:' + muted + ';',
      'font:600 9.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase}',
      '.dl-styles h5 button{all:unset;margin-left:auto;cursor:pointer;font-size:10px;color:' + MARKER + ';text-transform:none;letter-spacing:0}',
      '.dl-styles h5 button:hover{text-decoration:underline}',
      '.dl-srow{display:grid;grid-template-columns:64px 1fr;gap:6px;align-items:center;margin-bottom:5px}',
      '.dl-srow label{color:' + muted + ';font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis}',
      '.dl-srow .dl-from{position:relative;display:flex;align-items:center;gap:4px;min-width:0}',
      '.dl-srow .dl-arrow{flex:none;color:' + muted + ';font-size:10px}',
      '.dl-srow input{flex:1;min-width:0;height:24px;padding:0 6px;border-radius:4px;outline:none;color:inherit;',
      'background:' + fieldBg + ';border:1px solid ' + hair + ';font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.dl-srow input:focus{border-color:' + MARKER + '}',
      '.dl-srow input[data-edited="true"]{border-color:color-mix(in srgb,' + MARKER + ' 60%,transparent);color:' + MARKER + '}',
      '.dl-swatch{flex:none;width:24px;height:24px;padding:0;border:1px solid ' + hair + ';border-radius:4px;background:transparent;cursor:pointer}',
      '.dl-card footer{display:flex;align-items:center;gap:8px;padding:6px 8px 8px 10px;border-top:1px solid ' + hair + '}',
      '.dl-card footer .dl-hint{flex:1;color:' + muted + ';font-size:10.5px}',
      '.dl-btn{all:unset;cursor:pointer;padding:4px 10px;border-radius:4px;border:1px solid ' + hair + ';font-size:11.5px;white-space:nowrap}',
      '.dl-btn:hover{border-color:' + MARKER + ';color:' + MARKER + '}',
      '.dl-btn.primary{background:' + MARKER + ';border-color:transparent;color:#20160c;font-weight:600}',
      '.dl-btn.primary:hover{opacity:.88;color:#20160c}',
      '.dl-btn.ghost{border-color:transparent;color:' + muted + '}',
      '@media(prefers-reduced-motion:reduce){.dl-layer *{animation:none!important;transition:none!important}}',
    ].join('')
  }

  /** Short, stable, human-readable path: body > main > section.hero > button.cta */
  function selectorOf(el) {
    var parts = []
    var node = el
    var guard = 0
    while (node && node.nodeType === 1 && node !== document.documentElement && guard++ < 12) {
      var tag = node.tagName.toLowerCase()
      if (node.id) {
        parts.unshift(tag + '#' + CSS.escape(node.id))
        break
      }
      var classes = (node.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2)
      var sameTag = node.parentElement
        ? Array.prototype.filter.call(node.parentElement.children, function (child) {
            return child.tagName === node.tagName
          })
        : []
      var nth = sameTag.length > 1 ? ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')' : ''
      parts.unshift(tag + (classes.length ? '.' + classes.map(function (value) { return CSS.escape(value) }).join('.') : '') + nth)
      if (parts.length > 5) break
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  function selectorMatches(selector) {
    try {
      return document.querySelectorAll(selector).length
    } catch (error) {
      return -1
    }
  }

  function query(selector) {
    try {
      var matches = document.querySelectorAll(selector)
      return matches.length === 1 ? matches[0] : null
    } catch (error) {
      return null
    }
  }

  function testIdOf(el) {
    var attrs = ['data-testid', 'data-test', 'data-test-id', 'data-qa']
    for (var i = 0; i < attrs.length; i++) {
      var value = el.getAttribute && el.getAttribute(attrs[i])
      if (value) return attrs[i] + '=' + value
    }
    return null
  }

  /** Nearest React component name, when the app runs a dev build. */
  function componentChainOf(el) {
    var chain = []
    try {
      var key = Object.keys(el).filter(function (name) {
        return name.indexOf('__reactFiber$') === 0 || name.indexOf('__reactInternalInstance$') === 0
      })[0]
      if (!key) return chain
      var fiber = el[key]
      var guard = 0
      while (fiber && guard++ < 40 && chain.length < 3) {
        var type = fiber.type
        var name = typeof type === 'function' ? type.displayName || type.name : type && type.displayName
        if (name && !/^[a-z]/.test(name) && chain.indexOf(name) === -1) chain.push(name)
        fiber = fiber.return
      }
    } catch (error) {
      void error
    }
    return chain
  }

  function placementOf(rect) {
    var cx = (rect.left + rect.width / 2) / Math.max(1, window.innerWidth)
    var cy = (rect.top + rect.height / 2) / Math.max(1, window.innerHeight)
    var col = cx < 0.34 ? 'Left' : cx > 0.66 ? 'Right' : 'Center'
    var row = cy < 0.34 ? 'Top' : cy > 0.66 ? 'Bottom' : 'Middle'
    return { x: Math.round(cx * 100), y: Math.round(cy * 100), zone: row + col }
  }

  var STYLE_KEYS = ['display', 'position', 'gap', 'padding', 'margin', 'width', 'height',
    'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'border-radius',
    'border-width', 'box-shadow', 'opacity', 'z-index']

  function stylesOf(el) {
    var out = {}
    try {
      var computed = getComputedStyle(el)
      for (var i = 0; i < STYLE_KEYS.length; i++) {
        var value = computed.getPropertyValue(STYLE_KEYS[i])
        if (value && value !== 'none' && value !== 'normal' && value !== 'auto' && value !== '0px') {
          out[STYLE_KEYS[i]] = value
        }
      }
    } catch (error) {
      void error
    }
    return out
  }

  function detailOf(el) {
    var rect = el.getBoundingClientRect()
    var chain = componentChainOf(el)
    return {
      kind: 'element',
      selector: selectorOf(el),
      selectorMatches: selectorMatches(selectorOf(el)),
      testId: testIdOf(el),
      component: chain[0] || null,
      componentChain: chain,
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      ariaLabel: el.getAttribute('aria-label') || null,
      alt: el.getAttribute('alt') || null,
      name: el.getAttribute('name') || null,
      type: el.getAttribute('type') || null,
      tag: el.tagName.toLowerCase(),
      classes: (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 4),
      text: clip(el.textContent || '', 160),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      // Pins live in document space: mixing a viewport rect with the scroll
      // offset at render time makes them drift instead of following.
      doc: {
        x: Math.round(rect.x + window.scrollX),
        y: Math.round(rect.y + window.scrollY),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      placement: placementOf(rect),
      page: location.pathname + location.search,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      styles: stylesOf(el),
    }
  }

  // ------------------------------------------------------- region selection

  var SKIP_TAGS = /^(SCRIPT|STYLE|LINK|META|HEAD|TITLE|NOSCRIPT|BR|BODY|HTML)$/

  /** Every element whose centre falls inside the dragged box, most specific
   *  last: the region payload lists all of them, and marks the ones that only
   *  exist because they contain another match. */
  function elementsInBox(box) {
    var left = Math.min(box.x0, box.x1)
    var right = Math.max(box.x0, box.x1)
    var top = Math.min(box.y0, box.y1)
    var bottom = Math.max(box.y0, box.y1)
    var nodes = document.querySelectorAll('body *')
    var found = []
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      if (el === root || root.contains(el)) continue
      if (SKIP_TAGS.test(el.tagName)) continue
      // An inline SVG's shapes are drawing primitives, not UI elements: keep the
      // svg itself, leave its <path>/<circle>/<g> children out of the review.
      if (el.tagName.toLowerCase() !== 'svg' && el.parentElement && el.parentElement.closest('svg')) continue
      var rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      var cx = rect.left + rect.width / 2
      var cy = rect.top + rect.height / 2
      if (cx < left || cx > right || cy < top || cy > bottom) continue
      var style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
      found.push({ el: el, rect: rect })
    }
    return found
  }

  function regionDetail(box) {
    var found = elementsInBox(box)
    var elements = found.map(function (item) {
      var rect = item.rect
      return {
        tag: item.el.tagName.toLowerCase(),
        classes: (item.el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3),
        selector: selectorOf(item.el),
        text: clip(item.el.textContent || '', 80),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        container: false,
      }
    })
    // A container is in the list only because its children are; saying so keeps
    // the payload honest instead of listing a whole page of wrappers.
    for (var i = 0; i < found.length; i++) {
      for (var j = 0; j < found.length; j++) {
        if (i === j) continue
        if (found[i].el.contains(found[j].el)) {
          elements[i].container = true
          break
        }
      }
    }
    var left = Math.min(box.x0, box.x1)
    var top = Math.min(box.y0, box.y1)
    var rect = {
      x: Math.round(left),
      y: Math.round(top),
      w: Math.round(Math.abs(box.x1 - box.x0)),
      h: Math.round(Math.abs(box.y1 - box.y0)),
    }
    return {
      kind: 'region',
      tag: 'region',
      classes: [],
      selector: 'region(' + rect.w + '×' + rect.h + ' @ ' + rect.x + ',' + rect.y + ')',
      selectorMatches: elements.length,
      text: elements.filter(function (item) { return !item.container && item.text }).slice(0, 6)
        .map(function (item) { return item.tag + '「' + item.text + '」' }).join(' / '),
      rect: rect,
      doc: { x: Math.round(left + scrollX), y: Math.round(top + scrollY), w: rect.w, h: rect.h },
      elements: elements,
      count: elements.length,
      placement: placementOf({ left: left, top: top, width: rect.w, height: rect.h }),
      page: location.pathname + location.search,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      styles: {},
      styleEdits: [],
    }
  }

  // ------------------------------------------------------------- persistence
  function storeKey() {
    return STORE_PREFIX + encodeURIComponent(session) + ':' + currentPage
  }

  function load() {
    try {
      var raw = localStorage.getItem(storeKey())
      var list = raw ? JSON.parse(raw) : []
      return Array.isArray(list) ? list : []
    } catch (error) {
      return []
    }
  }

  function save() {
    try {
      localStorage.setItem(storeKey(), JSON.stringify(state.annotations))
    } catch (error) {
      post('warning', { message: '页面存储不可用，批注没有被保存到浏览器。' })
    }
  }

  // ---------------------------------------------------------------- style IO

  function applyPreview(annId, el, prop, value) {
    var key = annId + ':' + prop
    var entry = previews.get(key)
    if (!entry) {
      entry = { el: el, prop: prop, original: el.style.getPropertyValue(prop), value: '' }
      previews.set(key, entry)
    }
    entry.el = el
    entry.value = value
    el.style.setProperty(prop, value)
  }

  function dropPreview(key) {
    var entry = previews.get(key)
    if (!entry) return
    previews.delete(key)
    if (entry.original) entry.el.style.setProperty(entry.prop, entry.original)
    else entry.el.style.removeProperty(entry.prop)
  }

  function revertAllPreviews() {
    for (var key of [...previews.keys()]) dropPreview(key)
  }

  function applySavedPreviews() {
    state.annotations.forEach(function (ann) {
      if (!ann || !Array.isArray(ann.styleEdits)) return
      var el = elementFor(ann)
      if (!el) return
      ann.styleEdits.forEach(function (edit) {
        if (!edit || !edit.prop || !edit.to) return
        if (edit.from === edit.to) return
        applyPreview(ann.id, el, edit.prop, edit.to)
      })
    })
  }

  /** A region has no element to hang its card on: a rectangle is enough for the
   *  only thing the card asks of its anchor, which is where to sit. */
  function virtualAnchor(rect) {
    return {
      isConnected: true,
      getBoundingClientRect: function () {
        return {
          left: rect.x, top: rect.y, width: rect.w, height: rect.h,
          right: rect.x + rect.w, bottom: rect.y + rect.h, x: rect.x, y: rect.y,
        }
      },
    }
  }

  function regionAnchorOf(box) {
    return virtualAnchor({
      x: Math.round((box.x0 + box.x1) / 2),
      y: Math.round((box.y0 + box.y1) / 2),
      w: Math.abs(Math.round(box.x1 - box.x0)),
      h: Math.abs(Math.round(box.y1 - box.y0)),
    })
  }

  // ----------------------------------------------------------------- render

  var root = null
  var styleEl = null
  var pinLayer = null
  var regionLayer = null
  var frame = null
  var readout = null
  var dragBox = null
  var card = null
  var measurements = null

  function ensureMounted() {
    if (root) return
    root = document.createElement('div')
    root.className = 'dl-layer'
    root.setAttribute('data-dl-lens', '')
    styleEl = document.createElement('style')
    styleEl.setAttribute('data-dsh-lens', '')
    styleEl.textContent = css()
    pinLayer = document.createElement('div')
    regionLayer = document.createElement('div')
    frame = document.createElement('div')
    frame.className = 'dl-frame'
    frame.innerHTML = '<i></i><i></i><i></i><i></i>'
    readout = document.createElement('div')
    readout.className = 'dl-readout dl-mono'
    dragBox = document.createElement('div')
    dragBox.className = 'dl-box'
    dragBox.style.display = 'none'
    root.appendChild(styleEl)
    root.appendChild(regionLayer)
    root.appendChild(pinLayer)
    root.appendChild(frame)
    root.appendChild(readout)
    root.appendChild(dragBox)
    document.documentElement.appendChild(root)
    document.documentElement.setAttribute('data-dl-mode', state.mode)
    bindInteractions()
    applySavedPreviews()
    render()
    post('ready', { annotations: state.annotations, path: location.pathname })
  }

  function unmount() {
    if (!root) return
    revertAllPreviews()
    closeCard({ silent: true })
    state.hover = null
    state.selected = null
    state.region = null
    state.box = null
    if (controller) {
      controller.abort()
      controller = null
    }
    restoreHistory()
    document.documentElement.removeAttribute('data-dl-mode')
    if (root.parentNode) root.parentNode.removeChild(root)
    root = null
    styleEl = null
    pinLayer = null
    regionLayer = null
    frame = null
    readout = null
    dragBox = null
    card = null
  }

  function destroy() {
    destroyed = true
    unmount()
    window.removeEventListener('message', onHostMessage, false)
    try {
      delete window.__dshLensReady
    } catch (error) {
      window.__dshLensReady = false
    }
  }

  function withMeasurements(fn) {
    var previous = measurements
    measurements = previous || new WeakMap()
    try { return fn() } finally { measurements = previous }
  }

  function measurement(el) {
    if (!measurements) return {}
    var value = measurements.get(el)
    if (!value) { value = {}; measurements.set(el, value) }
    return value
  }

  function rectOf(el) {
    var value = measurement(el)
    if (!value.rect) value.rect = el.getBoundingClientRect()
    return value.rect
  }

  function setStyle(el, key, value) {
    if (el.style[key] !== value) el.style[key] = value
  }

  function render() {
    if (!root) return
    root.setAttribute('data-dark', isDark() ? '1' : '0')
    renderFrame()
    renderPins()
    renderRegions()
  }

  function framePosition() {
    var target = state.selected || state.hover
    if (!target || !target.isConnected) return null
    var visible = visibleRect(target)
    if (!visible) return null
    var rect = visible.rect
    var chain = componentChainOf(target)
    var content =
      '<b>' + esc(target.tagName.toLowerCase()) + '</b>' +
      (target.getAttribute('class') ? '<span>.' + esc(clip(target.getAttribute('class'), 28).split(' ')[0]) + '</span>' : '') +
      (chain[0] ? '<span>· ' + esc(chain[0]) + '</span>' : '') +
      '<span>· ' + Math.round(rect.width) + '×' + Math.round(rect.height) + '</span>'
    if (state.drafting && state.drafting.kind === 'region') {
      content = '<b>区域</b><span>· ' + (state.drafting.detail.count || 0) + ' 个元素</span>' +
        '<span>· ' + Math.round(Math.abs(state.box ? state.box.x1 - state.box.x0 : 0)) + '×' +
        Math.round(Math.abs(state.box ? state.box.y1 - state.box.y0 : 0)) + '</span>'
    }
    var top = rect.top - 26
    var left = Math.max(4, rect.left)
    if (top < 4) {
      if (window.innerWidth - rect.right > 240) {
        left = rect.right + 8
        top = rect.top - 2
      } else {
        top = rect.bottom + 6
      }
    }
    return { rect: rect, content: content, left: left, top: top, selected: !!state.selected }
  }

  function renderFrame(position) {
    if (arguments.length === 0) position = withMeasurements(framePosition)
    if (!frame) return
    if (!position) {
      setStyle(frame, 'display', 'none')
      setStyle(readout, 'display', 'none')
      return
    }
    var rect = position.rect
    var nextState = position.selected ? 'selected' : 'hover'
    if (frame.getAttribute('data-state') !== nextState) frame.setAttribute('data-state', nextState)
    setStyle(frame, 'display', 'block')
    setStyle(frame, 'left', rect.left + 'px')
    setStyle(frame, 'top', rect.top + 'px')
    setStyle(frame, 'width', rect.width + 'px')
    setStyle(frame, 'height', rect.height + 'px')
    setStyle(readout, 'display', 'flex')
    if (readout.innerHTML !== position.content) readout.innerHTML = position.content
    setStyle(readout, 'left', position.left + 'px')
    setStyle(readout, 'top', position.top + 'px')
  }

  function clippingBounds(node) {
    if (!node || node === document.documentElement) return { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
    var value = measurement(node)
    if (!value.bounds) {
      var bounds = Object.assign({}, clippingBounds(node.parentElement))
      var style = getComputedStyle(node)
      var clipsX = /(auto|scroll|hidden|clip)/.test(style.overflowX)
      var clipsY = /(auto|scroll|hidden|clip)/.test(style.overflowY)
      var box = clipsX || clipsY ? rectOf(node) : null
      if (clipsX) {
        bounds.left = Math.max(bounds.left, box.left)
        bounds.right = Math.min(bounds.right, box.right)
      }
      if (clipsY) {
        bounds.top = Math.max(bounds.top, box.top)
        bounds.bottom = Math.min(bounds.bottom, box.bottom)
      }
      value.bounds = bounds
    }
    return value.bounds
  }

  function visibleRect(el) {
    if (!el || !el.isConnected) return null
    var rect = rectOf(el)
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= innerHeight ||
        rect.right <= 0 || rect.left >= innerWidth) return null
    var bounds = clippingBounds(el.parentElement)
    if (rect.bottom <= bounds.top || rect.top >= bounds.bottom ||
        rect.right <= bounds.left || rect.left >= bounds.right) return null
    return { rect: rect, bounds: bounds }
  }

  /** The live element for one annotation. A selector that no longer matches a
   *  single element, or matches a different tag, is reported as gone instead of
   *  silently reattaching the note somewhere else. */
  function elementFor(ann) {
    if (!ann) return null
    if (ann.kind === 'region') return null
    var cached = liveElements.get(ann.id)
    if (cached && cached.isConnected) return cached
    var el = query(ann.selector)
    if (!el) return null
    if (ann.tag && el.tagName.toLowerCase() !== String(ann.tag).toLowerCase()) return null
    liveElements.set(ann.id, el)
    return el
  }

  var liveElements = new Map()

  function pinAnchor(ann) {
    if (ann.kind === 'region') {
      var doc = ann.doc || { x: 0, y: 0, w: 0, h: 0 }
      var x = doc.x - window.scrollX
      var y = doc.y - window.scrollY
      if (x + doc.w < 0 || y + doc.h < 0 || x > innerWidth || y > innerHeight) return null
      return { x: Math.max(10, Math.min(innerWidth - 10, x + doc.w / 2)), y: y }
    }
    var visible = visibleRect(elementFor(ann))
    if (!visible) return null
    var rect = visible.rect
    var bounds = visible.bounds
    if (rect.top < bounds.top || rect.top >= bounds.bottom) return null
    return { x: Math.max(bounds.left + 10, Math.min(bounds.right - 10, rect.left + rect.width / 2)), y: rect.top }
  }

  function positionPins(anchors) {
    state.annotations.forEach(function (ann, index) {
      var pin = pinLayer && pinLayer.children[index]
      if (!pin) return
      var anchor = anchors[index]
      if (pin.hidden !== !anchor) pin.hidden = !anchor
      if (anchor) {
        setStyle(pin, 'left', anchor.x + 'px')
        setStyle(pin, 'top', anchor.y + 'px')
      }
    })
  }

  function updatePositions() {
    withMeasurements(function () {
      var anchors = state.annotations.map(pinAnchor)
      var nextFrame = framePosition()
      var nextCard = cardPosition()
      positionPins(anchors)
      renderFrame(nextFrame)
      renderRegions()
      anchorCard(nextCard)
    })
  }

  function renderPins() {
    if (!pinLayer) return
    pinLayer.innerHTML = ''
    state.annotations.forEach(function (ann, index) {
      var pin = document.createElement('button')
      pin.type = 'button'
      pin.setAttribute('aria-label', '查看批注 ' + (index + 1) + '：' + (ann.comment || ''))
      pin.className = 'dl-pin'
      pin.textContent = String(index + 1)
      pin.title = ann.comment || ann.selector
      pin.setAttribute('data-status', ann.status === 'done' ? 'done' : 'open')
      var anchor = pinAnchor(ann)
      pin.hidden = !anchor
      if (anchor) {
        pin.style.left = anchor.x + 'px'
        pin.style.top = anchor.y + 'px'
      }
      pin.setAttribute('data-open', state.viewing === ann.id ? 'true' : 'false')
      pin.addEventListener('click', function (event) {
        event.stopPropagation()
        if (state.viewing === ann.id) { closeCard(); return }
        if (ann.kind === 'region') {
          showComment(ann, virtualAnchor(ann.doc || { x: 0, y: 0, w: 0, h: 0 }))
          post('focus', { id: ann.id })
          return
        }
        var el = elementFor(ann)
        if (!el) {
          post('missing', { id: ann.id })
          return
        }
        showComment(ann, el)
        post('focus', { id: ann.id })
      })
      pinLayer.appendChild(pin)
    })
    anchorCard()
  }

  function renderRegions() {
    if (!regionLayer) return
    regionLayer.innerHTML = ''
    // The box being drawn into a draft stays visible while the card is open, so
    // the user can see exactly what the region will cover.
    if (state.region) {
      var pending = document.createElement('div')
      pending.className = 'dl-region'
      pending.style.left = Math.min(state.region.x0, state.region.x1) + 'px'
      pending.style.top = Math.min(state.region.y0, state.region.y1) + 'px'
      pending.style.width = Math.abs(state.region.x1 - state.region.x0) + 'px'
      pending.style.height = Math.abs(state.region.y1 - state.region.y0) + 'px'
      var pendingLabel = document.createElement('b')
      pendingLabel.textContent = '新区域'
      pending.appendChild(pendingLabel)
      regionLayer.appendChild(pending)
    }
    state.annotations.forEach(function (ann, index) {
      if (ann.kind !== 'region' || !ann.doc) return
      var x = ann.doc.x - window.scrollX
      var y = ann.doc.y - window.scrollY
      if (x + ann.doc.w < 0 || y + ann.doc.h < 0 || x > innerWidth || y > innerHeight) return
      var node = document.createElement('div')
      node.className = 'dl-region'
      node.style.left = x + 'px'
      node.style.top = y + 'px'
      node.style.width = ann.doc.w + 'px'
      node.style.height = ann.doc.h + 'px'
      var label = document.createElement('b')
      label.textContent = '区域 ' + (index + 1) + (ann.count ? ' · ' + ann.count + ' 元素' : '')
      node.appendChild(label)
      regionLayer.appendChild(node)
    })
  }

  // ------------------------------------------------------------------ cards

  function cardPosition() {
    if (!card || !state.anchor || !state.anchor.isConnected) return null
    var rect = rectOf(state.anchor)
    var width = card.offsetWidth || 360
    var height = card.offsetHeight || 200
    var gap = 12
    var left
    if (window.innerWidth - rect.right >= width + gap) left = rect.right + gap
    else if (rect.left >= width + gap) left = rect.left - width - gap
    else left = Math.min(rect.left, window.innerWidth - width - 8)
    var top = rect.top
    if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - height - 8)
    return { left: Math.max(8, left), top: Math.max(8, top) }
  }

  function anchorCard(position) {
    if (arguments.length === 0) position = withMeasurements(cardPosition)
    if (!card || !position) return
    setStyle(card, 'left', position.left + 'px')
    setStyle(card, 'top', position.top + 'px')
  }

  var STYLE_FIELDS = [
    { prop: 'font-size', label: 'font-size' },
    { prop: 'color', label: 'color', color: true },
    { prop: 'padding', label: 'padding' },
    { prop: 'margin', label: 'margin' },
    { prop: 'line-height', label: 'line-height' },
    { prop: 'width', label: 'width' },
  ]

  function styleFieldValue(el, prop) {
    try {
      return getComputedStyle(el).getPropertyValue(prop)
    } catch (error) {
      return ''
    }
  }

  function openCard(draft, anchorEl) {
    // "Ctrl+click means write it and ship it" is decided by the pointer, and
    // closeCard() clears the flag it rides on, so keep it across the reset.
    var ship = state.sendOnCommit
    closeCard({ silent: true })
    state.sendOnCommit = ship
    state.drafting = draft
    state.mode = 'writing'
    state.anchor = anchorEl
    if (draft.kind === 'region') state.selected = null
    else state.selected = anchorEl
    document.documentElement.setAttribute('data-dl-mode', 'writing')
    post('mode', { mode: state.mode, count: state.annotations.length })

    var isRegion = draft.kind === 'region'
    var label = isRegion
      ? '区域 · ' + draft.detail.count + ' 个元素'
      : draft.detail.tag + (draft.detail.classes.length ? '.' + draft.detail.classes[0] : '')
    // A click on empty space lands on the page container, which makes a legal
    // but useless annotation ("the whole page"). Say so in the card instead of
    // silently recording it, and point at the gesture that means what they want.
    var containerHint = ''
    if (!isRegion) {
      var anchorTag = String((anchorEl.tagName || '')).toLowerCase()
      var anchorRect = anchorEl.getBoundingClientRect()
      var coverage = (anchorRect.width * anchorRect.height) / Math.max(1, window.innerWidth * window.innerHeight)
      if (anchorTag === 'main' || anchorTag === 'body' || anchorTag === 'html' || coverage >= 0.75) {
        containerHint = '<div class="dl-hintbar">你点到的是整页容器（' + esc(draft.detail.selector) +
          '）——想标某一块，按住 Shift 拖个框更准。</div>'
      }
    }
    card = document.createElement('div')
    card.className = 'dl-card'
    var styleSection = ''
    if (!isRegion) {
      styleSection = '<div class="dl-styles" data-open="false"><h5>样式 · 实时预览<button type="button" data-act="reset-styles">全部复原</button></h5>'
      STYLE_FIELDS.forEach(function (field) {
        styleSection +=
          '<div class="dl-srow" data-prop="' + field.prop + '">' +
          '<label title="' + field.prop + '">' + field.label + '</label>' +
          '<span class="dl-from"><input type="text" spellcheck="false" data-prop="' + field.prop + '" value="">' +
          (field.color ? '<input type="color" class="dl-swatch" data-prop="' + field.prop + '">' : '') +
          '</span></div>'
      })
      styleSection += '</div>'
    }
    card.innerHTML =
      '<header>' +
      '<span class="dl-tag dl-mono">' + esc(label) + '</span>' +
      '<span class="dl-clip dl-mono">' + esc(isRegion ? '框选区域' : draft.detail.selector) + '</span>' +
      '<button type="button" data-act="close" aria-label="关闭">✕</button>' +
      '</header>' +
      '<textarea placeholder="' + (isRegion ? '这块区域要改成什么样？（Shift+Enter 换行）' : '这个元素要改成什么样？（Shift+Enter 换行）') + '"></textarea>' +
      containerHint +
      styleSection +
      '<footer>' +
      (isRegion ? '' : '<button type="button" class="dl-btn ghost" data-act="styles" title="改样式并实时预览">⚙ 样式</button>') +
      '<span class="dl-hint">Enter 保存 · Esc 取消' + (state.sendOnCommit ? ' · 保存后立即发送' : '') + '</span>' +
      '<button type="button" class="dl-btn primary" data-act="save">' + (state.sendOnCommit ? '保存并发送' : '保存') + '</button>' +
      '</footer>'

    var area = card.querySelector('textarea')
    area.value = draft.comment || ''
    area.addEventListener('input', function () {
      draft.comment = area.value
      post('draft', { draft: { comment: area.value, selector: draft.detail.selector } })
    })
    card.querySelector('[data-act="close"]').addEventListener('click', function () { closeCard() })
    card.querySelector('[data-act="save"]').addEventListener('click', commit)
    // Codex parity: the card is a comment box first; style controls open from
    // the gear and stay closed until asked for.
    var stylesToggle = card.querySelector('[data-act="styles"]')
    var stylesBox = card.querySelector('.dl-styles')
    if (stylesToggle && stylesBox) {
      stylesToggle.addEventListener('click', function () {
        var open = stylesBox.getAttribute('data-open') === 'true'
        stylesBox.setAttribute('data-open', open ? 'false' : 'true')
        stylesToggle.setAttribute('data-on', open ? 'false' : 'true')
      })
    }
    var resetButtons = card.querySelectorAll('[data-act="reset-styles"], [data-act="reset-bottom"]')
    for (var index = 0; index < resetButtons.length; index++) {
      resetButtons[index].addEventListener('click', function () { resetDraftStyles() })
    }
    area.addEventListener('keydown', function (event) {
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        commit({ force: true })
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        commit()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setMode('idle')
      }
    })

    // Style controls: apply inline immediately, so the page itself is the
    // preview; the record of from->to is taken from the browser at save time.
    if (!isRegion) {
      STYLE_FIELDS.forEach(function (field) {
        var input = card.querySelector('input[type="text"][data-prop="' + field.prop + '"]')
        var from = styleFieldValue(anchorEl, field.prop)
        input.value = from
        input.dataset.from = from
        input.title = '原值 ' + from
        var apply = function () {
          var value = input.value.trim()
          if (!value) {
            input.removeAttribute('data-edited')
            dropPreview(draft.id + ':' + field.prop)
            input.value = input.dataset.from
            return
          }
          applyPreview(draft.id, anchorEl, field.prop, value)
          input.setAttribute('data-edited', value !== input.dataset.from ? 'true' : 'false')
          // A style change moves layout: pins and the measurement frame must
          // follow it in the same frame the page does.
          render()
        }
        input.addEventListener('input', apply)
        input.addEventListener('change', apply)
        input.addEventListener('keydown', function (event) {
          if (event.key === 'Escape') {
            event.stopPropagation()
            input.value = input.dataset.from
            apply()
            input.blur()
          }
        })
        var swatch = card.querySelector('input[type="color"][data-prop="' + field.prop + '"]')
        if (swatch) {
          var rgb = from.match(/rgba?\(([^)]+)\)/)
          if (rgb) {
            var parts = rgb[1].split(',').map(Number)
            var hex = '#' + [parts[0], parts[1], parts[2]].map(function (part) {
              return Math.max(0, Math.min(255, part)).toString(16).padStart(2, '0')
            }).join('')
            swatch.value = hex
          }
          swatch.addEventListener('input', function () {
            input.value = swatch.value
            apply()
          })
        }
      })
    }

    root.appendChild(card)
    anchorCard()
    setTimeout(function () { area.focus() }, 10)
    render()
  }

  function resetDraftStyles() {
    if (!card || !state.drafting || state.drafting.kind === 'region') return
    var draft = state.drafting
    for (var key of [...previews.keys()]) {
      if (key.indexOf(draft.id + ':') === 0) dropPreview(key)
    }
    var inputs = card.querySelectorAll('input[type="text"][data-prop]')
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].value = inputs[i].dataset.from || ''
      inputs[i].removeAttribute('data-edited')
    }
    var swatches = card.querySelectorAll('input[type="color"][data-prop]')
    for (var j = 0; j < swatches.length; j++) {
      var from = styleFieldValue(state.anchor, swatches[j].dataset.prop)
      var rgb = from.match(/rgba?\(([^)]+)\)/)
      if (rgb) {
        var parts = rgb[1].split(',').map(Number)
        swatches[j].value = '#' + [parts[0], parts[1], parts[2]].map(function (part) {
          return Math.max(0, Math.min(255, part)).toString(16).padStart(2, '0')
        }).join('')
      }
    }
  }

  function showComment(ann, el) {
    closeCard({ silent: true })
    state.viewing = ann.id
    state.anchor = el
    state.mode = 'writing'
    card = document.createElement('div')
    card.className = 'dl-card'
    var lines = []
    if (ann.kind === 'region') {
      lines.push('<div class="dl-comment-text">' + esc(ann.comment || '（无批注）') + '</div>')
      if (ann.elements && ann.elements.length) {
        lines.push('<div class="dl-styles"><h5>框内元素 · ' + ann.elements.length + '</h5>' +
          ann.elements.slice(0, 14).map(function (item) {
            return '<div class="dl-srow" style="grid-template-columns:1fr"><label style="color:inherit">' +
              esc(item.tag + (item.classes && item.classes.length ? '.' + item.classes[0] : '')) +
              ' <span style="color:inherit;opacity:.6">' + esc(item.text || '') + '</span></label></div>'
          }).join('') + '</div>')
      }
    } else {
      lines.push('<div class="dl-comment-text">' + esc(ann.comment || '（无批注）') + '</div>')
      if (ann.styleEdits && ann.styleEdits.length) {
        lines.push('<div class="dl-styles"><h5>样式修改</h5>' +
          ann.styleEdits.map(function (edit) {
            return '<div class="dl-srow" style="grid-template-columns:1fr"><label style="color:inherit">' +
              esc(edit.prop) + '：' + esc(edit.from) + ' → ' + esc(edit.to) + '</label></div>'
          }).join('') + '</div>')
      }
    }
    card.innerHTML =
      '<header>' +
      '<span class="dl-tag dl-mono">' + esc(ann.kind === 'region' ? '区域' : (ann.tag || 'element')) + '</span>' +
      '<span class="dl-clip dl-mono">' + esc(ann.selector) + '</span>' +
      '<button type="button" data-act="close" aria-label="关闭">✕</button>' +
      '</header>' + lines.join('')
    card.querySelector('[data-act="close"]').addEventListener('click', function () { closeCard() })
    root.appendChild(card)
    renderPins()
    anchorCard()
  }

  function closeCard(options) {
    var silent = options && options.silent
    if (card && card.parentNode) card.parentNode.removeChild(card)
    card = null
    state.drafting = null
    state.viewing = null
    state.anchor = null
    state.region = null
    state.selected = null
    state.sendOnCommit = false
    // A cancelled card returns to picking; the caller that is leaving annotation
    // mode entirely sets the mode itself, which is what `silent` marks.
    if (!silent && state.mode === 'writing') state.mode = 'picking'
    if (root) render()
    if (!silent) post('mode', { mode: state.mode, count: state.annotations.length })
  }

  function commit(options) {
    if (!card || !state.drafting || !state.anchor) return
    var force = !!(options && options.force)
    var area = card.querySelector('textarea')
    var text = area ? area.value.trim() : ''
    if (!text && !force && !state.sendOnCommit) {
      closeCard()
      return
    }
    var draft = state.drafting
    var detail
    if (draft.kind === 'region') {
      detail = draft.detail
    } else {
      detail = detailOf(state.anchor)
      // Only the properties the user actually touched count as an edit. Other
      // computed values move on their own when one of them changes (a smaller
      // font-size drags line-height with it), and reporting those would invent
      // instructions nobody wrote.
      var editedProps = new Set()
      for (var key of previews.keys()) {
        if (key.indexOf(draft.id + ':') === 0) editedProps.add(key.slice(draft.id.length + 1))
      }
      var edits = []
      STYLE_FIELDS.forEach(function (field) {
        if (!editedProps.has(field.prop)) return
        var to = styleFieldValue(state.anchor, field.prop)
        var from = draft.styleFrom ? draft.styleFrom[field.prop] : ''
        if (!to || !from || to === from) return
        edits.push({ prop: field.prop, from: from, to: to })
      })
      detail.kind = 'element'
      detail.styleEdits = edits
    }
    var record = Object.assign({}, detail, {
      id: draft.id,
      comment: text,
      status: 'open',
      createdAt: Date.now(),
    })
    state.annotations = state.annotations.concat([record])
    if (draft.kind !== 'region') liveElements.set(draft.id, state.anchor)
    state.region = null
    save()
    var ship = state.sendOnCommit
    state.sendOnCommit = false
    closeCard({ silent: true })
    setMode('picking')
    renderPins()
    post('changed', { annotations: state.annotations })
    if (ship) post('send', { annotations: [record] })
  }

  // ---------------------------------------------------------------- picking

  function elementAt(x, y) {
    var el = document.elementFromPoint(x, y)
    if (!el || root && (el === root || root.contains(el))) return null
    return el
  }

  var drag = null
  var suppressClick = false

  function isAppEvent(event) {
    if (!root) return false
    var target = event.target
    // A synthetic event may target the window itself; only a Node can be
    // tested for containment.
    if (!target || !target.nodeType) return true
    return !root.contains(target)
  }

  function onPointerDown(event) {
    if (state.mode !== 'picking') return
    if (event.button !== 0) return
    if (!isAppEvent(event)) return
    var el = elementAt(event.clientX, event.clientY)
    if (!el) return
    drag = {
      x0: event.clientX,
      y0: event.clientY,
      x1: event.clientX,
      y1: event.clientY,
      ctrl: Boolean(event.ctrlKey || event.metaKey),
      shift: Boolean(event.shiftKey),
      moved: false,
      element: el,
    }
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function onPointerMove(event) {
    if (state.mode !== 'picking') return
    if (!isAppEvent(event)) return
    if (!drag) {
      // Hover frame: only while picking, and only over the app.
      var el = elementAt(event.clientX, event.clientY)
      if (el === state.hover) return
      state.hover = el
      render()
      return
    }
    drag.x1 = event.clientX
    drag.y1 = event.clientY
    var dx = Math.abs(drag.x1 - drag.x0)
    var dy = Math.abs(drag.y1 - drag.y0)
    if (!drag.moved && Math.max(dx, dy) > 6) {
      drag.moved = true
      state.hover = null
    }
    if (drag.moved) {
      event.preventDefault()
      event.stopImmediatePropagation()
      // Codex parity: an area belongs to Shift. A plain drag is not an
      // annotation gesture, so it can never swallow a drag the page itself uses.
      if (drag.shift) {
        state.box = drag
        renderDragBox()
        showBoxReadout(drag, elementsInBox(drag).length)
      }
    }
  }

  /** A Shift+click is an area too: the element's own rectangle. That is the
   *  documented gesture ("hold Shift and click to select an area"), and it is
   *  the smallest area that still means something. */
  function areaOfClick(clicked) {
    if (!clicked) return null
    var rect = clicked.getBoundingClientRect()
    return { x0: rect.left, y0: rect.top, x1: rect.right, y1: rect.bottom, moved: true }
  }

  function onPointerUp(event) {
    if (state.mode !== 'picking' || !drag) return
    var current = drag
    drag = null
    event.preventDefault()
    event.stopImmediatePropagation()
    suppressClick = true
    // The click that follows a real pointerup arrives in the same task; this
    // guard only survives for a moment so a synthetic pointer sequence (a test,
    // an automated click) cannot leave the next real click swallowed.
    setTimeout(function () { suppressClick = false }, 400)

    if (current.shift) {
      var box = current.moved ? current : areaOfClick(current.element)
      if (!box) return
      state.box = null
      hideDragBox()
      state.region = box
      state.sendOnCommit = current.ctrl
      openCard({
        id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        kind: 'region',
        detail: regionDetail(box),
        comment: '',
      }, regionAnchorOf(box))
      return
    }
    if (current.moved) {
      // A plain drag is not an annotation gesture; leave the page alone.
      state.box = null
      hideDragBox()
      render()
      return
    }
    var el = elementAt(current.x1, current.y1)
    if (!el) return
    state.selected = el
    state.hover = null
    state.sendOnCommit = current.ctrl
    var detail = detailOf(el)
    var styleFrom = {}
    STYLE_FIELDS.forEach(function (field) { styleFrom[field.prop] = styleFieldValue(el, field.prop) })
    openCard({
      id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      kind: 'element',
      detail: detail,
      comment: '',
      styleFrom: styleFrom,
    }, el)
  }

  function onClickSuppress(event) {
    if (!suppressClick) return
    suppressClick = false
    if (!isAppEvent(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function renderDragBox() {
    if (!dragBox || !state.box) return
    var box = state.box
    setStyle(dragBox, 'display', 'block')
    setStyle(dragBox, 'left', Math.min(box.x0, box.x1) + 'px')
    setStyle(dragBox, 'top', Math.min(box.y0, box.y1) + 'px')
    setStyle(dragBox, 'width', Math.abs(box.x1 - box.x0) + 'px')
    setStyle(dragBox, 'height', Math.abs(box.y1 - box.y0) + 'px')
  }

  function hideDragBox() {
    if (dragBox) setStyle(dragBox, 'display', 'none')
  }

  function showBoxReadout(box, count) {
    if (!readout) return
    var width = Math.abs(box.x1 - box.x0)
    var height = Math.abs(box.y1 - box.y0)
    var content = '<b>框选</b><span>· ' + Math.round(width) + '×' + Math.round(height) + '</span><span>· ' + count + ' 个元素</span>'
    if (readout.innerHTML !== content) readout.innerHTML = content
    setStyle(readout, 'display', 'flex')
    setStyle(readout, 'left', Math.min(box.x0, box.x1) + 'px')
    setStyle(readout, 'top', Math.max(2, Math.min(box.y0, box.y1) - 24) + 'px')
    setStyle(frame, 'display', 'none')
  }

  function onHover(event) {
    if (state.mode !== 'picking' || drag) return
    if (!isAppEvent(event)) return
    var el = elementAt(event.clientX, event.clientY)
    if (el === state.hover) return
    state.hover = el
    render()
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      if (state.mode === 'writing') {
        event.preventDefault()
        event.stopImmediatePropagation()
        setMode('idle')
      } else if (state.mode === 'picking') {
        setMode('idle')
      }
    }
  }

  function onContextMenu(event) {
    if (state.mode === 'idle' || !isAppEvent(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    setMode('idle')
  }

  function onViewportChange() {
    viewportChanged = true
  }

  function onResize() {
    if (root) render()
  }

  var viewportChanged = false

  function setMode(mode) {
    state.mode = mode
    state.sendOnCommit = false
    if (mode === 'idle') {
      closeCard({ silent: true })
      unmount()
    } else {
      ensureMounted()
      document.documentElement.setAttribute('data-dl-mode', mode)
      render()
    }
    post('mode', { mode: state.mode, count: state.annotations.length })
  }

  // --------------------------------------------------------------- messages

  function post(type, payload) {
    var target = cfg.parentOrigin
    if (!target) return
    try {
      var stateFn = window.__dshLensState
      parent.postMessage(Object.assign({
        source: CHANNEL,
        type: type,
        url: stateFn ? stateFn().url : location.href,
        viewport: { w: window.innerWidth, h: window.innerHeight },
      }, payload || {}), target)
    } catch (error) {
      void error
    }
  }

  function onHostMessage(event) {
    if (event.source !== parent || event.origin !== cfg.parentOrigin) return
    var data = event.data
    if (!data || data.source !== HOST) return
    handleHostMessage(data)
  }

  function handleHostMessage(data) {
    if (data.type === 'busy') { state.busy = data.value; return }
    if (data.type === 'destroy') { destroy(); return }
    if (data.type === 'restore') {
      state.annotations = Array.isArray(data.annotations) ? data.annotations : []
      liveElements.clear()
      save()
      if (root) { render(); applySavedPreviews() }
      return
    }
    if (data.type === 'ping') {
      post('ready', { annotations: state.annotations, path: location.pathname })
      return
    }
    if (data.type === 'navigate') { history.go(data.delta); return }
    if (data.type === 'reload') { location.reload(); return }
    if (data.type === 'toggle-mode') {
      setMode(state.mode === 'idle' ? 'picking' : 'idle')
      return
    }
    if (data.type === 'set-mode') { setMode(data.mode); return }
    if (data.type === 'reset-styles') { revertAllPreviews(); return }
    if (data.type === 'update') {
      state.annotations = Array.isArray(data.annotations) ? data.annotations : state.annotations
      save()
      if (root) render()
      return
    }
    if (data.type === 'focus') {
      var ann = state.annotations.filter(function (item) { return item.id === data.id })[0]
      if (!ann) return
      if (state.mode === 'idle') setMode('picking')
      var el = elementFor(ann)
      if (!el) {
        if (ann.kind === 'region' && ann.doc) {
          window.scrollTo({ left: Math.max(0, ann.doc.x - innerWidth / 2), top: Math.max(0, ann.doc.y - innerHeight / 2), behavior: 'smooth' })
        } else {
          post('warning', { message: '原元素已变化或消失，批注仍然保留。' })
        }
        return
      }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      state.selected = el
      renderFrame()
      return
    }
    if (data.type === 'remove') {
      state.annotations = state.annotations.filter(function (item) { return item.id !== data.id })
      save()
      if (root) { renderPins(); renderRegions() }
      post('changed', { annotations: state.annotations })
      return
    }
    if (data.type === 'clear') {
      var removed = new Set(data.ids || state.annotations.map(function (item) { return item.id }))
      state.annotations = state.annotations.filter(function (item) { return !removed.has(item.id) })
      for (var key of [...previews.keys()]) {
        var annId = key.slice(0, key.indexOf(':'))
        if (removed.has(annId)) dropPreview(key)
      }
      save()
      if (root) { renderPins(); renderRegions() }
      post('changed', { annotations: state.annotations })
      return
    }
    if (data.type === 'status') {
      state.annotations = state.annotations.map(function (item) {
        return item.id === data.id ? Object.assign({}, item, { status: data.status }) : item
      })
      save()
      if (root) renderPins()
      post('changed', { annotations: state.annotations })
    }
  }

  // ---------------------------------------------------------- page tracking

  function changePage() {
    var next = location.pathname + location.search + location.hash
    if (next === currentPage) return
    // Annotation mode belongs to the review, not to one route: walking to the
    // next page keeps the pen in hand, exactly like an SPA route change.
    var keepPicking = state.mode === 'picking'
    save()
    closeCard({ silent: true })
    currentPage = next
    state.annotations = load()
    state.hover = null
    state.selected = null
    state.region = null
    liveElements.clear()
    revertAllPreviews()
    if (root) {
      render()
      applySavedPreviews()
    }
    post('ready', { annotations: state.annotations })
    if (keepPicking) setMode('picking')
  }

  function patchHistory() {
    if (historyPatched) return
    var originalPush = history.pushState
    var originalReplace = history.replaceState
    historyPatched = { push: originalPush, replace: originalReplace }
    ;['pushState', 'replaceState'].forEach(function (method) {
      var original = method === 'pushState' ? originalPush : originalReplace
      history[method] = function () {
        var result = original.apply(this, arguments)
        changePage()
        return result
      }
    })
  }

  function restoreHistory() {
    if (!historyPatched) return
    history.pushState = historyPatched.push
    history.replaceState = historyPatched.replace
    historyPatched = null
  }

  function bindInteractions() {
    if (controller) return
    controller = new AbortController()
    var signal = controller.signal
    window.addEventListener('pointerdown', onPointerDown, { capture: true, signal })
    window.addEventListener('pointermove', onPointerMove, { capture: true, signal })
    window.addEventListener('pointerup', onPointerUp, { capture: true, signal })
    window.addEventListener('click', onClickSuppress, { capture: true, signal })
    window.addEventListener('mousemove', onHover, { capture: true, passive: true, signal })
    window.addEventListener('keydown', onKeyDown, { capture: true, signal })
    window.addEventListener('contextmenu', onContextMenu, { capture: true, signal })
    window.addEventListener('scroll', onViewportChange, { capture: true, passive: true, signal })
    window.addEventListener('resize', onResize, { signal })
    window.addEventListener('popstate', changePage, { signal })
    window.addEventListener('hashchange', changePage, { signal })
    patchHistory()
  }

  // Layout/transform animations do not necessarily emit scroll or resize. One
  // geometry pass serves scrolling and animation; unchanged markup and styles
  // are left alone. Browsers pause rAF while the preview is backgrounded.
  // The loop is also what `destroy()` stops, so nothing keeps running after the
  // panel lets go of this page.
  var destroyed = false
  function trackAnchors() {
    if (destroyed) return
    if (root) {
      if (viewportChanged) updatePositions()
      viewportChanged = false
    }
    requestAnimationFrame(trackAnchors)
  }

  window.addEventListener('message', onHostMessage, false)
  state.annotations = load()
  if (document.body) {
    // The panel is told the page is ready even before annotation mode starts,
    // so its list can show what this page already carries.
    post('ready', { annotations: state.annotations, path: location.pathname })
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      post('ready', { annotations: state.annotations, path: location.pathname })
    })
  }
  requestAnimationFrame(trackAnchors)

  // Exposed for the standalone overlay test harness only; the panel never
  // touches it. Keeping it behind a flag means production pages see nothing.
  if (cfg.debug) {
    window.__dshLensDebug = function () {
      return { mode: state.mode, annotations: state.annotations, previews: [...previews.keys()], mounted: Boolean(root) }
    }
  }
})()
