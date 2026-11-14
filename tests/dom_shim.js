// DOM tiruan minimal untuk menjalankan static/app.js di Node (tanpa browser). Dipakai oleh viewer_smoke.js dan live_export_smoke.js.
// Elemen dibangun dari markup berkas HTML itu sendiri (id, class, checked/disabled/hidden, nilai awal select).
const fs = require('fs'), vm = require('vm');

function createEnv(html, opts = {}) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const markup = html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
  const errors = [], fetched = [], stored = [];
  const fetchImpl = opts.fetchImpl || ((url) => Promise.reject(new Error('fetch dilarang: ' + url)));
  // ---- DOM tiruan ----
  const registry = new Map(), byClass = new Map(); const bodyEl = mkEl('body');
  function mkEl(tag, attrs = {}) {
    const classes = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean)), listeners = {}, ds = {};
    for (const k of Object.keys(attrs)) if (k.startsWith('data-')) ds[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = attrs[k];
    const el = {
      tagName: tag.toUpperCase(), id: attrs.id || '', _html: '', textContent: '', value: attrs.value || '', checked: 'checked' in attrs, disabled: 'disabled' in attrs, hidden: 'hidden' in attrs, readOnly: false,
      style: {}, dataset: ds, children: [], listeners, attributes: {...attrs}, files: [], href: '', download: '',
      classList: {add: (...c) => c.forEach(x => classes.add(x)), remove: (...c) => c.forEach(x => classes.delete(x)), toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : !!on; v ? classes.add(c) : classes.delete(c); return v; }, contains: c => classes.has(c)},
      get className() { return [...classes].join(' '); }, set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(x => classes.add(x)); },
      get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
      addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); }, removeEventListener() {},
      appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { this.children.unshift(c); return c; }, remove() {}, focus() {}, click() {}, blur() {},
      insertAdjacentHTML(pos, h) { this._html = pos === 'afterbegin' ? h + this._html : this._html + h; },
      setAttribute(k, v) { this.attributes[k] = String(v); }, getAttribute(k) { return this.attributes[k] ?? null; }, removeAttribute(k) { delete this.attributes[k]; },
      closest() { return null; }, matches() { return false; }, contains() { return false; }, querySelector: sel => $q(sel), querySelectorAll: () => [],
      getBoundingClientRect: () => ({width: 900, height: 600, left: 0, top: 0, right: 900, bottom: 600}), scrollIntoView() {}, select() {},
      createSVGPoint: () => ({}), getScreenCTM: () => null, setPointerCapture() {}, options: [],
    };
    return el;
  }
  // bangun elemen dari markup: id, class, checked/disabled/hidden, nilai awal select
  for (const m of markup.matchAll(/<(section|div|button|input|select|textarea|form|span|a|p|h1|h2|small|strong|aside|header|main|nav|table|tbody|ul|label)\b([^>]*)>/g)) {
    const attrs = {}; for (const a of m[2].matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) if (a[1]) attrs[a[1]] = a[2] ?? '';
    if (!attrs.id) continue;
    const el = mkEl(m[1], attrs);
    if (m[1] === 'select') { const seg = markup.slice(m.index, m.index + 1500); const sel = /<option[^>]*value="([^"]*)"[^>]*selected/.exec(seg) || /<option[^>]*value="([^"]*)"/.exec(seg); el.value = sel ? sel[1] : ''; }
    registry.set('#' + attrs.id, el);
  }
  function $q(sel) {
    sel = String(sel);
    if (sel === 'body') return bodyEl;
    if (!registry.has(sel)) registry.set(sel, mkEl('div', {id: sel.startsWith('#') ? sel.slice(1) : ''}));
    return registry.get(sel);
  }
  const docListeners = {};
  const document = {
    body: bodyEl, documentElement: mkEl('html'), activeElement: null, title: '',
    querySelector: $q, querySelectorAll: () => [], getElementById: id => registry.get('#' + id) || null,
    createElement: t => mkEl(t), addEventListener(t, fn, cap) { (docListeners[t] = docListeners[t] || []).push(fn); }, removeEventListener() {},
  };
  const win = {
     document, location: {hash: '', href: 'file:///laporan.html'}, history: {replaceState() {}},
    scrollTo() {}, confirm: () => false, matchMedia: () => ({matches: false, addEventListener() {}}), addEventListener(t, fn) { (docListeners['win:' + t] = docListeners['win:' + t] || []).push(fn); },
    getComputedStyle: () => ({}), requestAnimationFrame: fn => setTimeout(fn, 0), innerWidth: 1280, innerHeight: 800, open() {},
  };
  const store = new Map(Object.entries(opts.storage || {}));
  const ctx = vm.createContext({
    window: win, document, console: {log: console.log, warn() {}, error: (...a) => errors.push(a.join(' '))}, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    localStorage: {getItem: k => store.get(k) ?? null, setItem: (k, v) => { stored.push(k); store.set(k, v); }, removeItem() {}},
    fetch: (...a) => { fetched.push({url: String(a[0]), opts: a[1]}); return fetchImpl(...a); },
    structuredClone, Intl, Blob, URL, Image: function () {}, XMLSerializer: function () { this.serializeToString = () => ''; }, navigator: {clipboard: {writeText: () => Promise.resolve()}},
    location: win.location, history: win.history, HTMLSelectElement: function () {}, HTMLInputElement: function () {}, HTMLElement: function () {}, Event: function () {}, FormData: function () {}, DOMParser: function () {}, alert() {}, prompt() {}, confirm: () => false,
  });
  win.window = win; Object.assign(win, {localStorage: ctx.localStorage, structuredClone, fetch: ctx.fetch, Intl, URL, Blob});


  const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
  const fire = (t, ev = {}) => (docListeners[t] || []).forEach(fn => { try { fn({target: mkEl('div'), stopPropagation() {}, preventDefault() {}, key: '', ...ev}); } catch (e) { errors.push(t + ': ' + e.message); } });
  const g = id => registry.get('#' + id);
  const call = (id, type, ev) => (g(id).listeners[type] || []).forEach(fn => { try { fn({target: g(id), stopPropagation() {}, preventDefault() {}, ...ev}); } catch (e) { errors.push(id + '.' + type + ': ' + e.message); } });
  const go = async id => { win.location.hash = '#' + id; fire('win:hashchange'); await wait(80); };
  function run() { for (const [i, code] of scripts.entries()) { try { vm.runInContext(code, ctx, {filename: 'inline-' + i + '.js'}); } catch (e) { errors.push('script ' + i + ': ' + e.stack.split('\n').slice(0, 3).join(' | ')); } } }
  process.on('unhandledRejection', e => errors.push('unhandledRejection: ' + (e && e.message || e)));
  return {win, document, ctx, registry, bodyEl, errors, fetched, stored, store, wait, fire, g, call, go, run, mkEl, scripts, markup};
}
module.exports = {createEnv};
