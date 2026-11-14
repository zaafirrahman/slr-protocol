// Uji asap ekspor HTML: menjalankan kode di dalam berkas dengan DOM tiruan, berpindah ke semua tab, memeriksa hasil render
// dan bahwa mode hanya-baca benar-benar hanya-baca.   node tests/viewer_smoke.js laporan.html
// Keterbatasan: ini bukan browser. Tata letak, CSS, dan klik sungguhan tetap perlu dicoba di browser.
const fs = require('fs'), {createEnv} = require('./dom_shim');
const file = process.argv[2]; if (!file) { console.error('pakai: node tests/viewer_smoke.js berkas.html'); process.exit(2); }
let okN = 0, failN = 0; const check = (c, m) => { if (c) okN++; else { failN++; console.log('GAGAL:', m); } };
(async () => {
  const E = createEnv(fs.readFileSync(file, 'utf8')), {win, bodyEl, g, call, go, wait, fire, errors, fetched, stored, document} = E;
  E.run();
  check(typeof win.__SLR_VIEWER__ === 'object', 'payload __SLR_VIEWER__ terbaca');
  fire('DOMContentLoaded'); await wait(80);
  check(bodyEl.classList.contains('is-viewer'), 'body diberi kelas is-viewer');
  check(g('research-question').readOnly === true && g('inclusion').readOnly === true, 'formulir ikhtisar terkunci (readOnly)');
  check(g('design-scope').disabled === true && g('design-topic').disabled === true, 'kontrol cakupan/topik desain terkunci');
  check(/hanya-baca/.test(String(document.querySelector('.private-card').innerHTML)), 'kartu sidebar diganti keterangan hanya-baca');
  const rowsAt = () => (g('articles-body').innerHTML.match(/<tr/g) || []).length;
  check(rowsAt() >= 1, 'tabel artikel terisi saat boot');
  for (const id of ['articles', 'prisma', 'synthesis', 'taxonomy', 'design', 'design-diagram', 'cooccurrence', 'system-map']) await go(id);
  const S = JSON.parse(JSON.stringify(win.__SLR_VIEWER__.state)), nArt = S.articles.length;
  check(rowsAt() >= nArt, `tabel artikel memuat ${nArt} baris (ada ${rowsAt()} <tr)`);
  check(!/<select[^>]*data-field="screening_decision"(?![^>]*disabled)/.test(g('articles-body').innerHTML), 'select screening semuanya disabled');
  check(!/<select[^>]*data-field="eligibility_decision"(?![^>]*disabled)/.test(g('articles-body').innerHTML), 'select full-text semuanya disabled');
  check([...E.registry.keys()].some(k => /prisma/.test(k) && E.registry.get(k)._html.length > 100), 'PRISMA terisi');
  if (S.synthesis) check(g('synthesis-output')._html.length > 500, 'Review Synthesis terisi');
  if (S.synthesis && S.synthesis.taxonomy) check(g('taxonomy-content')._html.length > 300 && /<svg/.test(g('taxonomy-content')._html), 'Peta Topik terisi dengan diagram');
  check(g('design-tree')._html.length > 500 && !/Unggah artikel terlebih dahulu/.test(g('design-tree')._html), 'Taksonomi Desain Riset terisi (dari hasil tertanam)');
  check(/<svg/.test(g('dg-canvas')._html) && /<path|<rect|<circle/.test(g('dg-canvas')._html), 'Diagram Taksonomi (pohon) tergambar');
  check(/<svg/.test(g('cooccurrence-canvas')._html) && /<circle/.test(g('cooccurrence-canvas')._html), 'Co-occurrence tergambar');
  check(/<svg/.test(g('system-map-canvas')._html) && /net-node/.test(g('system-map-canvas')._html), 'System Map tergambar');
  // kontrol grafik tetap hidup
  const cc0 = g('cooccurrence-canvas')._html;
  g('cooccurrence-dominant').checked = false; call('cooccurrence-dominant', 'change'); await wait();
  check(g('cooccurrence-canvas')._html !== cc0, 'co-occurrence: toggle istilah dominan mengubah grafik');
  g('cooccurrence-min').value = '1'; call('cooccurrence-min', 'change'); await wait();
  check(/<svg/.test(g('cooccurrence-canvas')._html), 'co-occurrence: minimum kemunculan 1 tetap tergambar');
  const sm0 = g('system-map-canvas')._html; g('system-map-main').checked = true; call('system-map-main', 'change'); await wait();
  check(/<svg/.test(g('system-map-canvas')._html) && g('system-map-canvas')._html !== sm0, 'system map: "hanya kelompok terbesar" mengubah grafik');
  g('system-map-hier').checked = true; call('system-map-hier', 'change'); await wait();
  check(/<svg/.test(g('system-map-canvas')._html), 'system map: sertakan hierarki konsep tetap tergambar');
  const dg0 = g('dg-canvas')._html; call('dg-refs', 'click'); await wait();
  check(g('dg-canvas')._html !== dg0, 'diagram taksonomi: tombol nomor jurnal mengubah diagram');
  // hanya-baca
  check(fetched.length === 0, `tidak ada panggilan jaringan: ${fetched.map(f => f.url).join(', ')}`);
  check(!stored.includes('litreview_studio_project_v1'), 'localStorage proyek tidak ditulis');
  check(errors.length === 0, 'tidak ada error: ' + errors.slice(0, 4).join(' || '));
  console.log(`${okN} lulus, ${failN} gagal`); process.exit(failN ? 1 : 0);
})();
