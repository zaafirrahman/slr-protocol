// Uji alur "Ekspor proyek" di aplikasi biasa (bukan ekspor): menu JSON/HTML, payload ke /api/export-html, unduhan.
//   node tests/live_export_smoke.js template-atau-ekspor.html proyek.json [payload-keluar.json]
const fs = require('fs'), {createEnv} = require('./dom_shim');
const [htmlFile, projFile, outFile] = process.argv.slice(2); if (!htmlFile || !projFile) { console.error('pakai: node tests/live_export_smoke.js berkas.html proyek.json'); process.exit(2); }
let okN = 0, failN = 0; const check = (c, m) => { if (c) okN++; else { failN++; console.log('GAGAL:', m); } };
(async () => {
  let html = fs.readFileSync(htmlFile, 'utf8');
  html = html.replace(/<script>window\.__SLR_VIEWER__=[\s\S]*?;<\/script>\n?/, '');   // jalankan sebagai aplikasi biasa, bukan viewer
  const project = JSON.parse(fs.readFileSync(projFile, 'utf8'));
  const E = createEnv(html, {storage: {litreview_studio_project_v1: JSON.stringify(project)},
    fetchImpl: (url, o) => url === '/api/export-html' ? Promise.resolve({ok: true, status: 200, text: async () => '<!doctype html><html>ekspor-uji</html>', json: async () => ({})}) : Promise.reject(new Error('tidak dimock: ' + url))});
  const {g, call, wait, fire, errors, fetched} = E, downloads = [];
  E.run(); fire('DOMContentLoaded'); await wait(80);
  const real = E.ctx.document.createElement; E.ctx.document.createElement = t => { const el = real(t); if (t === 'a') el.click = function () { downloads.push({name: this.download, href: this.href}); }; return el; };
  check(!E.bodyEl.classList.contains('is-viewer'), 'aplikasi biasa: bukan mode viewer');
  check(g('export-menu').hidden === true, 'menu ekspor tertutup di awal');
  call('export-json', 'click'); check(g('export-menu').hidden === false, 'klik "Ekspor proyek" membuka menu JSON/HTML');
  call('export-json', 'click'); check(g('export-menu').hidden === true, 'klik lagi menutup menu');
  // HTML
  call('export-json', 'click'); call('export-as-html', 'click'); await wait(120);
  check(g('export-menu').hidden === true, 'memilih HTML menutup menu');
  const f = fetched.filter(x => x.url === '/api/export-html');
  check(f.length === 1 && f[0].opts && f[0].opts.method === 'POST', 'tepat satu POST ke /api/export-html');
  const body = f[0] ? JSON.parse(f[0].opts.body) : {};
  check(Array.isArray(body.state && body.state.articles) && body.state.articles.length === project.articles.length, 'payload memuat seluruh artikel proyek');
  check(body.state && body.state.synthesis && body.state.meta, 'payload memuat sintesis dan meta');
  const scope = (project.designUi || {}).scope || 'notexcluded';
  const want = project.articles.filter(a => a.extraction_status !== 'failed' && (scope === 'all' ? true : scope === 'included' ? (a.screening_decision === 'include' && a.eligibility_decision === 'include') : (a.screening_decision !== 'exclude' && a.eligibility_decision !== 'exclude'))).map(a => a.id);
  check(JSON.stringify(body.design && body.design.article_ids) === JSON.stringify(want), `design.article_ids = cakupan desain (${want.length} artikel, urutan sama)`);
  check(body.design && body.design.topic === ((project.designUi || {}).topic || ''), 'topik desain ikut dikirim');
  check(downloads.length === 1 && /^slr-protocol-laporan-.*\.html$/.test(downloads[0].name), 'berkas HTML diunduh dengan nama slr-protocol-laporan-*.html: ' + JSON.stringify(downloads.map(d => d.name)));
  // JSON
  call('export-json', 'click'); call('export-as-json', 'click'); await wait(50);
  check(downloads.length === 2 && /^slr-protocol-project-.*\.json$/.test(downloads[1].name), 'ekspor JSON tetap jalan: ' + JSON.stringify(downloads.map(d => d.name)));
  // kegagalan server tampil sebagai pesan, bukan crash
  E.ctx.fetch = () => Promise.resolve({ok: false, status: 500, json: async () => ({error: 'uji gagal'}), text: async () => ''});
  call('export-json', 'click'); call('export-as-html', 'click'); await wait(80);
  check(/uji gagal/.test(E.g('toast-region').children.map(c => c.textContent).join('|')), 'kegagalan server ditampilkan sebagai toast');
  check(errors.length === 0, 'tidak ada error: ' + errors.slice(0, 4).join(' || '));
  if (outFile && f[0]) fs.writeFileSync(outFile, f[0].opts.body);
  console.log(`${okN} lulus, ${failN} gagal`); process.exit(failN ? 1 : 0);
})();
