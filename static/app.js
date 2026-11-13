(() => {
  'use strict';
  // JANGAN diganti: ini kunci localStorage proyek. Mengganti nama membuat proyek yang sudah tersimpan di browser "hilang".
  const STORE_KEY = 'litreview_studio_project_v1';
  const EMPTY_USAGE = { calls: 0, prompt_tokens: 0, cache_hit_tokens: 0, completion_tokens: 0, cost_usd: 0, usd_to_idr: 18000 };
  const DEFAULT_STATE = { articles: [], identifiedTotal: 0, duplicateCount: 0, synthesis: null, meta: {}, usage: {...EMPTY_USAGE}, designUi: {topic: '', scope: 'notexcluded'}, norm: {draft: null, approved: null} };
  let state = loadState();
  let activeTaxonomy = 'hierarchical';
  let activeArticleDetail = null;
  let isBusy = false;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const list = (value) => Array.isArray(value) ? value : [];
  const prettyDate = (value) => {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('id-ID', {day:'2-digit', month:'short', year:'numeric'});
  };
  const fileSize = (n) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
  const safeArrayText = (arr) => list(arr).length ? list(arr).map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\n') : 'Belum diekstrak / tidak dinyatakan dalam artikel.';

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return structuredClone(DEFAULT_STATE);
      const data = JSON.parse(raw);
      return {...structuredClone(DEFAULT_STATE), ...data, articles: Array.isArray(data.articles) ? data.articles : [], meta: data.meta || {}, usage: normaliseUsage(data.usage)};
    } catch (error) {
      console.warn('Project local storage tidak dapat dibaca:', error);
      return structuredClone(DEFAULT_STATE);
    }
  }
  function saveState() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      updateSavedHint(true);
    } catch (error) {
      updateSavedHint(false);
      toast('Penyimpanan browser penuh. Ekspor proyek sebagai JSON dan kurangi data.', 'error');
    }
  }
  function updateSavedHint(ok) {
    const hint = $('.save-hint');
    if (!hint) return;
    hint.innerHTML = ok ? '<span class="save-check">✓</span> Perubahan disimpan lokal di browser' : '<span class="save-check">!</span> Penyimpanan lokal bermasalah — ekspor backup';
  }
  function toast(message, type = '') {
    const region = $('#toast-region');
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    region.appendChild(node);
    setTimeout(() => node.remove(), 5200);
  }
  function globalMessage(message, type = '') {
    const box = $('#global-message');
    box.className = `message ${type}`;
    box.textContent = message;
    box.classList.remove('hidden');
  }
  function clearGlobalMessage() { $('#global-message').classList.add('hidden'); }
  const PANELS = {
    analysis: {wrap:'#upload-progress', text:'#progress-text', percent:'#progress-percent', fill:'#progress-bar-fill', current:'#progress-current', usage:'#progress-usage', log:'#process-log'},
    synthesis: {wrap:'#synthesis-progress', text:'#synthesis-progress-text', percent:'#synthesis-progress-percent', fill:'#synthesis-progress-fill', current:'#synthesis-progress-current', usage:'#synthesis-progress-usage', log:'#synthesis-progress-log'},
  };
  function setBusy(busy, text = 'Menganalisis artikel…', kind = 'analysis') {
    isBusy = busy;
    $('#analyze-button').disabled = busy;
    $('#run-synthesis').disabled = busy;
    Object.entries(PANELS).forEach(([name, p]) => $(p.wrap).classList.toggle('hidden', !(busy && name === kind)));
    if (busy) $(PANELS[kind].text).textContent = text;
  }
  function renderProcessProgress(snapshot, kind = 'analysis') {
    if (!snapshot || snapshot.pending) return; // pekerjaan belum terdaftar di server: pertahankan teks awal
    const p = PANELS[kind];
    const percent = Math.max(0, Math.min(100, Number(snapshot.percent) || 0));
    $(p.percent).textContent = `${percent}%`;
    const fill = $(p.fill);
    fill.style.width = `${percent}%`;
    fill.parentElement.classList.toggle('is-working', !!snapshot.indeterminate);
    $(p.text).textContent = snapshot.stage || 'Memproses…';
    const elapsed = Number(snapshot.elapsed) > 0 ? ` · ${snapshot.elapsed} dtk` : '';
    const where = snapshot.filename ? `Jurnal ${snapshot.current || 0}/${snapshot.total || 0}: ${snapshot.filename}` : (snapshot.stage || 'Menyiapkan proses');
    $(p.current).textContent = where + elapsed;
    $(p.usage).textContent = snapshot.usage ? liveUsageText(snapshot.usage) : '';
    const logBox = $(p.log);
    const logs = Array.isArray(snapshot.logs) ? snapshot.logs : [];
    logBox.innerHTML = logs.slice(-30).map(item => `<div class="process-log-item${item.live ? ' is-live' : ''}"><time>${esc(item.time || '')}</time><span>${esc(item.message || '')}</span></div>`).join('') || '<div class="process-log-item">Menunggu log proses…</div>';
    logBox.scrollTop = logBox.scrollHeight;
  }
  function newJobId() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
  // Polling progres dari backend (/api/analysis-progress atau /api/synthesis-progress). Mengembalikan fungsi stop.
  function startProgressPolling(kind, jobId) {
    let active = true, wake = null;
    const loop = (async () => {
      while (active) {
        try {
          const snapshot = await api(`/api/${kind}-progress?job_id=${encodeURIComponent(jobId)}`);
          if (active) renderProcessProgress(snapshot, kind);
        } catch (_) { /* backend may still be starting */ }
        if (!active) break;
        await new Promise(resolve => { wake = resolve; setTimeout(resolve, 500); });
      }
    })();
    return async () => { active = false; if (wake) wake(); await loop; };
  }

  // ---- Pemakaian token (akumulasi per proyek, tersimpan di browser & ikut ekspor/impor) ----
  function normaliseUsage(u) {
    const out = {...EMPTY_USAGE};
    for (const key of Object.keys(EMPTY_USAGE)) {
      const value = Number(u && u[key]);
      if (Number.isFinite(value) && value >= 0) out[key] = value;
    }
    return out;
  }
  function addUsage(u) {
    if (!u || !u.calls) return;
    const total = normaliseUsage(state.usage);
    for (const key of ['calls', 'prompt_tokens', 'cache_hit_tokens', 'completion_tokens', 'cost_usd']) total[key] += Number(u[key]) || 0;
    if (Number(u.usd_to_idr) > 0) total.usd_to_idr = Number(u.usd_to_idr);
    state.usage = total;
    saveState();
    renderUsage();
  }
  function renderUsage() {
    const chip = $('#usage-chip');
    if (!chip) return;
    const u = normaliseUsage(state.usage);
    const nf = new Intl.NumberFormat('id-ID');
    const idr = u.cost_usd * u.usd_to_idr;
    const cost = u.cost_usd <= 0 ? 'lokal' : (idr < 1 ? '< Rp1' : `≈ Rp${nf.format(Math.round(idr))}`);
    $('#usage-text').textContent = `${nf.format(u.prompt_tokens + u.completion_tokens)} token · ${cost}`;
    updateUsageDot();
    if (!$('#usage-popover').hidden) renderUsagePopover();
  }

  // ---- Popup pemakaian token + status tarif peak/off-peak (muncul saat chip diklik) ----
  let healthInfo = null;
  let serverLimits = {maxFiles: 8, maxFileMb: 12};
  function applyServerLimits() {
    const note = $('#upload-limits-note'), small = $('#upload-limits-small');
    if (note) note.textContent = `Maks. ${serverLimits.maxFiles} PDF per batch · ${serverLimits.maxFileMb} MB per PDF`;
    if (small) small.textContent = `PDF berbasis teks · batch maksimum ${serverLimits.maxFiles} dokumen`;
  }
  async function sha256Hex(file) {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function usageTzLabel() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz === 'Asia/Jakarta') return 'WIB';
    if (tz === 'Asia/Makassar') return 'WITA';
    if (tz === 'Asia/Jayapura') return 'WIT';
    const part = new Intl.DateTimeFormat('id-ID', {timeZoneName: 'short'}).formatToParts(new Date()).find(x => x.type === 'timeZoneName');
    return part ? part.value : tz;
  }
  const clock = d => new Intl.DateTimeFormat('id-ID', {hour: '2-digit', minute: '2-digit', hour12: false}).format(d).replace('.', ':');
  function utcHourLocal(h) {
    const n = new Date();
    return clock(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), h)));
  }
  function fmtDuration(ms) {
    const mins = Math.max(1, Math.round(ms / 60000));
    const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
    if (d) return `${d} hari ${h} jam`;
    if (h) return m ? `${h} jam ${m} menit` : `${h} jam`;
    return `${m} menit`;
  }
  function updateUsageDot() {
    const dot = $('#usage-period-dot');
    if (!dot) return;
    const p = healthInfo && healthInfo.pricing;
    if (!p) { dot.hidden = true; return; }
    dot.hidden = false;
    dot.className = 'usage-period-dot ' + (p.period === 'peak' ? 'is-peak' : 'is-off');
    dot.title = p.period === 'peak' ? 'Jam peak DeepSeek' : 'Off-peak DeepSeek';
  }
  function periodBlockHtml() {
    if (!healthInfo) {
      return '<div class="usage-period is-local"><b>Status tarif tidak tersedia</b><p>Backend tidak terhubung, jadi status peak/off-peak tidak dapat dimuat.</p></div>';
    }
    const p = healthInfo.pricing;
    if (!p) {
      return '<div class="usage-period is-local"><b>Model lokal</b><p>Tanpa biaya API, jadi tarif peak/off-peak tidak berlaku.</p></div>';
    }
    const tz = usageTzLabel();
    const peak = p.period === 'peak';
    const next = p.next_change_utc ? new Date(p.next_change_utc) : null;
    const title = !p.peak_enabled ? 'Tarif peak dinonaktifkan' : (peak ? `Jam peak · tarif ×${p.peak_multiplier}` : 'Off-peak · tarif normal');
    const nextLine = next && p.peak_enabled
      ? `${peak ? 'Off-peak' : 'Peak'} mulai pukul ${clock(next)} ${tz} (${fmtDuration(next - Date.now())} lagi).`
      : '';
    const r = p.rates_now || {};
    const usd = v => { let t = Number(v).toFixed(4).replace(/0+$/, ''); if ((t.split('.')[1] || '').length < 2) t = Number(v).toFixed(2); return '$' + t; };
    const rates = `Tarif sekarang / 1 juta token: input ${usd(r.input_miss)} · cache hit ${usd(r.input_hit)} · output ${usd(r.output)}.`;
    const sched = p.peak_enabled
      ? `Jadwal peak (Sen–Jum): ${(p.peak_windows_utc || []).map(w => w.replace('-', '–')).join(' & ')} UTC${new Date().getTimezoneOffset() === 0 ? '' : ` = ${utcHourLocal(1)}–${utcHourLocal(4)} & ${utcHourLocal(6)}–${utcHourLocal(10)} ${tz}`}. Di luar itu dan di akhir pekan: off-peak.`
      : '';
    return `<div class="usage-period ${peak ? 'is-peak' : 'is-off'}"><b><span class="usage-period-dot ${peak ? 'is-peak' : 'is-off'}"></span>${esc(title)}</b>${nextLine ? `<p>${esc(nextLine)}</p>` : ''}<p>${esc(rates)}</p>${sched ? `<p>${esc(sched)}</p>` : ''}</div>`;
  }
  function renderUsagePopover() {
    const body = $('#usage-pop-body');
    if (!body) return;
    const u = normaliseUsage(state.usage);
    const nf = new Intl.NumberFormat('id-ID');
    const idr = u.cost_usd * u.usd_to_idr;
    const costText = u.cost_usd <= 0
      ? 'Lokal (tanpa biaya API)'
      : `$${u.cost_usd.toFixed(5)} ≈ Rp${nf.format(Math.round(idr))}`;
    const sub = healthInfo ? `<p class="usage-sub">${esc(healthInfo.provider || '')} · ${esc(healthInfo.model || '')}</p>` : '';
    body.innerHTML = `${sub}${periodBlockHtml()}
      <div class="usage-stats">
        <div><span>Input</span><strong>${nf.format(u.prompt_tokens)}</strong></div>
        <div><span>Cache hit</span><strong>${nf.format(u.cache_hit_tokens)}</strong></div>
        <div><span>Output</span><strong>${nf.format(u.completion_tokens)}</strong></div>
        <div><span>Panggilan API</span><strong>${nf.format(u.calls)}</strong></div>
        <div><span>Total token</span><strong>${nf.format(u.prompt_tokens + u.completion_tokens)}</strong></div>
        <div><span>Estimasi biaya</span><strong>${esc(costText)}</strong></div>
      </div>
      <p class="usage-note">Biaya dihitung per panggilan memakai tarif saat panggilan terjadi. Data tersimpan di browser untuk proyek ini dan ikut ekspor/impor.</p>${donateBlockHtml(u.cost_usd > 0 ? idr : 0, nf)}`;
  }
  // ---- Ajakan bantu bayar API via QRIS (opsional, tampil di bawah popup token) ----
  function donateBlockHtml(idr, nf) {
    const rounded = idr >= 1 ? Math.max(100, Math.round(idr / 100) * 100) : 0;
    const msg = rounded
      ? `Habis token sekitar Rp${nf.format(rounded)} nih ngab. Kalau mau bantu bayar API biar server tetep tancap gas, bisa scan QRIS di bawah ya!`
      : 'Server ini jalan pakai API berbayar. Kalau mau bantu bayar API biar tetep tancap gas, bisa scan QRIS di bawah ya!';
    return `<div class="donate-box"><b class="donate-title">// traktir server</b><p>${esc(msg)}</p><img class="donate-qris" src="/static/qris.png" alt="QRIS untuk bantu bayar API" loading="lazy" onerror="this.closest('.donate-box').hidden=true"><small>Sukarela, tidak wajib. Makasih banyak ngab!</small></div>`;
  }
  async function refreshHealthInfo() {
    try { healthInfo = await api('/api/health'); } catch (_) { healthInfo = null; }
    updateUsageDot();
    if (!$('#usage-popover').hidden) renderUsagePopover();
  }
  let resetArmTimer = null;
  function disarmReset() {
    clearTimeout(resetArmTimer);
    const btn = $('#usage-reset');
    if (btn) { btn.classList.remove('is-confirm'); btn.textContent = 'Reset penghitung'; }
  }
  function openUsagePopover() {
    $('#usage-popover').hidden = false;
    $('#usage-chip').setAttribute('aria-expanded', 'true');
    renderUsagePopover();
    refreshHealthInfo();
  }
  function closeUsagePopover() {
    $('#usage-popover').hidden = true;
    $('#usage-chip').setAttribute('aria-expanded', 'false');
    disarmReset();
  }
  function setupUsagePopover() {
    $('#usage-chip').addEventListener('click', () => $('#usage-popover').hidden ? openUsagePopover() : closeUsagePopover());
    $('#usage-pop-close').addEventListener('click', closeUsagePopover);
    document.addEventListener('click', e => {
      if (!$('#usage-popover').hidden && !e.target.closest('.usage-wrap')) closeUsagePopover();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#usage-popover').hidden) { closeUsagePopover(); $('#usage-chip').focus(); } });
    $('#usage-reset').addEventListener('click', () => {
      const btn = $('#usage-reset');
      if (!btn.classList.contains('is-confirm')) {
        btn.classList.add('is-confirm');
        btn.textContent = 'Yakin? Klik lagi untuk reset';
        resetArmTimer = setTimeout(disarmReset, 4000);
        return;
      }
      disarmReset();
      state.usage = {...EMPTY_USAGE};
      saveState();
      renderUsage();
      toast('Penghitung token direset.', 'success');
    });
    setInterval(refreshHealthInfo, 60000); // perbarui status peak/off-peak tiap menit
  }
  function usageText(u) {
    if (!u || !u.calls) return '';
    const nf = new Intl.NumberFormat('id-ID');
    const cost = u.cost_idr > 0 ? `≈ Rp${nf.format(u.cost_idr)}` : 'lokal';
    return ` Pemakaian: ${nf.format(u.prompt_tokens)} token input, ${nf.format(u.completion_tokens)} token output (${cost}).`;
  }
  function liveUsageText(u) {
    const nf = new Intl.NumberFormat('id-ID');
    const cost = u.calls ? (u.cost_idr > 0 ? ` · ≈ Rp${nf.format(u.cost_idr)}` : ' · lokal') : '';
    const calls = u.calls ? ` · ${nf.format(u.calls)} panggilan API` : '';
    return `Token terpakai: ${nf.format(u.prompt_tokens || 0)} input · ${nf.format(u.completion_tokens || 0)} output${cost}${calls}`;
  }
  async function api(path, options = {}) {
    const response = await fetch(path, options);
    let data = {};
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok) {
      const error = new Error(data.error || `Permintaan gagal (HTTP ${response.status}).`);
      error.usage = data.usage; // token tetap terpakai walau permintaan gagal
      throw error;
    }
    return data;
  }

  function getMetaFromForm() {
    return {
      research_question: $('#research-question').value.trim(),
      source_name: $('#source-name').value.trim(),
      search_date: $('#search-date').value,
      search_query: $('#search-query').value.trim(),
      inclusion: $('#inclusion').value.trim(),
      exclusion: $('#exclusion').value.trim(),
      guide_context: $('#guide-context').value || 'itb-tmi',
    };
  }
  function applyMeta(meta = {}) {
    $('#research-question').value = meta.research_question || '';
    $('#source-name').value = meta.source_name || '';
    $('#search-date').value = meta.search_date || '';
    $('#search-query').value = meta.search_query || '';
    $('#inclusion').value = meta.inclusion || '';
    $('#exclusion').value = meta.exclusion || '';
    $('#guide-context').value = meta.guide_context || 'itb-tmi';
  }
  function saveMetaFromForm(showToast = false) {
    state.meta = getMetaFromForm();
    saveState();
    if (showToast) toast('Konfigurasi review tersimpan.', 'success');
  }

  function navigate(target) {
    if (!target || !$('#' + target)) return;
    $$('.page-section').forEach(section => section.classList.toggle('active-section', section.id === target));
    $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.target === target));
    const labels = {'arah-riset':'Arah Riset', overview:'Ikhtisar', articles:'Artikel', prisma:'PRISMA Flow', synthesis:'Review Synthesis', taxonomy:'Peta Topik', design:'Taksonomi Desain Riset', 'design-diagram':'Diagram Taksonomi', cooccurrence:'Co-occurrence', 'system-map':'System Map'};
    $('#breadcrumb-current').textContent = labels[target] || target;
    window.scrollTo({top:0, behavior:'smooth'});
    try { history.replaceState(null, '', '#' + target); } catch (_) { /* abaikan */ }
    if (target === 'arah-riset') renderArahRiset();
    if (target === 'articles') renderArticles();
    if (target === 'prisma') renderPrisma();
    if (target === 'taxonomy') renderTaxonomy();
    if (target === 'design') renderDesign();
    if (target === 'design-diagram') renderDesignDiagram();
    if (target === 'cooccurrence') renderCooccurrence();
    if (target === 'system-map') renderSystemMap();
    if (target === 'synthesis') renderSynthesis();
  }

  function currentCounts() {
    const articles = state.articles;
    const screeningPending = articles.filter(a => (a.screening_decision || 'pending') === 'pending').length;
    const screeningExcluded = articles.filter(a => a.screening_decision === 'exclude').length;
    const screenPassed = articles.filter(a => a.screening_decision === 'include').length;
    const fulltextPending = articles.filter(a => a.screening_decision === 'include' && (a.eligibility_decision || 'pending') === 'pending').length;
    const fulltextExcluded = articles.filter(a => a.screening_decision === 'include' && a.eligibility_decision === 'exclude').length;
    const included = articles.filter(a => a.screening_decision === 'include' && a.eligibility_decision === 'include').length;
    const completed = articles.filter(a => a.screening_decision === 'exclude' || (a.screening_decision === 'include' && a.eligibility_decision !== 'pending')).length;
    return {unique:articles.length, identified:state.identifiedTotal || articles.length, duplicates:state.duplicateCount || 0, screeningPending, screeningExcluded, screenPassed, fulltextPending, fulltextExcluded, included, completed, total:articles.length};
  }
  function renderMetrics() {
    const c = currentCounts();
    $('#nav-article-count').textContent = c.unique;
    $('#metric-articles').textContent = c.unique;
    $('#metric-pending').textContent = c.screeningPending + c.fulltextPending;
    $('#metric-included').textContent = c.included;
    $('#metric-gaps').textContent = state.synthesis ? list(state.synthesis.research_gaps).length : '—';
    $('#metric-gaps-note').textContent = state.synthesis ? 'Gap hasil sintesis' : 'Jalankan sintesis untuk melihat gap';
    $('#progress-ratio').textContent = `${c.completed} / ${c.total} selesai`;
    const n = c.total || 1;
    $('#stacked-progress .seg-included').style.width = `${(c.included / n) * 100}%`;
    $('#stacked-progress .seg-excluded').style.width = `${((c.screeningExcluded + c.fulltextExcluded) / n) * 100}%`;
    $('#stacked-progress .seg-pending').style.width = `${Math.max(0, 100 - ((c.included + c.screeningExcluded + c.fulltextExcluded) / n) * 100)}%`;
    $('#article-table-note').textContent = `${c.unique} artikel unik · ${c.duplicates} duplikat terdeteksi · ${c.included} masuk sintesis`;
  }

  function recommendationBadge(article) {
    const s = (article.screening_suggestion || {}).decision || 'review';
    const map = {include:['recommend-include','Saran INCLUDE'], exclude:['recommend-exclude','Saran EXCLUDE'], review:['recommend-review','Perlu ditinjau']};
    const [cls, label] = map[s] || map.review;
    return `<span class="recommendation ${cls}" title="${esc((article.screening_suggestion || {}).reason || '')}">${esc(label)}</span>`;
  }
  function statusLabel(status, kind) {
    const prefix = kind === 'screen' ? 'Screening' : 'Full-text';
    const opts = status === 'include' ? 'INCLUDE' : status === 'exclude' ? 'EXCLUDE' : 'Belum diputuskan';
    return `${prefix}: ${opts}`;
  }
  function renderArticles() {
    const body = $('#articles-body');
    const query = ($('#article-search')?.value || '').trim().toLowerCase();
    const filter = $('#article-filter')?.value || 'all';
    const articles = state.articles.filter(a => {
      const hay = `${a.title || ''} ${(a.authors || []).join(' ')} ${(a.topic_tags || []).join(' ')} ${a.filename || ''}`.toLowerCase();
      if (query && !hay.includes(query)) return false;
      if (filter === 'pending') return a.screening_decision !== 'exclude' && !(a.screening_decision === 'include' && a.eligibility_decision === 'include');
      if (filter === 'included') return a.screening_decision === 'include' && a.eligibility_decision === 'include';
      if (filter === 'excluded') return a.screening_decision === 'exclude' || (a.screening_decision === 'include' && a.eligibility_decision === 'exclude');
      return true;
    });
    if (!articles.length) {
      body.innerHTML = `<tr><td colspan="5" class="empty-cell">${state.articles.length ? 'Tidak ada artikel yang cocok dengan filter.' : 'Belum ada artikel. Unggah PDF pada halaman Ikhtisar.'}</td></tr>`;
      return;
    }
    body.innerHTML = articles.map(a => {
      const authors = list(a.authors).slice(0,3).join(', ');
      const year = a.year || 'Tahun tidak terdeteksi';
      const screen = a.screening_decision || 'pending';
      const eligibility = a.eligibility_decision || 'pending';
      return `<tr>
        <td class="article-title-cell"><span class="article-title">${esc(a.title || a.filename)}</span><span class="article-meta">${esc(authors || 'Penulis tidak terdeteksi')} · ${esc(year)}${a.doi ? ` · DOI: ${esc(a.doi)}` : ''}</span><span class="article-filename">${esc(a.filename || '')}</span>${a.owner_verified ? '<span class="verified-mark" title="Sudah diverifikasi terhadap PDF">✓ dicek</span>' : ''}</td>
        <td>${recommendationBadge(a)}<div class="article-meta" style="max-width:180px;margin-top:6px">${esc((a.screening_suggestion || {}).reason || 'Tidak ada alasan rekomendasi.')}</div></td>
        <td class="select-cell"><select aria-label="Keputusan screening" data-id="${esc(a.id)}" data-field="screening_decision">${decisionOptions(screen)}</select></td>
        <td class="select-cell"><select aria-label="Keputusan full text" data-id="${esc(a.id)}" data-field="eligibility_decision" ${screen !== 'include' ? 'disabled title="Screening harus INCLUDE terlebih dahulu"' : ''}>${decisionOptions(eligibility)}</select></td>
        <td><button class="icon-button" data-detail="${esc(a.id)}" aria-label="Lihat detail artikel" title="Detail artikel">↗</button></td>
      </tr>`;
    }).join('');
  }
  function decisionOptions(value) {
    const options = [['pending','Belum diputuskan'],['include','INCLUDE'],['exclude','EXCLUDE']];
    return options.map(([key,label]) => `<option value="${key}" ${key===value?'selected':''}>${label}</option>`).join('');
  }
  function findArticle(id) { return state.articles.find(a => a.id === id); }
  function escapeWithBreaks(text) { return esc(text).replace(/\n/g, '<br>'); }
  function renderArticleDetail(id) {
    const a = findArticle(id); if (!a) return;
    activeArticleDetail = id;
    const quotes = list(a.evidence_quotes).map(q => {
      const badge = q.verified === true ? ' <span class="badge-stated">✓ ditemukan di teks PDF</span>' : (q.verified === false ? ' <span class="badge-bad">⚠ tidak ditemukan di teks PDF: verifikasi manual</span>' : '');
      return `<li><strong>${esc(q.claim || 'Klaim')}</strong><br>“${esc(q.quote || '')}” ${q.page ? `<span class="article-meta">(hal. ${esc(q.page)})</span>` : ''}${badge}</li>`;
    }).join('');
    const designBlock = renderResearchDesignBlock(a);
    const skipped = (a.text_chars_body || 0) - (a.text_chars || 0);
    const truncNote = a.text_truncated ? (a.text_chars_body
      ? `\n\nTeks dipotong: isi artikel di luar daftar pustaka ${esc(a.text_chars_body)} karakter, ${esc(a.text_chars)} dikirim ke AI. Sekitar ${esc(skipped)} karakter (${esc(Math.round(100 * skipped / a.text_chars_body))}%) di bagian tengah dilewati, jadi temuan dari bagian itu mungkin tidak tertangkap. Naikkan MAX_TEXT_CHARS di .env bila perlu (batas keras 200000).`
      : `\n\nTeks dipotong: ${esc(a.text_chars)} dari ${esc(a.text_chars_original)} karakter dikirim ke AI (angka ini masih termasuk daftar pustaka; bagian tengah isi artikel dilewati). Unggah ulang untuk mendapat angka yang lebih akurat.`) : '';
    $('#article-detail').innerHTML = `<button class="icon-button detail-close" id="close-detail" aria-label="Tutup detail">×</button><h2 class="detail-title">${esc(a.title)}</h2><div class="detail-meta">${esc(list(a.authors).join(', ') || 'Penulis tidak terdeteksi')} · ${esc(a.year || 'Tahun tidak terdeteksi')} · ${esc(a.pages || '?')} halaman · ${esc(a.filename || '')}</div><label class="verify-box"><input type="checkbox" id="verify-article" data-id="${esc(a.id)}" ${a.owner_verified ? 'checked' : ''}> <span>Sudah saya cek label dan kutipan artikel ini terhadap PDF</span></label><div class="detail-grid">
      <div class="detail-block"><h4>ABSTRACT / TUJUAN</h4><p>${escapeWithBreaks(a.abstract || a.objective || 'Tidak diekstrak.')}</p></div>
      <div class="detail-block"><h4>METODE & KONTEKS</h4><p>${escapeWithBreaks(a.methods || 'Metode tidak terdeteksi')}\n\nKonteks: ${escapeWithBreaks(a.context || 'Tidak tersedia')}</p></div>
      <div class="detail-block"><h4>TEMUAN UTAMA</h4><ul>${list(a.findings).length ? list(a.findings).map(x=>`<li>${esc(x)}</li>`).join('') : '<li>Temuan tidak diekstrak.</li>'}</ul></div>
      <div class="detail-block"><h4>VARIABEL / TOPIK</h4><p>${esc([...list(a.variables), ...list(a.topic_tags)].join(' · ') || 'Tidak terdeteksi')}</p></div>
      <div class="detail-block"><h4>LIMITASI</h4><ul>${list(a.limitations).length ? list(a.limitations).map(x=>`<li>${esc(x)}</li>`).join('') : '<li>Tidak dinyatakan / tidak terdeteksi.</li>'}</ul></div>
      <div class="detail-block"><h4>REKOMENDASI SCREENING</h4><p>${esc((a.screening_suggestion || {}).decision || 'review').toUpperCase()} — ${esc((a.screening_suggestion || {}).reason || 'Perlu verifikasi manual.')}</p></div>
      ${designBlock}
      ${quotes ? `<div class="detail-block" style="grid-column:1/-1"><h4>KUTIPAN BUKTI YANG DIEKSTRAK</h4><ul>${quotes}</ul></div>` : ''}
      <div class="detail-block" style="grid-column:1/-1"><h4>CATATAN</h4><p>Hasil ekstraksi perlu diverifikasi dengan artikel sumber sebelum dipakai sebagai kutipan atau bukti final. File PDF asli tetap disimpan lokal dan JSON terstruktur tersedia di folder data/json.${truncNote}</p></div>
      </div>`;
    $('#article-detail').classList.remove('hidden');
    $('#article-detail').scrollIntoView({behavior:'smooth',block:'start'});
  }

  function renderPrisma() {
    const c = currentCounts();
    $('#prisma-updated').textContent = state.articles.length ? `${state.articles.length} artikel unik · diperbarui ${new Date().toLocaleString('id-ID')}` : 'Belum ada data';
    if (!state.articles.length) {
      $('#prisma-diagram').innerHTML = '<div class="empty-state">Unggah PDF dan tetapkan keputusan screening untuk membangun diagram PRISMA.</div>';
      return;
    }
    const completed = c.screeningPending === 0 && c.fulltextPending === 0;
    const finalLabel = completed ? 'Keputusan seleksi lengkap' : 'Belum menjadi flow final — masih ada keputusan pending';
    const finalClass = completed ? 'stage-main' : 'stage-pending';
    $('#prisma-diagram').innerHTML = `<div class="prisma-grid">
      <div class="prisma-row"><div class="prisma-stage"><div class="stage-label">IDENTIFICATION</div><strong>${c.identified}</strong><p>Records identified dari PDF berhasil diekstrak dan duplikat yang diterima untuk diperiksa</p></div><div class="prisma-arrow">→</div><div class="prisma-stage stage-excluded"><div class="stage-label">DUPLICATES</div><strong>${c.duplicates}</strong><p>Duplikat PDF persis yang dihapus saat penambahan</p></div></div>
      <div class="prisma-connector">↓</div>
      <div class="prisma-row"><div class="prisma-stage stage-main"><div class="stage-label">SCREENING</div><strong>${c.unique}</strong><p>Artikel unik tersedia untuk pemeriksaan judul/abstrak</p></div><div class="prisma-arrow">→</div><div class="prisma-stage stage-excluded"><div class="stage-label">RECORDS EXCLUDED</div><strong>${c.screeningExcluded}</strong><p>Dikeluarkan pada screening judul/abstrak</p></div></div>
      <div class="prisma-pending-row"><span class="stage-pending-chip">${c.screeningPending} belum diputuskan pada screening</span><span class="stage-next">${c.screenPassed} lolos screening → penilaian full-text</span></div>
      <div class="prisma-connector">↓</div>
      <div class="prisma-row"><div class="prisma-stage stage-main"><div class="stage-label">ELIGIBILITY</div><strong>${c.screenPassed}</strong><p>Artikel dilanjutkan ke penilaian kelayakan full-text</p></div><div class="prisma-arrow">→</div><div class="prisma-stage stage-excluded"><div class="stage-label">FULL-TEXT EXCLUDED</div><strong>${c.fulltextExcluded}</strong><p>Dikeluarkan setelah penilaian full-text</p></div></div>
      <div class="prisma-pending-row"><span class="stage-pending-chip">${c.fulltextPending} full-text belum diputuskan</span><span class="stage-next">Lolos dan disetujui: ${c.included}</span></div>
      <div class="prisma-connector">↓</div>
      <div class="prisma-final-row"><div class="prisma-stage ${finalClass}"><div class="stage-label">INCLUDED STUDIES</div><strong>${c.included}</strong><p>Artikel siap digunakan untuk sintesis</p></div><div class="prisma-final-note">${esc(finalLabel)}<small>${c.screeningPending + c.fulltextPending} keputusan masih pending</small></div></div>
    </div>`;
  }

  function citationChips(ids) {
    return list(ids).map(id => {
      const a = findArticle(id);
      return `<span class="source-chip" title="${esc(a ? a.title : id)}">${esc(a ? `${a.year || 'n.d.'} · ${a.title.slice(0,28)}${a.title.length>28?'…':''}` : id)}</span>`;
    }).join('');
  }
  function renderSynthesis() {
    const s = state.synthesis;
    $('#synthesis-empty').classList.toggle('hidden', !!s);
    $('#synthesis-output').classList.toggle('hidden', !s);
    if (!s) return;
    const themes = list(s.main_themes).map(t => `<div class="synth-list-item"><div class="synth-card-head"><h4>${esc(t.name || 'Tema')}</h4><span class="confidence ${(t.confidence || '').toLowerCase()}">${esc(t.confidence || 'confidence tidak ditentukan')}</span></div><p>${esc(t.synthesis || t.description || '')}</p>${t.description && t.synthesis ? `<p style="margin-top:7px"><strong>Definisi:</strong> ${esc(t.description)}</p>` : ''}<div class="source-chips">${citationChips(t.article_ids)}</div></div>`).join('');
    const agreements = list(s.agreements).map(x=>`<div class="synth-list-item"><h4>${esc(x.claim || 'Temuan konsisten')}</h4><p>${esc(x.interpretation || x.notes || '')}</p><div class="source-chips">${citationChips(x.article_ids)}</div></div>`).join('');
    const contradictions = list(s.contradictions).map(x=>`<div class="synth-list-item"><h4>${esc(x.issue || 'Perbedaan temuan')}</h4><p>${esc(x.possible_explanation || 'Belum ada penjelasan yang cukup dari ringkasan.')}</p><div class="source-chips">${citationChips(x.article_ids)}</div></div>`).join('');
    const gaps = list(s.research_gaps).map((x,i)=>`<div class="synth-list-item"><div class="synth-eyebrow">GAP ${String(i+1).padStart(2,'0')}</div><h4>${esc(x.gap || 'Research gap')}</h4><p>${esc(x.evidence || '')}</p>${x.suggested_next_step ? `<p style="margin-top:7px"><strong>Arah penelitian:</strong> ${esc(x.suggested_next_step)}</p>` : ''}<div class="source-chips">${citationChips(x.article_ids)}</div></div>`).join('');
    const limitations = list(s.limitations_of_corpus).map(x=>`<li>${esc(x)}</li>`).join('');
    const notes = list(s.review_notes).map(x=>`<li>${esc(x)}</li>`).join('');
    $('#synthesis-output').innerHTML = `
      <div class="synth-card"><div class="synth-eyebrow">SUMMARY / ${esc(s.included_article_count || currentCounts().included)} ARTIKEL</div><div class="synth-card-head"><h2>Sintesis eksekutif</h2><span class="status-pill status-ok">Hasil sintesis · perlu verifikasi</span></div><p>${esc(s.executive_synthesis || 'Tidak ada ringkasan.')}</p><p class="citation-note"><strong>Research question:</strong> ${esc(s.research_question_refinement || $('#research-question').value || 'Belum ditentukan')}</p>${list(s.subquestions).length ? `<h3 style="margin:16px 0 8px">Subquestions</h3><ol class="review-note-list">${list(s.subquestions).map(x=>`<li>${esc(x)}</li>`).join('')}</ol>` : ''}</div>
      <div class="synth-card"><div class="synth-card-head"><h2>01 / Tema utama</h2><span class="confidence">${list(s.main_themes).length} tema</span></div><div class="synth-list">${themes || '<p>Belum ada tema utama.</p>'}</div></div>
      <div class="detail-grid" style="margin-bottom:13px;align-items:start"><div class="synth-card" style="margin:0;height:100%"><div class="synth-card-head"><h2>02 / Konsistensi</h2><span class="confidence high">${list(s.agreements).length}</span></div><div class="synth-list">${agreements || '<p>Tidak ada pola konsisten yang dirangkum.</p>'}</div></div><div class="synth-card" style="margin:0;height:100%"><div class="synth-card-head"><h2>03 / Kontradiksi</h2><span class="confidence low">${list(s.contradictions).length}</span></div><div class="synth-list">${contradictions || '<p>Tidak ada kontradiksi yang teridentifikasi dari ringkasan.</p>'}</div></div></div>
      <div class="synth-card"><div class="synth-card-head"><h2>04 / Research gaps</h2><span class="confidence">${list(s.research_gaps).length} kandidat gap</span></div><div class="synth-list">${gaps || '<p>Tidak ada research gap yang dirangkum.</p>'}</div></div>
      <div class="detail-grid" style="align-items:start"><div class="synth-card" style="margin:0"><h3>Limitasi korpus</h3><ul class="review-note-list">${limitations || '<li>Tidak tersedia.</li>'}</ul></div><div class="synth-card" style="margin:0"><h3>Catatan verifikasi</h3><ul class="review-note-list">${notes || '<li>Periksa kembali hasil ekstraksi pada artikel asli.</li>'}</ul></div></div>
      <p class="citation-note">Dihasilkan ${esc(prettyDate(s.generated_at))} menggunakan model ${esc(s.model || 'lokal')}. Sintesis dibangun dari artikel yang secara manual ditandai INCLUDE pada dua tahap. Chip artikel menunjukkan judul singkat sumber dukungan; tetap buka PDF asli untuk mengonfirmasi klaim.</p>`;
  }

  function svgText(text, x, y, size=12, weight=600, fill='#e8e8e8') {
    return `<text x="${x}" y="${y}" text-anchor="middle" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(String(text || '').slice(0,38))}</text>`;
  }
  // ===== Jaringan SLR lanjutan: peta topik, co-occurrence, system map =====
  // Satu mesin tata letak berbasis gaya (force-directed, deterministik) dan satu penggambar SVG dipakai bersama
  // oleh Co-occurrence, System Map, dan diagram Poly-hierarchy. Warna literal (bukan variabel CSS) agar unduhan SVG berdiri sendiri.
  const NET_PAL = ['#9fd09f', '#dcb85c', '#86b4d8', '#e8906e', '#c9a0dc', '#7fd1c7', '#d98ba0', '#e8e8e8'];
  const NET_FONT = "Inter,'Segoe UI',Arial,sans-serif";
  // Nomor rujukan artikel, sama dengan tab Desain Riset (urutan artikel pada cakupan desain).
  function scopeRefs() { const m = {}; designScopeArticles().forEach((a, i) => { m[a.id] = i + 1; }); return m; }
  // [1–3, 5]: tiga nomor berurutan atau lebih diringkas menjadi rentang.
  function fmtRefs(ids, map) {
    const nums = [...new Set(list(ids).map(id => map[id]).filter(Boolean))].sort((a, b) => a - b), parts = [];
    for (let i = 0; i < nums.length;) {
      let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      parts.push(j - i >= 2 ? `${nums[i]}–${nums[j]}` : nums.slice(i, j + 1).join(', ')); i = j + 1;
    }
    return parts.length ? `[${parts.join(', ')}]` : '';
  }
  const netLines = (s, max, maxLines = 3) => {
    const L = dgWrap(s, max);
    if (L.length > maxLines) { const k = L.slice(0, maxLines); k[maxLines - 1] = k[maxLines - 1].slice(0, Math.max(1, max - 1)) + '…'; return k; }
    return L;
  };

  // Tata letak gaya: tolakan antarsimpul, pegas sepanjang hubungan, gravitasi ke pusat, dan tumbukan kotak
  // (supaya label tidak saling menimpa). nodes: {id, bw, bh, [ty]}; edges: {a, b, w}. Mengisi x dan y pada simpul.
  function netLayoutOne(nodes, edges, o = {}) {
    const n = nodes.length; if (!n) return;
    const W = o.w || 900, H = o.h || 600, iters = o.iter || 380, gap = o.gap == null ? 10 : o.gap;
    const idx = new Map(nodes.map((d, i) => [d.id, i]));
    const links = edges.map(e => ({a: idx.get(e.a), b: idx.get(e.b), w: e.w || 1})).filter(l => l.a !== undefined && l.b !== undefined && l.a !== l.b);
    const deg = nodes.map(() => 0); links.forEach(l => { deg[l.a]++; deg[l.b]++; });
    const order = nodes.map((_, i) => i).sort((i, j) => deg[j] - deg[i] || i - j);
    order.forEach((i, rank) => {   // spiral bunga matahari: simpul berderajat tinggi di tengah (hasil selalu sama untuk data yang sama)
      const ang = rank * 2.399963, r = (o.spread || 46) * Math.sqrt(rank + 0.5);
      Object.assign(nodes[i], {x: W / 2 + Math.cos(ang) * r, y: H / 2 + Math.sin(ang) * r, vx: 0, vy: 0});
    });
    const ld = o.linkDist || 130, charge = o.charge || 1400;
    for (let t = 0; t < iters; t++) {
      const alpha = Math.pow(1 - t / iters, 1.4) * 0.9 + 0.03;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const A = nodes[i], B = nodes[j]; let dx = A.x - B.x, dy = A.y - B.y, d2 = dx * dx + dy * dy;
        if (d2 < 1e-4) { dx = (i - j) * 0.01 + 0.01; dy = 0.01; d2 = dx * dx + dy * dy; }
        const d = Math.sqrt(d2), f = charge / Math.max(d2, 400) * alpha;
        A.vx += dx / d * f; A.vy += dy / d * f; B.vx -= dx / d * f; B.vy -= dy / d * f;
      }
      links.forEach(l => {
        const A = nodes[l.a], B = nodes[l.b], dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 1;
        const target = ld + (A.bw + B.bw) / 4, f = (d - target) * 0.03 * Math.min(2.5, 0.6 + l.w * 0.4) * alpha;
        A.vx += dx / d * f; A.vy += dy / d * f; B.vx -= dx / d * f; B.vy -= dy / d * f;
      });
      nodes.forEach(d => {
        d.vx += (W / 2 - d.x) * 0.012 * alpha; d.vy += (H / 2 - d.y) * 0.012 * alpha;
        if (d.ty !== undefined) d.vy += (d.ty - d.y) * 0.16 * alpha;
      });
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {   // tumbukan kotak: dorong sepanjang sumbu tumpang tindih terkecil
        const A = nodes[i], B = nodes[j], dx = B.x - A.x, dy = B.y - A.y;
        const ox = (A.bw + B.bw) / 2 + gap - Math.abs(dx), oy = (A.bh + B.bh) / 2 + gap - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox < oy) { const s = (dx >= 0 ? 1 : -1) * ox * 0.28; A.vx -= s; B.vx += s; }
          else { const s = (dy >= 0 ? 1 : -1) * oy * 0.28; A.vy -= s; B.vy += s; }
        }
      }
      nodes.forEach(d => { d.vx *= 0.6; d.vy *= 0.6; d.x += Math.max(-40, Math.min(40, d.vx)); d.y += Math.max(-40, Math.min(40, d.vy)); });
    }
  }

  // Kotak pembatas simpul (lingkaran: label menggantung di bawahnya, jadi batas bawah = r + tinggi label).
  function netBBox(nodes) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    nodes.forEach(n => {
      const top = n.kind === 'circle' ? n.r : n.bh / 2, bot = n.kind === 'circle' ? n.r + (n.lh || 0) : n.bh / 2;
      x0 = Math.min(x0, n.x - n.bw / 2); x1 = Math.max(x1, n.x + n.bw / 2); y0 = Math.min(y0, n.y - top); y1 = Math.max(y1, n.y + bot);
    });
    return {x0, y0, x1, y1, w: x1 - x0, h: y1 - y0};
  }
  // Tiap komponen terhubung ditata sendiri, lalu disusun berbaris (shelf packing): garis tidak melintasi komponen lain
  // dan gravitasi tidak menumpuk semuanya di satu titik.
  function netLayout(nodes, edges, o = {}) {
    if (!nodes.length) return;
    const byId = new Map(nodes.map(d => [d.id, d])), adj = new Map(nodes.map(d => [d.id, []]));
    edges.forEach(e => { if (byId.has(e.a) && byId.has(e.b) && e.a !== e.b) { adj.get(e.a).push(e.b); adj.get(e.b).push(e.a); } });
    const seen = new Set(), comps = [];
    nodes.forEach(d => {
      if (seen.has(d.id)) return;
      const comp = [], st = [d.id]; seen.add(d.id);
      while (st.length) { const k = st.pop(); comp.push(byId.get(k)); adj.get(k).forEach(m => { if (!seen.has(m)) { seen.add(m); st.push(m); } }); }
      comps.push(comp);
    });
    if (comps.length === 1) { netLayoutOne(nodes, edges, o); return; }
    const boxes = comps.map(c => {
      const ids = new Set(c.map(d => d.id));
      netLayoutOne(c, edges.filter(e => ids.has(e.a) && ids.has(e.b)), {...o, w: Math.min(o.w || 900, 160 + c.length * 70), h: Math.min(o.h || 600, 130 + c.length * 55)});
      return {c, b: netBBox(c)};
    }).sort((p, q) => q.b.w * q.b.h - p.b.w * p.b.h);
    const GAP = o.packGap || 44, area = boxes.reduce((t, k) => t + (k.b.w + GAP) * (k.b.h + GAP), 0);
    const rowW = Math.max(boxes[0].b.w, Math.sqrt(area * (o.aspect || 1.5)));
    let x = 0, y = 0, rowH = 0;
    boxes.forEach(k => {
      if (x > 0 && x + k.b.w > rowW) { x = 0; y += rowH + GAP; rowH = 0; }
      k.c.forEach(d => { d.x += x - k.b.x0; d.y += y - k.b.y0; });
      x += k.b.w + GAP; rowH = Math.max(rowH, k.b.h);
    });
  }

  // Klaster = label propagation berbobot (deterministik). Return indeks klaster per simpul, klaster terbesar = 0.
  function netCommunities(nodes, edges) {
    const idx = new Map(nodes.map((d, i) => [d.id, i])), adj = nodes.map(() => new Map());
    edges.forEach(e => {
      const a = idx.get(e.a), b = idx.get(e.b); if (a === undefined || b === undefined || a === b) return;
      adj[a].set(b, (adj[a].get(b) || 0) + (e.w || 1)); adj[b].set(a, (adj[b].get(a) || 0) + (e.w || 1));
    });
    const lab = nodes.map((_, i) => i);
    for (let it = 0; it < 40; it++) {
      let changed = false;
      for (let i = 0; i < nodes.length; i++) {
        if (!adj[i].size) continue;
        const sc = new Map(); adj[i].forEach((w, j) => sc.set(lab[j], (sc.get(lab[j]) || 0) + w));
        let best = lab[i], bw = sc.get(lab[i]) || 0;
        sc.forEach((w, l) => { if (w > bw || (w === bw && l < best)) { best = l; bw = w; } });
        if (best !== lab[i]) { lab[i] = best; changed = true; }
      }
      if (!changed) break;
    }
    const size = new Map(); lab.forEach(l => size.set(l, (size.get(l) || 0) + 1));
    const rank = new Map([...size.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map((x, i) => [x[0], i]));
    return lab.map(l => rank.get(l));
  }

  // Penggambar umum. cfg: {id, cls, label, directed, nodes, edges, layout, edgeWidth(e), edgeColor(e), onSelect(node|null), onEdge(edge|null)}
  // nodes: {id, kind:'circle'|'box', r | w,h, color, label, lines, sub, tip, [lw, lh]}; edges: {a, b, w, label}
  function netView(canvas, cfg) {
    const nodes = cfg.nodes, edges = cfg.edges, directed = !!cfg.directed, byId = new Map(nodes.map(n => [n.id, n]));
    nodes.forEach(n => { n.bw = n.kind === 'circle' ? Math.max(2 * n.r, n.lw || 0) : n.w; n.bh = n.kind === 'circle' ? 2 * n.r + (n.lh || 0) : n.h; });
    netLayout(nodes, edges, cfg.layout || {});
    const bb = netBBox(nodes), PAD = 34, W = Math.ceil(bb.w + PAD * 2), H = Math.ceil(bb.h + PAD * 2);
    nodes.forEach(n => { n.x += PAD - bb.x0; n.y += PAD - bb.y0; });
    const pk = (a, b) => a + '\u0001' + b, has = new Set(edges.map(e => pk(e.a, e.b)));
    edges.forEach((e, i) => { e._i = i; e.bend = directed && has.has(pk(e.b, e.a)) ? 24 : 0; });
    const endPoint = (n, tx, ty) => {
      const dx = tx - n.x, dy = ty - n.y, d = Math.hypot(dx, dy) || 1;
      if (n.kind === 'circle') return [n.x + dx / d * (n.r + 1.5), n.y + dy / d * (n.r + 1.5)];
      const k = Math.min((n.w / 2 + 2) / (Math.abs(dx) || 1e-6), (n.h / 2 + 2) / (Math.abs(dy) || 1e-6), 1);
      return [n.x + dx * k, n.y + dy * k];
    };
    const geom = e => {
      const a = byId.get(e.a), b = byId.get(e.b), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      const cx = mx - dy / d * e.bend, cy = my + dx / d * e.bend, p = endPoint(a, cx, cy), q = endPoint(b, cx, cy);
      return {d: `M${p[0].toFixed(1)} ${p[1].toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`, lx: 0.25 * p[0] + 0.5 * cx + 0.25 * q[0], ly: 0.25 * p[1] + 0.5 * cy + 0.25 * q[1]};
    };
    const uid = cfg.id || 'net', halo = 'stroke="#000000" stroke-width="3" paint-order="stroke" stroke-linejoin="round"';
    const edgeSvg = edges.map(e => {
      const g = geom(e), sw = cfg.edgeWidth ? cfg.edgeWidth(e) : 1.3, col = cfg.edgeColor ? cfg.edgeColor(e) : '#9a9a9a';
      return `<g class="net-eg" data-i="${e._i}" style="cursor:${cfg.onEdge ? 'pointer' : 'default'}"><path class="net-hit" d="${g.d}" fill="none" stroke="#000000" stroke-opacity="0" stroke-width="12"/><path class="net-edge" d="${g.d}" fill="none" stroke="${col}" stroke-opacity="0.6" stroke-width="${sw}"${directed ? ` marker-end="url(#${uid}-arrow)"` : ''}/>`
        + (e.label ? `<text class="net-elabel" x="${g.lx.toFixed(1)}" y="${(g.ly + 3).toFixed(1)}" text-anchor="middle" font-family="${NET_FONT}" font-size="10" fill="#e8e8e8" ${halo} style="opacity:0;pointer-events:none">${esc(e.label)}</text>` : '') + '</g>';
    }).join('');
    const nodeSvg = nodes.map(n => {
      let body;
      if (n.kind === 'circle') {
        const L = n.lines || [n.label];
        body = `<circle r="${n.r}" fill="${n.color}" fill-opacity="0.95" stroke="#000000" stroke-width="2"/><text text-anchor="middle" font-family="${NET_FONT}" font-size="${n.fs || 11}" font-weight="500" fill="#e8e8e8" ${halo}>${L.map((t, i) => `<tspan x="0" y="${(n.r + 13 + i * 12).toFixed(1)}">${esc(t)}</tspan>`).join('')}</text>`;
      } else {
        const L = n.lines || [n.label], top = -n.h / 2 + 16;
        body = `<rect x="${-n.w / 2}" y="${-n.h / 2}" width="${n.w}" height="${n.h}" rx="6" fill="#101010" stroke="#3a3a3a" stroke-width="1.2"/><rect x="${-n.w / 2}" y="${-n.h / 2}" width="5" height="${n.h}" rx="2" fill="${n.color}"/>`
          + `<text font-family="${NET_FONT}" font-size="11" font-weight="700" fill="#ffffff">${L.map((t, i) => `<tspan x="${-n.w / 2 + 14}" y="${(top + i * 13).toFixed(1)}">${esc(t)}</tspan>`).join('')}</text>`
          + (n.sub ? `<text x="${-n.w / 2 + 14}" y="${(top + L.length * 13 + 1).toFixed(1)}" font-family="${NET_FONT}" font-size="9" fill="#9a9a9a">${esc(n.sub)}</text>` : '');
      }
      return `<g class="net-node" data-id="${esc(n.id)}" transform="translate(${n.x.toFixed(1)},${n.y.toFixed(1)})" style="cursor:grab;touch-action:none"><title>${esc(n.tip || n.label)}</title>${body}</g>`;
    }).join('');
    canvas.innerHTML = `<svg class="${cfg.cls || ''} net-svg" ${cfg.svgId ? `id="${cfg.svgId}" ` : ''}${W > 1000 ? `style="width:${W}px;max-width:none;min-width:0;max-height:none" ` : ''}xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(cfg.label || 'Jaringan')}"><defs><marker id="${uid}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#9a9a9a"/></marker></defs><rect width="100%" height="100%" fill="#000000"/><g>${edgeSvg}</g><g>${nodeSvg}</g></svg>`;
    const svg = canvas.querySelector('svg'), nodeEls = new Map([...svg.querySelectorAll('.net-node')].map(g => [g.dataset.id, g]));
    const edgeEls = [...svg.querySelectorAll('.net-eg')];
    const nbr = new Map(nodes.map(n => [n.id, new Set([n.id])])); edges.forEach(e => { nbr.get(e.a).add(e.b); nbr.get(e.b).add(e.a); });
    let sel = null, selEdge = null;
    const paint = (fid, fe) => {
      const on = fid != null || fe != null;
      nodeEls.forEach((g, id) => { const hit = fid != null ? nbr.get(fid).has(id) : fe != null ? (id === edges[fe].a || id === edges[fe].b) : true; g.style.opacity = !on || hit ? 1 : 0.16; });
      edgeEls.forEach(g => {
        const i = +g.dataset.i, e = edges[i], hit = fid != null ? (e.a === fid || e.b === fid) : fe != null ? i === fe : false;
        g.style.opacity = !on || hit ? 1 : 0.07; const lb = g.querySelector('.net-elabel'); if (lb) lb.style.opacity = hit ? 1 : 0;
        const pth = g.querySelector('.net-edge'); if (pth) pth.setAttribute('stroke-opacity', hit ? 0.95 : 0.6);
      });
    };
    const place = () => {
      nodeEls.forEach((g, id) => { const n = byId.get(id); g.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`); });
      edgeEls.forEach(g => { const e = edges[+g.dataset.i], q = geom(e); g.querySelectorAll('path').forEach(p => p.setAttribute('d', q.d)); const lb = g.querySelector('.net-elabel'); if (lb) { lb.setAttribute('x', q.lx.toFixed(1)); lb.setAttribute('y', (q.ly + 3).toFixed(1)); } });
    };
    const pt = svg.createSVGPoint(), toSvg = ev => { pt.x = ev.clientX; pt.y = ev.clientY; const m = svg.getScreenCTM(); return m ? pt.matrixTransform(m.inverse()) : {x: ev.clientX, y: ev.clientY}; };
    const choose = id => { sel = id; selEdge = null; paint(sel, null); if (cfg.onSelect) cfg.onSelect(id == null ? null : byId.get(id)); };
    let drag = null;
    svg.addEventListener('pointerdown', ev => {
      const g = ev.target.closest('.net-node'); if (!g) return;
      const n = byId.get(g.dataset.id), p = toSvg(ev); drag = {n, g, ox: p.x - n.x, oy: p.y - n.y, sx: ev.clientX, sy: ev.clientY, moved: false};
      try { g.setPointerCapture(ev.pointerId); } catch (_) { /* abaikan */ }
      g.style.cursor = 'grabbing';
    });
    svg.addEventListener('pointermove', ev => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 4) return;
      drag.moved = true; const p = toSvg(ev);
      drag.n.x = Math.max(drag.n.bw / 2, Math.min(W - drag.n.bw / 2, p.x - drag.ox)); drag.n.y = Math.max(10, Math.min(H - 10, p.y - drag.oy)); place();
    });
    const end = () => { if (!drag) return; const d = drag; drag = null; d.g.style.cursor = 'grab'; if (!d.moved) choose(sel === d.n.id ? null : d.n.id); };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', () => { drag = null; });
    svg.addEventListener('pointerover', ev => { if (drag) return; const g = ev.target.closest('.net-node'); if (g) paint(g.dataset.id, null); else { const eg = ev.target.closest('.net-eg'); if (eg && cfg.onEdge) paint(null, +eg.dataset.i); } });
    svg.addEventListener('pointerout', ev => { if (drag) return; if (ev.target.closest('.net-node') || ev.target.closest('.net-eg')) paint(sel, selEdge); });
    svg.addEventListener('click', ev => {
      const eg = ev.target.closest('.net-eg'); if (eg && cfg.onEdge && !ev.target.closest('.net-node')) { selEdge = +eg.dataset.i; sel = null; paint(null, selEdge); cfg.onEdge(edges[selEdge]); return; }
      if (!ev.target.closest('.net-node') && (sel != null || selEdge != null)) { sel = null; selEdge = null; paint(null, null); if (cfg.onSelect) cfg.onSelect(null); }
    });
    const handle = {svg, clear: () => { sel = null; selEdge = null; paint(null, null); }};
    canvas._net = handle;
    return handle;
  }

  // ---- Normalisasi istilah (sinonim dan ejaan Inggris/Amerika digabung) ----
  const CC_STOP = new Set(['dengan', 'dalam', 'untuk', 'pada', 'yang', 'dan', 'atau', 'the', 'and', 'for', 'with', 'from', 'this', 'that', 'study', 'research', 'analysis', 'based', 'using', 'based on', 'method', 'methods', 'model', 'models', 'approach', 'paper']);
  function ccCanon(raw) {
    let t = String(raw == null ? '' : raw).replace(/\s*\([^)]*\)/g, ' ').replace(/optimis/gi, m => m.slice(0, -1) + (m.slice(-1) === 's' ? 'z' : 'Z')).replace(/\bprograms?\b/gi, m => /^P/.test(m) ? 'Programming' : 'programming').replace(/\s+/g, ' ').trim();
    t = t.replace(/\s+(framework|approach)$/i, '').trim();
    const key = t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').map(w => w.length > 4 && w.endsWith('s') && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w).join(' ');
    return {key, display: t};
  }
  function ccDocs() {
    const inc = list(state.articles).filter(a => a.screening_decision === 'include' && a.eligibility_decision === 'include');
    return inc.length ? inc : list(state.articles).filter(a => ['success', 'ok'].includes(a.extraction_status));
  }
  function ccBuild(docs, hideDominant, min) {
    const info = new Map(), per = [];
    docs.forEach(a => {
      const ext = a.extraction || a, seen = new Set();
      let raw = [...list(ext.topic_tags), ...list(ext.concepts).map(c => (c && typeof c === 'object') ? c.name : c), ...list(ext.keywords)];
      if (!raw.length) raw = [ext.title, ext.abstract].filter(Boolean).join(' ').match(/[A-Za-z][A-Za-z-]{3,}/g) || [];
      raw.forEach(x => {
        const c = ccCanon(x); if (c.key.length < 3 || CC_STOP.has(c.key)) return;
        let o = info.get(c.key); if (!o) info.set(c.key, o = {key: c.key, names: new Map(), docs: new Set()});
        o.names.set(c.display, (o.names.get(c.display) || 0) + 1); o.docs.add(a.id); seen.add(c.key);
      });
      per.push([...seen].slice(0, 20));
    });
    info.forEach(o => { o.label = [...o.names.entries()].sort((p, q) => q[1] - p[1] || p[0].length - q[0].length)[0][0]; o.n = o.docs.size; });
    const hidden = hideDominant && docs.length >= 4 ? [...info.values()].filter(o => o.n / docs.length >= 0.6).sort((a, b) => b.n - a.n) : [];
    const hid = new Set(hidden.map(o => o.key));
    const keep = [...info.values()].filter(o => o.n >= min && !hid.has(o.key)).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)).slice(0, 45);
    const ks = new Set(keep.map(o => o.key)), pairs = new Map();
    per.forEach(terms => { const t = terms.filter(k => ks.has(k)); for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) { const k = [t[i], t[j]].sort().join('\u0001'); pairs.set(k, (pairs.get(k) || 0) + 1); } });
    const edges = [...pairs.entries()].map(([k, v]) => { const [a, b] = k.split('\u0001'); return {a, b, w: v}; }).sort((p, q) => q.w - p.w).slice(0, 140);
    return {keep, edges, hidden, info};
  }
  function renderCooccurrence() {
    const canvas = $('#cooccurrence-canvas'), meta = $('#cooccurrence-meta'), legend = $('#cooccurrence-legend'), detail = $('#cooccurrence-detail');
    if (!canvas) return;
    detail.classList.add('hidden'); legend.innerHTML = '';
    const docs = ccDocs();
    if (!docs.length) { canvas.innerHTML = '<div class="empty-state">Belum ada artikel hasil ekstraksi. Unggah dan ekstraksi PDF terlebih dahulu.</div>'; meta.textContent = 'Belum ada data'; return; }
    const min = Number($('#cooccurrence-min')?.value || 2), hideDom = $('#cooccurrence-dominant') ? $('#cooccurrence-dominant').checked : true;
    const B = ccBuild(docs, hideDom, min), refs = scopeRefs();
    if (!B.keep.length) { canvas.innerHTML = '<div class="empty-state">Belum ada istilah yang berulang pada minimum ini. Turunkan minimum kemunculan menjadi 1.</div>'; meta.textContent = `${docs.length} artikel diperiksa`; return; }
    const max = Math.max(...B.keep.map(o => o.n)), byKey = new Map(B.keep.map(o => [o.key, o]));
    const nodes = B.keep.map(o => { const lines = netLines(o.label, 26, 2); return {id: o.key, kind: 'circle', r: +(6 + 13 * Math.sqrt(o.n / max)).toFixed(1), label: o.label, lines, lw: Math.max(...lines.map(l => l.length)) * 5.9, lh: lines.length * 12 + 6, fs: 11, o, tip: `${o.label} — ${o.n} artikel`}; });
    const cl = netCommunities(nodes, B.edges), nById = new Map(nodes.map(n => [n.id, n]));
    nodes.forEach((n, i) => { n.cl = cl[i]; n.color = NET_PAL[cl[i] % NET_PAL.length]; });
    const nb = new Map(nodes.map(n => [n.id, []])); B.edges.forEach(e => { nb.get(e.a).push([e.b, e.w]); nb.get(e.b).push([e.a, e.w]); });
    netView(canvas, {
      id: 'cc', cls: 'cooccur-svg', svgId: 'cooccurrence-svg', label: 'Jaringan co-occurrence istilah', nodes, edges: B.edges,
      layout: {linkDist: 110, charge: 1800, spread: 40, w: 900, h: 620},
      edgeWidth: e => Math.min(5, 0.8 + e.w * 0.9), edgeColor: e => { const A = nById.get(e.a), B = nById.get(e.b); return A.cl === B.cl ? A.color : '#9a9a9a'; },
      onSelect: n => {
        if (!n) { detail.classList.add('hidden'); return; }
        const co = nb.get(n.id).sort((p, q) => q[1] - p[1]).slice(0, 8).map(([k, w]) => `${esc(byKey.get(k).label)} <span class="dim">(${w})</span>`).join(' · ');
        const arts = [...n.o.docs].map(id => findArticle(id)).filter(Boolean).map(a => `<li><span class="dg-ref">[${esc(refs[a.id] || '?')}]</span> ${esc(a.title || '(tanpa judul)')} <span class="dim">(${esc(a.year || 'n.d.')})</span></li>`).join('');
        detail.innerHTML = `<h3>${esc(n.label)}</h3><div class="dim">Muncul di ${n.o.n} dari ${docs.length} artikel · klaster ${n.cl + 1}</div>${co ? `<p><b>Sering bersama:</b> ${co}</p>` : '<p class="dim">Tidak berpasangan dengan istilah lain pada pengaturan ini.</p>'}<ul>${arts}</ul>`;
        detail.classList.remove('hidden');
      },
    });
    const groups = new Map(); nodes.forEach(n => { if (!groups.has(n.cl)) groups.set(n.cl, []); groups.get(n.cl).push(n); });
    legend.innerHTML = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([c, ns]) => `<span class="map-legend-chip" title="${esc(ns.map(n => n.label).join(', '))}"><span style="background:${NET_PAL[c % NET_PAL.length]}"></span>Klaster ${c + 1} · ${ns.length} istilah: ${esc(ns.slice(0, 3).map(n => n.label).join(', '))}${ns.length > 3 ? '…' : ''}</span>`).join('');
    meta.innerHTML = `${docs.length} artikel · ${nodes.length} istilah · ${B.edges.length} hubungan · ${groups.size} klaster${B.hidden.length ? ` · disembunyikan karena muncul di ≥60% artikel: <b>${esc(B.hidden.map(o => o.label).join(', '))}</b>` : ''}`;
  }

  // ---- System map: dibangun kode dari hubungan (relationships) yang sudah diekstrak per artikel; tanpa AI tambahan ----
  function smBuild(opts) {
    const docs = ccDocs(), ents = new Map(), E = new Map();
    const ent = raw => {
      const c = ccCanon(raw); if (c.key.length < 2) return null;
      let o = ents.get(c.key); if (!o) ents.set(c.key, o = {key: c.key, names: new Map(), arts: new Set(), out: 0, inn: 0, hier: 0});
      o.names.set(c.display, (o.names.get(c.display) || 0) + 1); return o;
    };
    const link = (A, B, rel, ev, art, kind) => {
      const k = A.key + '\u0001' + B.key + '\u0001' + kind; let e = E.get(k);
      if (!e) E.set(k, e = {a: A.key, b: B.key, kind, rels: new Map(), ev: [], arts: new Set()});
      if (rel) e.rels.set(rel, (e.rels.get(rel) || 0) + 1);
      e.ev.push({id: art, rel, text: ev}); e.arts.add(art); A.arts.add(art); B.arts.add(art);
    };
    docs.forEach(a => {
      const ext = a.extraction || a;
      list(ext.relationships).forEach(r => {
        if (!r || typeof r !== 'object') return;
        const A = ent(r.source), B = ent(r.target); if (!A || !B || A === B) return;
        link(A, B, String(r.relation || '').trim(), String(r.evidence || '').trim(), a.id, 'rel');
      });
      if (opts.hier) list(ext.concepts).forEach(c => {
        if (!c || typeof c !== 'object' || !c.name) return;
        list(c.parent_concepts).forEach(p => { const A = ent(p), B = ent(c.name); if (A && B && A !== B) link(A, B, 'konsep turunan', '', a.id, 'hier'); });
      });
    });
    let edges = [...E.values()]; edges.forEach(e => { const A = ents.get(e.a), B = ents.get(e.b); if (e.kind === 'rel') { A.out++; B.inn++; } else { A.hier++; B.hier++; } });
    let nodes = [...ents.values()].filter(o => o.out + o.inn + o.hier > 0);
    nodes.forEach(o => { o.label = [...o.names.entries()].sort((p, q) => q[1] - p[1] || p[0].length - q[0].length)[0][0]; o.role = o.out + o.inn === 0 ? 'konsep' : o.inn === 0 ? 'asal' : o.out === 0 ? 'tujuan' : 'perantara'; o.score = (o.out + o.inn + o.hier) + o.arts.size * 0.5; });
    if (opts.main && nodes.length) {   // hanya komponen terhubung terbesar
      const adj = new Map(nodes.map(o => [o.key, []])); edges.forEach(e => { adj.get(e.a).push(e.b); adj.get(e.b).push(e.a); });
      const seen = new Set(); let best = [];
      nodes.forEach(o => { if (seen.has(o.key)) return; const comp = [], st = [o.key]; seen.add(o.key); while (st.length) { const k = st.pop(); comp.push(k); adj.get(k).forEach(m => { if (!seen.has(m)) { seen.add(m); st.push(m); } }); } if (comp.length > best.length) best = comp; });
      const bs = new Set(best); nodes = nodes.filter(o => bs.has(o.key)); edges = edges.filter(e => bs.has(e.a) && bs.has(e.b));
    }
    const total = nodes.length;
    if (opts.max && nodes.length > opts.max) { nodes = nodes.sort((p, q) => q.score - p.score || p.label.localeCompare(q.label)).slice(0, opts.max); const ks = new Set(nodes.map(o => o.key)); edges = edges.filter(e => ks.has(e.a) && ks.has(e.b)); }
    const used = new Set(); edges.forEach(e => { used.add(e.a); used.add(e.b); }); nodes = nodes.filter(o => used.has(o.key));
    return {docs, nodes, edges, total};
  }
  const SM_ROLE = {asal: {name: 'Asal hubungan', color: '#dcb85c', hint: 'hanya menunjuk ke konsep lain (mis. metode atau faktor yang diklaim memengaruhi)'}, perantara: {name: 'Perantara', color: '#ffffff', hint: 'menerima dan meneruskan hubungan'}, tujuan: {name: 'Tujuan hubungan', color: '#9fd09f', hint: 'hanya ditunjuk oleh konsep lain (mis. hasil atau target)'}, konsep: {name: 'Hanya hierarki konsep', color: '#86b4d8', hint: 'terhubung lewat induk-turunan konsep'}};
  function renderSystemMap() {
    const canvas = $('#system-map-canvas'), legend = $('#system-map-legend'), meta = $('#system-map-meta'), detail = $('#system-map-detail');
    if (!canvas) return;
    detail.classList.add('hidden'); legend.innerHTML = '';
    const docs = ccDocs();
    if (!docs.length) { canvas.innerHTML = '<div class="empty-state">Belum ada artikel hasil ekstraksi. Unggah dan ekstraksi PDF terlebih dahulu.</div>'; meta.textContent = 'Belum ada system map'; return; }
    const M = smBuild({hier: $('#system-map-hier')?.checked, main: $('#system-map-main')?.checked, max: Number($('#system-map-max')?.value || 40)});
    if (!M.nodes.length) { canvas.innerHTML = '<div class="empty-state">Belum ada hubungan antarkonsep pada artikel ini. Hubungan diambil dari hasil ekstraksi tiap artikel; ekstrak ulang artikel jika kosong.</div>'; meta.textContent = `${docs.length} artikel diperiksa`; return; }
    const refs = scopeRefs(), byKey = new Map(M.nodes.map(o => [o.key, o]));
    const nodes = M.nodes.map(o => {
      const lines = netLines(o.label, 22, 3), w = Math.max(96, Math.min(176, Math.max(...lines.map(l => l.length)) * 6.3 + 30));
      return {id: o.key, kind: 'box', w: Math.round(w), h: lines.length * 13 + 30, lines, color: SM_ROLE[o.role].color, label: o.label, sub: `${SM_ROLE[o.role].name.toUpperCase()} · ${o.arts.size} artikel`, tip: `${o.label}\n${SM_ROLE[o.role].name}: ${SM_ROLE[o.role].hint}\n${o.arts.size} artikel`, o};
    });
    const edges = M.edges.map(e => {
      const top = [...e.rels.entries()].sort((p, q) => q[1] - p[1])[0];
      return {a: e.a, b: e.b, w: e.arts.size, label: e.kind === 'hier' ? 'konsep turunan' : (top ? top[0].slice(0, 60) : 'berhubungan'), e};
    });
    const byId = new Map(nodes.map(n => [n.id, n]));
    const evList = e => e.ev.map(v => { const a = findArticle(v.id); return `<li><span class="dg-ref">[${esc(refs[v.id] || '?')}]</span> ${esc(v.rel || 'hubungan')}${v.text ? `<blockquote>“${esc(v.text.slice(0, 220))}”</blockquote>` : ''}<span class="dim">${esc(a ? a.title : '')}</span></li>`; }).join('');
    const showEdge = ed => { detail.innerHTML = `<h3>${esc(byKey.get(ed.e.a).label)} → ${esc(byKey.get(ed.e.b).label)}</h3><div class="dim">${ed.e.arts.size} artikel mendukung · kutipan di bawah adalah teks asli dari artikel</div><ul>${evList(ed.e)}</ul>`; detail.classList.remove('hidden'); };
    netView(canvas, {
      id: 'sm', cls: 'system-map-svg', svgId: 'system-map-svg', label: 'System map hubungan antarkonsep', directed: true, nodes, edges,
      layout: {linkDist: 200, charge: 9000, spread: 90, w: 1100, h: 800, gap: 22, aspect: 1.9},
      edgeWidth: e => Math.min(4, 1.2 + (e.w - 1) * 0.9), edgeColor: e => e.e.kind === 'hier' ? '#86b4d8' : '#9a9a9a', onEdge: showEdge,
      onSelect: n => {
        if (!n) { detail.classList.add('hidden'); return; }
        const out = edges.filter(x => x.a === n.id), inn = edges.filter(x => x.b === n.id);
        const row = (x, dir) => `<li>${dir === 'out' ? '→ ' : '← '}<b>${esc(byKey.get(dir === 'out' ? x.b : x.a).label)}</b> <span class="dim">· ${esc(x.label)} · ${esc(fmtRefs(x.e.ev.map(v => v.id), refs))}</span></li>`;
        detail.innerHTML = `<h3>${esc(n.label)}</h3><div class="dim">${esc(SM_ROLE[n.o.role].name)}: ${esc(SM_ROLE[n.o.role].hint)} · ${n.o.arts.size} artikel ${esc(fmtRefs([...n.o.arts], refs))}</div>`
          + (out.length ? `<p><b>Menunjuk ke</b></p><ul>${out.map(x => row(x, 'out')).join('')}</ul>` : '') + (inn.length ? `<p><b>Ditunjuk oleh</b></p><ul>${inn.map(x => row(x, 'in')).join('')}</ul>` : '')
          + '<p class="dim">Klik panah untuk melihat kutipan bukti.</p>';
        detail.classList.remove('hidden');
      },
    });
    const cnt = {}; M.nodes.forEach(o => { cnt[o.role] = (cnt[o.role] || 0) + 1; });
    legend.innerHTML = Object.keys(SM_ROLE).filter(k => cnt[k]).map(k => `<span class="map-legend-chip" title="${esc(SM_ROLE[k].hint)}"><span style="background:${SM_ROLE[k].color}"></span>${esc(SM_ROLE[k].name)} (${cnt[k]})</span>`).join('');
    meta.textContent = `${M.nodes.length}${M.total > M.nodes.length ? ` dari ${M.total}` : ''} konsep · ${M.edges.length} hubungan · ${M.docs.length} artikel`;
  }

  // ---- Peta topik: pohon hierarki (kolom per kedalaman, label dibungkus, jumlah artikel dan nomor rujukan) ----
  function topicTreeSvg(root, nodes) {
    const refs = scopeRefs(), kids = {}; nodes.forEach(n => { (kids[n.parent_id || root.id] = kids[n.parent_id || root.id] || []).push(n); });
    const build = (n, depth, branch) => {
      const ch = (kids[n.id] || []).map((k, i) => build(k, depth + 1, depth === 0 ? i : branch));
      const ids = list(n.article_ids).length ? list(n.article_ids) : [...new Set(ch.flatMap(c => c.ids))];
      return {id: n.id, name: String(n.name || n.label || n.id || 'Konsep'), desc: n.description || '', depth, branch, ids, ch};
    };
    const tree = build(root, 0, 0);
    const walk = (n, f) => { f(n); n.ch.forEach(c => walk(c, f)); };
    walk(tree, n => {
      n.lines = dgWrap(n.name, 28); const rs = n.depth ? fmtRefs(n.ids, refs) : ''; n.rl = rs ? dgWrap(rs, 28) : [];
      n.h = Math.max(28, (n.lines.length + n.rl.length) * 14.5 + 11);
      n.w = Math.round(Math.max(...n.lines.concat(n.rl).map(l => l.length)) * 7.1 + 34 + (n.depth && n.ids.length ? 28 : 0));
    });
    const cols = []; walk(tree, n => { cols[n.depth] = Math.max(cols[n.depth] || 0, n.w); });
    const xs = []; cols.forEach((w, i) => { xs[i] = i ? xs[i - 1] + cols[i - 1] + 56 : 0; });
    const need = n => { n.need = Math.max(n.h + 10, n.ch.reduce((t, c) => t + need(c), 0)); return n.need; }; need(tree);
    (function pos(n, top) { n.x = xs[n.depth]; if (!n.ch.length) { n.y = top + n.need / 2; return; } const sum = n.ch.reduce((t, c) => t + c.need, 0); let cur = top + (n.need - sum) / 2; n.ch.forEach(c => { pos(c, cur); cur += c.need; }); n.y = (n.ch[0].y + n.ch[n.ch.length - 1].y) / 2; })(tree, 0);
    const PAD = 24, W = xs[xs.length - 1] + cols[cols.length - 1] + PAD * 2, H = tree.need + PAD * 2, colOf = n => n.depth === 0 ? '#ffffff' : NET_PAL[n.branch % NET_PAL.length];
    let links = '', boxes = '';
    walk(tree, n => {
      n.ch.forEach(c => { const sx = n.x + n.w, xm = (sx + c.x) / 2; links += `<path d="M${sx} ${n.y.toFixed(1)}C${xm} ${n.y.toFixed(1)} ${xm} ${c.y.toFixed(1)} ${c.x} ${c.y.toFixed(1)}" fill="none" stroke="${colOf(c)}" stroke-opacity="0.55" stroke-width="1.4"/>`; });
      const col = colOf(n), root0 = n.depth === 0, L = n.lines.concat(n.rl), top = -(L.length - 1) / 2 * 14.5 + 4.2;
      boxes += `<g transform="translate(${n.x},${n.y.toFixed(1)})"><title>${esc(n.name + (n.desc ? '\n' + n.desc : ''))}</title><rect x="0" y="${-n.h / 2}" width="${n.w}" height="${n.h}" rx="6" fill="${root0 ? col : '#101010'}" stroke="${n.depth === 1 ? col : root0 ? col : '#3a3a3a'}" stroke-width="${n.depth === 1 ? 1.8 : 1}"/>`
        + (n.depth > 1 ? `<rect x="7" y="-3" width="6" height="6" fill="${col}"/>` : '')
        + `<text font-family="${NET_FONT}" font-size="12" font-weight="${root0 ? 800 : n.depth === 1 ? 700 : 500}" fill="${root0 ? '#000000' : n.depth === 1 ? col : '#e8e8e8'}">${L.map((t, i) => `<tspan x="${n.depth > 1 ? 19 : 12}" y="${(top + i * 14.5).toFixed(1)}"${i >= n.lines.length ? ` fill="#9a9a9a" font-size="11" font-weight="400"` : ''}>${esc(t)}</tspan>`).join('')}</text>`
        + (n.depth && n.ids.length ? `<rect x="${n.w - 28}" y="-8.5" width="23" height="17" rx="6" fill="${col}" fill-opacity="0.18"/><text x="${n.w - 16.5}" y="4" text-anchor="middle" font-family="${NET_FONT}" font-size="11" font-weight="700" fill="${col}">${n.ids.length}</text>` : '') + '</g>';
    });
    return `<div class="system-map-canvas"><svg class="taxonomy-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:${W}px;max-width:none;min-width:0;max-height:none" role="img" aria-label="Diagram peta topik"><rect width="100%" height="100%" fill="#000000"/><g transform="translate(${PAD},${PAD})">${links}${boxes}</g></svg></div>`;
  }
  // ---- Poly-hierarchy: graf berlapis (induk di atas), satu konsep boleh punya beberapa induk ----
  function polyDiagram(canvas, nodes, edges) {
    const ids = new Set(nodes.map(n => String(n.id))), seen = new Set(), es = [];
    const add = (p, c, label) => { if (!ids.has(p) || !ids.has(c) || p === c || seen.has(p + '>' + c)) return; seen.add(p + '>' + c); es.push({a: p, b: c, w: 1, label: label || 'subkategori dari'}); };
    list(edges).forEach(e => add(String(e.from || e.source), String(e.to || e.target), e.relation));
    nodes.forEach(n => list(n.parent_ids).forEach(p => add(String(p), String(n.id))));
    const par = new Map(nodes.map(n => [String(n.id), []])); es.forEach(e => par.get(e.b).push(e.a));
    const depth = new Map(), lvl = (id, trail) => { if (depth.has(id)) return depth.get(id); if (trail.has(id)) return 0; trail.add(id); const d = par.get(id).length ? 1 + Math.max(...par.get(id).map(p => lvl(p, trail))) : 0; trail.delete(id); depth.set(id, d); return d; };
    const vn = nodes.map((n, i) => {
      const id = String(n.id), lines = netLines(String(n.name || id), 22, 3), d = lvl(id, new Set());
      return {id, kind: 'box', w: Math.round(Math.max(96, Math.min(176, Math.max(...lines.map(l => l.length)) * 6.3 + 30))), h: lines.length * 13 + 30, lines, color: NET_PAL[d % NET_PAL.length], label: String(n.name || id), sub: `${list(n.article_ids).length} artikel`, tip: `${n.name || id}${n.description ? '\n' + n.description : ''}`, ty: 70 + d * 140};
    });
    return netView(canvas, {id: 'poly', cls: 'taxonomy-svg', label: 'Diagram poly-hierarchy', directed: true, nodes: vn, edges: es, layout: {linkDist: 120, charge: 2600, spread: 70, w: 960, h: 520, gap: 16}});
  }


  // ---------------------------------------------------------------- Desain Riset (research onion)
  let codebook = null, designResult = null, designReq = 0, designRefs = {};
  // Versi analisis terbaru dari server (sumber tunggal: ANALYSIS_VERSION di app.py); 3 = cadangan bila codebook belum termuat.
  function currentAnalysisVersion() { return (codebook && codebook.analysis_version) || 3; }
  async function loadCodebook() {
    if (codebook) return codebook;
    try { codebook = await api('/api/codebook'); } catch (_) { codebook = {fields: {}}; }
    return codebook;
  }
  function cbLabel(field, key) {
    const spec = ((codebook || {}).fields || {})[field];
    return spec && spec.values && spec.values[key] ? spec.values[key].label : key;
  }
  function designScopeArticles() {
    const scope = (state.designUi || {}).scope || 'notexcluded';
    return state.articles.filter(a => a.extraction_status !== 'failed' && (
      scope === 'all' ? true
      : scope === 'included' ? (a.screening_decision === 'include' && a.eligibility_decision === 'include')
      : (a.screening_decision !== 'exclude' && a.eligibility_decision !== 'exclude')));
  }
  // 'dinyatakan' hanya jujur untuk label eksplisit (kodenya memeriksa bahwa kutipan memuat istilahnya). Untuk label lain,
  // kode hanya memastikan kutipan ADA di PDF, jadi tulisannya 'didukung kutipan'.
  function isExplicitLabel(field, code) { return (((codebook || {}).explicit_terms || {})[field] || []).includes(code); }
  function basisBadge(item, field, code) {
    if (!item || item.basis === 'not_stated' || !item.basis) return '<span class="badge-none">tidak dinyatakan</span>';
    if (item.basis === 'stated') return isExplicitLabel(field, code)
      ? '<span class="badge-stated" title="Kutipan terverifikasi di PDF dan memuat istilah label ini">dinyatakan ✓</span>'
      : '<span class="badge-stated" title="Kutipan terverifikasi ada di PDF dan relevan, tetapi belum tentu penulis menyebut label ini secara harfiah">didukung kutipan ✓</span>';
    return '<span class="badge-inferred">disimpulkan AI</span>';
  }
  function renderResearchDesignBlock(a) {
    const d = a.research_design;
    if (!d) return `<div class="detail-block" style="grid-column:1/-1"><h4>DESAIN RISET (RESEARCH ONION)</h4><p>Artikel ini dianalisis dengan versi lama (v${esc(a.analysis_version || 1)}) sehingga belum punya label desain riset. Unggah ulang PDF yang sama untuk menganalisis ulang; keputusan screening Anda dipertahankan.</p></div>`;
    const outdated = (a.analysis_version || 1) < currentAnalysisVersion() ? `<p class="citation-note">Dianalisis dengan versi v${esc(a.analysis_version || 1)}; versi terbaru v${esc(currentAnalysisVersion())} memakai aturan label yang lebih ketat. Unggah ulang PDF yang sama untuk memperbarui (keputusan screening dipertahankan).</p>` : '';
    const rows = Object.keys(((codebook || {}).fields) || {}).length ? Object.keys(codebook.fields) : ['philosophy','approach','methodological_choice','strategy','time_horizon','data_source','analysis'];
    const body = rows.map(field => {
      const item = d[field] || {};
      if (Array.isArray(item.items) && item.items.length) {
        const lbl = ((codebook || {}).fields || {})[field]?.label || field;
        const lines = item.items.map(e => `<div>${esc(cbLabel(field, e.code))} ${basisBadge(e, field, e.code)}${e.source === 'rule' ? ` <span class="badge-none" title="Ditambahkan oleh aturan deterministik karena penulis menyebutnya sendiri; bukan usulan AI">via aturan${e.page ? ', hal. ' + esc(e.page) : ''}</span>` : ''}${e.evidence ? `<small>“${esc(e.evidence)}” ${e.evidence_verified ? '<span class="badge-stated">✓ ada di teks</span>' : '<span class="badge-bad">⚠ tidak ditemukan di teks</span>'}</small>` : ''}</div>`).join('');
        return `<div class="rd-row"><div>${esc(lbl)}</div><div>${lines}</div></div>`;
      }
      const vals = list(Array.isArray(item.value) ? item.value : (item.value && item.value !== 'not_stated' ? [item.value] : []));
      const label = ((codebook || {}).fields || {})[field]?.label || field;
      const evidence = item.evidence ? `<small>“${esc(item.evidence)}” ${item.evidence_verified ? '<span class="badge-stated">✓ ada di teks</span>' : '<span class="badge-bad">⚠ tidak ditemukan di teks</span>'}</small>` : '';
      return `<div class="rd-row"><div>${esc(label)}</div><div>${vals.length ? vals.map(v => esc(cbLabel(field, v))).join(', ') : '<span class="badge-none">—</span>'} ${basisBadge(item, field, item.value)}${evidence}</div></div>`;
    }).join('');
    const tech = list(d.techniques).length ? `<div class="rd-row"><div>Teknik / metode</div><div>${list(d.techniques).map(esc).join(' · ')}</div></div>` : '';
    const warn = list(d.warnings).length ? `<p class="citation-note">Catatan validasi: ${list(d.warnings).map(esc).join(' | ')}</p>` : '';
    return `<div class="detail-block" style="grid-column:1/-1"><h4>DESAIN RISET (RESEARCH ONION) · codebook ${esc(d.codebook_version || '')}</h4>${body}${tech}${warn}${outdated}<p class="citation-note">“disimpulkan AI” berarti tidak dinyatakan eksplisit oleh penulis: periksa sebelum dipakai sebagai fakta. “didukung kutipan ✓” berarti kalimat itu ada di PDF dan relevan, bukan jaminan penulis menyebut label itu secara harfiah; hanya “dinyatakan ✓” (label eksplisit seperti Case study) yang memeriksa istilahnya.</p></div>`;
  }

  // Clipboard API hanya jalan di konteks aman (HTTPS atau localhost). Di http://IP-lokal atau 0.0.0.0 ia undefined,
  // jadi ada cadangan lewat textarea + execCommand, lalu cadangan terakhir: tampilkan teks untuk disalin manual.
  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* lanjut ke cadangan */ }
    }
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }
  function showCopyFallback(text) {
    const box = $('#design-notices');
    box.insertAdjacentHTML('beforeend', `<textarea id="design-copy-box" class="design-copy-box" readonly rows="14">${esc(text)}</textarea>`);
    const ta = $('#design-copy-box'); ta.focus(); ta.select();
  }
  function refList(ids) {
    const nums = list(ids).map(id => designRefs[id]).filter(Boolean).sort((x, y) => x - y);
    return nums.length ? ` [${nums.join(', ')}]` : '';
  }
  function dtNode(node, isRoot = false) {
    const kids = list(node.children);
    const emptyValues = kids.filter(k => k.kind === 'value' && k.count === 0);
    const shown = kids.filter(k => !(k.kind === 'value' && k.count === 0));
    const TECH_CAP = 15;
    const techs = shown.filter(k => k.kind === 'technique');
    const rest = shown.filter(k => k.kind !== 'technique');
    const techShown = techs.slice(0, TECH_CAP);
    const cls = node.kind === 'branch' ? 'dt-branch' : node.kind === 'family' ? 'dt-family' : (node.count === 0 && node.kind === 'group' ? 'dt-empty' : '');
    const inferred = node.inferred_count ? `<span class="dt-infer" title="Jumlah artikel yang label ini hanya disimpulkan AI, tanpa kutipan pendukung">${node.inferred_count} disimpulkan</span>` : '';
    const chips = (node.kind === 'value' || node.kind === 'technique') && node.count ? `<span class="dt-chips">${citationChips(node.article_ids)}</span>` : '';
    const inner = [
      ...rest.map(k => dtNode(k)),
      ...techShown.map(k => dtNode(k)),
      techs.length > TECH_CAP ? `<li class="dt-item dt-empty">+ ${techs.length - TECH_CAP} teknik lain (lihat JSON)</li>` : '',
      emptyValues.length ? `<li class="dt-item dt-empty">Belum ada artikel: ${emptyValues.map(k => esc(k.name)).join(', ')}</li>` : '',
    ].join('');
    const head = `<span class="dt-name">${esc(node.name)}</span><span class="dt-count">${node.count}</span>${inferred}${node.definition ? `<span class="dt-def">${esc(node.definition)}</span>` : ''}${node.note ? `<span class="dt-note">${esc(node.note)}</span>` : ''}${chips}`;
    return `<li class="dt-item ${cls}">${head}${inner ? `<ul class="dt-list">${inner}</ul>` : ''}</li>`;
  }
  function dtText(node, prefix = '', last = true, isRoot = true) {
    const kids = list(node.children).filter(k => !(k.kind === 'value' && k.count === 0));
    const techs = kids.filter(k => k.kind === 'technique');
    const visible = [...kids.filter(k => k.kind !== 'technique'), ...techs.slice(0, 15)];
    const label = `${node.name} (${node.count})${(node.kind === 'value' || node.kind === 'technique') ? refList(node.article_ids) : ''}`;
    let out = isRoot ? `${label}\n` : `${prefix}${last ? '└─ ' : '├─ '}${label}\n`;
    const childPrefix = isRoot ? '' : prefix + (last ? '   ' : '│  ');
    visible.forEach((k, i) => { out += dtText(k, childPrefix, i === visible.length - 1, false); });
    return out;
  }
  function paintDesign(res, arts) {
    designRefs = {}; arts.forEach((a, i) => { designRefs[a.id] = i + 1; });
    const notices = [];
    if (res.missing_ids.length) {
      const titles = res.missing_ids.map(id => esc((findArticle(id) || {}).title || id)).slice(0, 5).join('; ');
      notices.push(`<div class="design-notice">${res.missing_ids.length} dari ${res.n_articles} artikel dianalisis dengan versi lama dan belum punya label desain riset (${titles}${res.missing_ids.length > 5 ? '; …' : ''}). Unggah ulang PDF-nya di tab Ikhtisar untuk analisis ulang; keputusan screening dipertahankan. Analisis ulang memakai token AI.</div>`);
    }
    const ns = res.normalization_status || {};
    if (ns.applied && ns.unmapped_count) {
      notices.push(`<div class="design-notice">${esc(ns.unmapped_count)} teknik belum ada di pemetaan yang disetujui dan tampil di “Belum dikelompokkan”. Buka panel Normalisasi untuk memperbaruinya.</div>`);
    }
    if (res.n_with_design) {
      notices.push(`<div class="design-notice ok">${res.n_with_design} artikel dihitung. Label bertanda “disimpulkan” adalah tebakan AI dari cara studi dilakukan, bukan pernyataan penulis; baca ringkasan di bagian bawah halaman dan periksa artikel kuncinya.</div>`);
    }
    $('#design-notices').innerHTML = notices.join('');
    if (!res.n_with_design) {
      $('#design-tree').innerHTML = '<div class="empty-state">Belum ada artikel dengan label desain riset pada cakupan ini.</div>';
      $('#design-matrix').classList.add('hidden'); $('#design-basis').classList.add('hidden'); $('#norm-panel').classList.add('hidden');
      return;
    }
    const refFooter = arts.filter(a => res.tree.article_ids.includes(a.id)).map(a => `<li>[${designRefs[a.id]}] ${esc(a.title)} (${esc(a.year || 'n.d.')})</li>`).join('');
    $('#design-tree').innerHTML = `<div class="synth-eyebrow">TAKSONOMI / ${esc(res.n_with_design)} ARTIKEL / CODEBOOK ${esc(res.codebook_version)}</div><div class="dt-root">${esc(res.tree.name)}</div><ul class="dt-list dt-root-list">${list(res.tree.children).map(k => dtNode(k)).join('')}</ul><details style="margin-top:14px"><summary class="taxonomy-help">Daftar referensi ([n] pada outline teks)</summary><ol style="list-style:none;padding:0;font-size:12px">${refFooter}</ol></details>`;
    const m = res.matrix;
    $('#design-matrix').classList.remove('hidden');
    $('#design-matrix').innerHTML = `<div class="synth-eyebrow">MATRIKS METODOLOGI × STRATEGI</div><h2>Sel kosong = kandidat research gap</h2><p class="taxonomy-help">Angka = jumlah artikel. Sel bergaris kosong belum punya artikel di korpus ini. Itu bisa berarti gap riset, atau hanya keterbatasan pencarian Anda.</p><div class="matrix-wrap"><table class="design-matrix-table"><thead><tr><th></th>${m.columns.map(c => `<th>${esc(c.label)}</th>`).join('')}<th>Total</th></tr></thead><tbody>${m.rows.map(r => `<tr><td>${esc(r.name)}</td>${m.columns.map(c => { const n = list(r.cells[c.key]).length; return `<td class="${n ? '' : 'zero'}" title="${esc(list(r.cells[c.key]).map(id => (findArticle(id) || {}).title || id).join('; '))}">${n}</td>`; }).join('')}<td>${r.total}</td></tr>`).join('')}</tbody></table></div>`;
    $('#design-basis').classList.remove('hidden');
    $('#design-basis').innerHTML = `<div class="synth-eyebrow">KEPERCAYAAN LABEL</div><h2>Didukung kutipan vs disimpulkan AI</h2><p class="taxonomy-help">Hijau = didukung kutipan yang terverifikasi di teks PDF (untuk label eksplisit seperti Case study, itu berarti penulis menyebutnya sendiri). Kuning = disimpulkan. Abu-abu = tidak dinyatakan.</p>${Object.entries(res.basis_summary).map(([k, v]) => { const t = (v.stated + v.inferred + v.not_stated) || 1; return `<div class="basis-row"><span>${esc(v.label)}</span><span class="basis-bar"><i class="b-stated" style="width:${v.stated / t * 100}%"></i><i class="b-inferred" style="width:${v.inferred / t * 100}%"></i><i class="b-none" style="width:${v.not_stated / t * 100}%"></i></span><span>${v.stated} / ${v.inferred} / ${v.not_stated}</span></div>`; }).join('')}`;
    renderNormalization(res, arts);
  }
  // Panel langkah di atas Taksonomi Desain Riset: status dibaca dari state, bukan disimpan.
  function renderDesignSteps() {
    const box = $('#design-steps'); if (!box) return;
    const included = state.articles.filter(a => a.extraction_status !== 'failed' && a.screening_decision === 'include' && a.eligibility_decision === 'include').length;
    const topic = String((state.designUi || {}).topic || '').trim();
    const verifiedIncluded = state.articles.filter(a => a.extraction_status !== 'failed' && a.screening_decision === 'include' && a.eligibility_decision === 'include' && a.owner_verified).length;
    const n = normState(), unmapped = Number(((designResult && designResult.res && designResult.res.normalization_status) || {}).unmapped_count || 0);
    const norm = n.draft ? {done: false, note: 'Draf menunggu diperiksa, lalu klik "Setujui & terapkan ke pohon".'}
      : n.approved
        ? {done: !unmapped, note: unmapped ? `${unmapped} teknik baru belum terpetakan. Klik "Perbarui untuk teknik baru".` : `${list(n.approved.families).length} keluarga disetujui.`}
        : {done: false, note: 'Klik "Usulkan pengelompokan (AI)" pada panel normalisasi.'};
    const steps = [
      {title: 'Artikel INCLUDE', done: included > 0, note: included > 0 ? `${included} artikel siap dihitung.` : 'Belum ada. Tetapkan keputusan di tab Artikel.', go: included > 0 ? '' : 'articles'},
      {title: 'Nama topik', done: !!topic, note: topic || 'Isi nama topik (akar pohon) pada kolom di bawah.'},
      {title: 'Normalisasi teknik', done: norm.done, note: norm.note},
      {title: 'Verifikasi artikel', done: included > 0 && verifiedIncluded === included, note: included > 0 ? `${verifiedIncluded} dari ${included} artikel INCLUDE sudah dicek terhadap PDF (buka detail artikel, centang "Sudah saya cek").` : 'Belum ada artikel INCLUDE.'},
      {title: 'Ekspor', done: false, note: 'Unduh laporan HTML, lalu cetak mode naskah (PDF bersih) atau mode lengkap (audit) dari laporan itu.'},
    ];
    box.innerHTML = '<p class="eyebrow">LANGKAH</p><ol class="step-list">' + steps.map((s, i) =>
      `<li class="step${s.done ? ' done' : ''}"><span class="step-mark">${s.done ? '✓' : '○'}</span><span><strong>${i + 1}. ${esc(s.title)}</strong><small>${esc(s.note)}</small>${s.go ? `<button class="text-button" type="button" data-step-go="${s.go}">Ke tab Artikel</button>` : ''}</span></li>`).join('') + '</ol>';
    box.querySelectorAll('[data-step-go]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.stepGo)));
  }
  async function renderDesign() {
    const box = $('#design-tree'); if (!box) return;
    state.designUi = {topic: '', scope: 'notexcluded', ...(state.designUi || {})};
    renderDesignSteps();
    const topicInput = $('#design-topic');
    if (document.activeElement !== topicInput) topicInput.value = state.designUi.topic;
    $('#design-scope').value = state.designUi.scope;
    const arts = designScopeArticles();
    if (!arts.length) {
      $('#design-notices').innerHTML = '';
      box.innerHTML = '<div class="empty-state">Belum ada artikel pada cakupan ini. Unggah PDF di tab Ikhtisar, atau ubah cakupan di atas.</div>';
      $('#design-matrix').classList.add('hidden'); $('#design-basis').classList.add('hidden'); $('#norm-panel').classList.add('hidden');
      return;
    }
    const mine = ++designReq;
    try {
      await loadCodebook();
      const res = await api('/api/design-taxonomy', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({articles: arts, topic: state.designUi.topic, normalization: normState().approved})});
      if (mine !== designReq) return;
      designResult = {res, arts};
      paintDesign(res, arts);
      renderDesignSteps();
    } catch (e) {
      if (mine === designReq) box.innerHTML = `<div class="empty-state">${esc(e.message || 'Gagal menyusun taksonomi desain riset.')}</div>`;
    }
  }

  // ---------------------------------------------------------------- Normalisasi teknik (tahap 3)
  // AI hanya mengusulkan. Pemetaan baru dipakai pohon setelah pengguna menekan "Setujui & terapkan" (state.norm.approved).
  const NORM_DROP = '__drop__';
  const cloneJson = (x) => JSON.parse(JSON.stringify(x));
  function normState() { state.norm = {draft: null, approved: null, ...(state.norm || {})}; return state.norm; }
  // Tab metode di editor = FILTER tampilan. Satu keluarga tetap satu entitas; tab hanya menampilkan teknik yang dipakai artikel
  // berlabel metode itu (label dari methodological_choice, sama dengan cabang pohon). `method` pada keluarga hanyalah petunjuk
  // tab untuk keluarga yang belum punya teknik berartikel.
  const NORM_METHODS = [
    {id: 'quantitative', label: 'Kuantitatif', keys: ['mono_quantitative', 'multi_method_quantitative']},
    {id: 'qualitative', label: 'Kualitatif', keys: ['mono_qualitative', 'multi_method_qualitative']},
    {id: 'mixed', label: 'Campuran', keys: ['mixed_method_simple', 'mixed_method_complex']},
  ];
  const NORM_TAB_LABEL = {all: 'Semua', not_stated: 'Tidak dinyatakan', ...Object.fromEntries(NORM_METHODS.map(m => [m.id, m.label]))};
  let normTab = 'all';
  const validMethod = (m) => NORM_METHODS.some(x => x.id === m) ? m : null;
  function methodGroupOf(a) { const v = (((a || {}).research_design || {}).methodological_choice || {}).value; const g = NORM_METHODS.find(m => m.keys.includes(v)); return g ? g.id : 'not_stated'; }
  function normCountsFor(ids, gmap) { const c = {}; [...new Set(list(ids))].forEach(id => { const g = gmap[id]; if (g) c[g] = (c[g] || 0) + 1; }); return c; }
  const normChip = (c) => Object.keys(NORM_TAB_LABEL).filter(k => k !== 'all' && c[k]).map(k => `${NORM_TAB_LABEL[k]} ${c[k]}`).join(' · ');
  function normOptions(draft, selected) {
    const fams = list(draft.families).map(f => `<option value="${esc(f.id)}"${selected === f.id ? ' selected' : ''}>${esc(f.name)}</option>`).join('');
    const none = selected == null || selected === '';
    return `${fams}<option value=""${none ? ' selected' : ''}>Belum dikelompokkan</option><option value="${NORM_DROP}"${selected === NORM_DROP ? ' selected' : ''}>Bukan teknik (buang)</option>`;
  }
  function normItemRow(it, idx, draft, gc) {
    const others = list(it.variants).filter(v => v !== it.canonical);
    const variants = others.length ? `<span class="norm-variants">Digabung dari: ${others.map(v => `<span class="norm-chip">${esc(v)} <button type="button" class="norm-split" data-split="${idx}" data-variant="${esc(v)}" title="Pisahkan varian ini menjadi teknik sendiri">×</button></span>`).join('')}</span>` : '';
    return `<div class="norm-item"><span><input class="norm-name" data-item-name="${idx}" value="${esc(it.canonical)}" aria-label="Nama baku teknik">${it.new ? '<span class="norm-new">baru</span>' : ''}${list(it.touched).length ? '<span class="norm-new" title="Nama yang baru ditempelkan: ' + esc(list(it.touched).join(', ')) + '">+' + list(it.touched).length + ' varian baru</span>' : ''}</span><span class="dt-count" title="${normTab === 'all' || !gc ? 'Jumlah artikel' : 'Jumlah artikel berlabel ' + esc(NORM_TAB_LABEL[normTab])}">${normTab !== 'all' && gc && gc[normTab] != null ? gc[normTab] : (it.count ?? '–')}</span><select data-item-fam="${idx}" aria-label="Keluarga">${normOptions(draft, it.family)}</select>${gc && normChip(gc) ? `<span class="norm-methods" title="Label metode artikel yang memakai teknik ini">${esc(normChip(gc))}</span>` : ''}${it.reason ? `<span class="norm-reason">Alasan AI: ${esc(it.reason)}</span>` : ''}${variants}</div>`;
  }
  function normEditor(draft, arts) {
    const gmap = {}; list(arts).forEach(a => { if (a && a.id) gmap[a.id] = methodGroupOf(a); });
    const items = list(draft.items), gcs = items.map(it => normCountsFor(it.article_ids, gmap));
    const tab = normTab, unknown = (it) => !list(it.article_ids).length;
    const visibleItem = (i) => tab === 'all' || unknown(items[i]) || gcs[i][tab] > 0;
    const groups = {};
    items.forEach((it, i) => { if (!visibleItem(i)) return; const k = it.family === NORM_DROP ? NORM_DROP : (it.family || ''); (groups[k] = groups[k] || []).push([it, i]); });
    const rows = (k) => (groups[k] || []).map(([it, i]) => normItemRow(it, i, draft, gcs[i])).join('');
    const famInfo = (f) => {
      const mine = items.map((it, i) => [it, i]).filter(([it]) => it.family === f.id);
      const counts = normCountsFor(mine.flatMap(([it]) => list(it.article_ids)), gmap);
      const pure = (c, a, b) => c[a] > 0 && !c[b];
      const hasQuan = mine.some(([, i]) => pure(gcs[i], 'quantitative', 'qualitative')), hasQual = mine.some(([, i]) => pure(gcs[i], 'qualitative', 'quantitative'));
      return {counts, known: Object.keys(counts).length > 0, mixedWorlds: hasQuan && hasQual};
    };
    const infos = {}; list(draft.families).forEach(f => { infos[f.id] = famInfo(f); });
    const showFam = (f) => tab === 'all' || infos[f.id].counts[tab] > 0 || (!infos[f.id].known && (!validMethod(f.method) || f.method === tab));
    const tabCount = (t) => t === 'all' ? list(draft.families).length : list(draft.families).filter(f => infos[f.id].counts[t] > 0).length;
    const tabs = ['all', ...NORM_METHODS.map(m => m.id), ...(Object.values(infos).some(i => i.counts.not_stated) ? ['not_stated'] : [])];
    const tabBar = `<div class="norm-tabs" role="tablist">${tabs.map(t => `<button type="button" role="tab" class="norm-tab${t === tab ? ' active' : ''}" aria-selected="${t === tab}" data-norm-tab="${t}">${esc(NORM_TAB_LABEL[t])} <span class="dt-count">${tabCount(t)}</span></button>`).join('')}</div><p class="norm-tabnote">Tab hanya memfilter tampilan: satu keluarga tetap satu entitas, ubah nama atau definisi berlaku di semua tab. Teknik dihitung menurut label metode artikelnya, sama seperti cabang pohon.</p>`;
    const famBox = f => { const inf = infos[f.id];
      const meta = inf.known ? `<span class="norm-methods">Artikel: ${esc(normChip(inf.counts))}</span>` : `<span class="norm-methods">Belum ada teknik berartikel${validMethod(f.method) ? ' · tampil di tab ' + esc(NORM_TAB_LABEL[f.method]) : ''}</span>`;
      const warn = inf.mixedWorlds ? `<span class="norm-warn" title="Ada teknik yang hanya dipakai artikel kuantitatif dan teknik lain yang hanya dipakai artikel kualitatif di keluarga ini">⚠ Mencampur teknik kuantitatif dan kualitatif: pertimbangkan memecah keluarga</span>` : '';
      return `<div class="norm-family"><div class="norm-fam-head"><input data-fam-name="${esc(f.id)}" value="${esc(f.name)}" aria-label="Nama keluarga"><input data-fam-def="${esc(f.id)}" value="${esc(f.definition || '')}" placeholder="Definisi satu kalimat" aria-label="Definisi keluarga"><button type="button" class="button button-secondary" data-norm-action="del-family" data-id="${esc(f.id)}">Hapus keluarga</button></div><div class="norm-fam-meta">${meta}${warn}</div>${rows(f.id) || '<p class="dt-empty">Belum ada teknik di keluarga ini.</p>'}</div>`; };
    const fams = list(draft.families).filter(showFam).map(famBox).join('') || `<p class="dt-empty">Tidak ada keluarga untuk tab ${esc(NORM_TAB_LABEL[tab])}.</p>`;
    const nWarn = list(draft.families).filter(f => infos[f.id].mixedWorlds).length;
    const unassigned = groups[''] ? `<div class="norm-family"><div class="norm-fam-head"><strong>Belum dikelompokkan (${groups[''].length})</strong></div>${rows('')}</div>` : '';
    const dropped = groups[NORM_DROP] ? `<details class="norm-family norm-dropped" open><summary>Dibuang AI karena dianggap bukan teknik (${groups[NORM_DROP].length}): periksa, AI bisa keliru</summary>${rows(NORM_DROP)}</details>` : '';
    const nDrop = (groups[NORM_DROP] || []).length, nNone = (groups[''] || []).length;
    const actions = `<div class="norm-actions"><button type="button" class="button" data-norm-action="approve">Setujui &amp; terapkan ke pohon</button><button type="button" class="button button-secondary" data-norm-action="discard">Buang draf</button></div>`;
    const check = `<p class="design-notice">Sebelum menyetujui, periksa: ${nDrop ? `<strong>${nDrop} teknik yang dibuang AI</strong> (bagian paling bawah, sudah dibuka), ` : ''}${nNone ? `${nNone} teknik yang belum dikelompokkan, ` : ''}penggabungan yang menyatukan metode berbeda (tombol ×), dan keluarga yang isinya tidak sesuai definisinya.${nWarn ? ` <strong>${nWarn} keluarga mencampur teknik kuantitatif dan kualitatif</strong> (ditandai ⚠).` : ''}</p>`;
    return `<p class="norm-stat">${draft.principle ? `Prinsip pengelompokan: ${esc(String(draft.principle).replace(/[.\s]+$/, ''))}. ` : ''}${items.length} nama baku · ${list(draft.families).length} keluarga${draft.model ? ` · usulan ${esc(draft.model)}` : ''}. Periksa penggabungan (tombol × memisahkan varian), pindahkan teknik antar keluarga, ubah nama, lalu setujui.</p>${check}${actions}${tabBar}${fams}${unassigned}${dropped}<div class="norm-newfam"><input id="norm-new-family" placeholder="Nama keluarga baru" aria-label="Nama keluarga baru"><select id="norm-new-method" aria-label="Tab tempat keluarga ini tampil sampai ada teknik berartikel" title="Petunjuk tab: keluarga kosong tampil di tab ini sampai ada teknik berartikel. Setelah itu posisinya mengikuti label metode artikel.">${NORM_METHODS.map(m => `<option value="${m.id}">${esc(m.label)}</option>`).join('')}</select><button type="button" class="button button-secondary" data-norm-action="add-family">Tambah keluarga</button></div>${actions}`;
  }
  function renderNormalization(res, arts) {
    const box = $('#norm-panel'); if (!box) return;
    renderDesignSteps();
    const n = normState(), status = res.normalization_status || {};
    const techCount = arts.reduce((sum, a) => sum + list((a.research_design || {}).techniques).length, 0);
    if (!techCount) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    let body;
    if (n.draft) {
      body = `<div class="synth-eyebrow">NORMALISASI TEKNIK / DRAF — BELUM DIPAKAI PADA POHON</div><h2>Periksa dan setujui pengelompokan</h2>${normEditor(n.draft, arts)}`;
    } else if (n.approved) {
      const items = list(n.approved.items), dropped = items.filter(i => i.family === NORM_DROP).length, merged = items.filter(i => list(i.variants).length > 1).length;
      const pending = status.applied && status.unmapped_count ? `<p class="design-notice">${esc(status.unmapped_count)} teknik baru belum ada di pemetaan dan tampil di “Belum dikelompokkan”: ${list(status.unmapped).slice(0, 8).map(esc).join(', ')}${status.unmapped_count > 8 ? ', …' : ''}.</p>` : '';
      body = `<div class="synth-eyebrow">NORMALISASI TEKNIK / DISETUJUI</div><h2>Pengelompokan teknik dipakai pada pohon</h2><p class="norm-stat">${list(n.approved.families).length} keluarga · ${items.length - dropped} nama baku · ${merged} hasil penggabungan · ${dropped} dibuang${n.approved.principle ? ` · prinsip: ${esc(n.approved.principle)}` : ''}.</p>${pending}<div class="norm-actions"><button type="button" class="button button-secondary" data-norm-action="edit">Edit pemetaan</button><button type="button" class="button${status.unmapped_count ? '' : ' button-secondary'}" data-norm-action="update">Perbarui untuk teknik baru${status.unmapped_count ? ` (${esc(status.unmapped_count)})` : ''}</button><button type="button" class="button button-secondary" data-norm-action="reset">Hapus normalisasi</button></div>`;
    } else {
      body = `<div class="synth-eyebrow">NORMALISASI TEKNIK</div><h2>Satukan nama dan kelompokkan teknik</h2><p class="norm-stat">Ada ${techCount} penyebutan teknik pada artikel di cakupan ini. AI mengusulkan: (1) menyatukan sinonim, (2) membuang istilah yang bukan teknik, (3) mengelompokkan ke keluarga sebagai kotak di bawah cabang Kuantitatif, Kualitatif, atau Campuran (mengikuti label metode artikelnya). Hasilnya berupa draf yang kamu periksa dan setujui; satu panggilan AI singkat (biasanya di bawah $0,01).</p><div class="norm-actions"><button type="button" class="button" data-norm-action="propose">Usulkan pengelompokan (AI)</button></div>`;
    }
    box.innerHTML = body;
  }
  async function normPropose(button, useExisting) {
    const n = normState(), arts = designScopeArticles();
    if (!arts.length) return;
    const label = button.textContent; button.disabled = true; button.textContent = 'Memproses…';
    try {
      const data = await api('/api/normalize-techniques', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({articles: arts, topic: (state.designUi || {}).topic || '', research_question: (state.meta || {}).research_question || '', existing: useExisting ? (n.draft || n.approved || null) : null})});
      addUsage(data.usage);
      n.draft = data.normalization; saveState();
      const nm = data.normalization, att = list(nm.attached).length, mex = list(nm.merged_existing).length, rev = list(nm.review).length;
      toast(`Usulan siap: ${list(nm.items).length} nama baku.` + (att ? ` ${att} nama baru ditempelkan ke item lama.` : '') + (mex ? ` ${mex} duplikat lama digabung otomatis.` : '') + (rev ? ` ${rev} duplikat lintas keluarga perlu dicek manual.` : '') + ' Periksa lalu setujui.', 'success');
    } catch (e) {
      addUsage(e.usage);
      toast(e.message || 'Normalisasi gagal.', 'error');
    }
    if (designResult) renderNormalization(designResult.res, designResult.arts); else button.textContent = label;
  }
  function handleNormClick(e) {
    const n = normState();
    const split = e.target.closest('[data-split]');
    if (split && n.draft) {
      const it = n.draft.items[Number(split.dataset.split)], v = split.dataset.variant;
      if (it && list(it.variants).includes(v)) {
        it.variants = it.variants.filter(x => x !== v);
        n.draft.items.push({canonical: v, variants: [v], family: it.family ?? null, reason: '', count: null, article_ids: [], new: true});
        saveState(); renderNormalization(designResult.res, designResult.arts);
      }
      return;
    }
    const tabBtn = e.target.closest('[data-norm-tab]');
    if (tabBtn && n.draft) { normTab = tabBtn.dataset.normTab; renderNormalization(designResult.res, designResult.arts); return; }
    const btn = e.target.closest('[data-norm-action]'); if (!btn) return;
    const act = btn.dataset.normAction;
    if (act === 'propose') return normPropose(btn, false);
    if (act === 'update') return normPropose(btn, true);
    if (act === 'edit' && n.approved) n.draft = cloneJson(n.approved);
    else if (act === 'discard') n.draft = null;
    else if (act === 'reset') { if (!window.confirm('Hapus normalisasi? Pohon kembali menampilkan teknik apa adanya.')) return; n.draft = null; n.approved = null; saveState(); return renderDesign(); }
    else if (act === 'approve' && n.draft) { n.approved = cloneJson(n.draft); n.approved.items.forEach(i => { i.new = false; delete i.touched; }); ['attached', 'merged_existing', 'review'].forEach(k => { delete n.approved[k]; }); n.approved.approved_at = new Date().toISOString(); n.draft = null; saveState(); toast('Pemetaan disetujui dan diterapkan ke pohon.', 'success'); return renderDesign(); }
    else if (act === 'add-family' && n.draft) {
      const name = ($('#norm-new-family').value || '').trim().slice(0, 120);
      if (!name) { toast('Isi nama keluarga terlebih dahulu.', 'error'); return; }
      if (n.draft.families.some(f => f.name.toLowerCase() === name.toLowerCase())) { toast('Nama keluarga itu sudah ada.', 'error'); return; }
      const next = Math.max(0, ...n.draft.families.map(f => Number(String(f.id).replace(/\D/g, '')) || 0)) + 1;
      const method = validMethod(($('#norm-new-method') || {}).value);
      if (!method) { toast('Pilih tab metode (Kuantitatif, Kualitatif, atau Campuran) untuk keluarga ini.', 'error'); return; }
      n.draft.families.push({id: `F${next}`, name, definition: '', method});
      normTab = method;
    } else if (act === 'del-family' && n.draft) {
      const id = btn.dataset.id;
      n.draft.items.forEach(i => { if (i.family === id) i.family = null; });
      n.draft.families = n.draft.families.filter(f => f.id !== id);
    } else return;
    saveState(); renderNormalization(designResult.res, designResult.arts);
  }
  function handleNormChange(e) {
    const n = normState(); if (!n.draft) return;
    const t = e.target;
    if (t.dataset.famName !== undefined) { const f = n.draft.families.find(x => x.id === t.dataset.famName); if (f) f.name = t.value.trim().slice(0, 120) || f.name; }
    else if (t.dataset.famDef !== undefined) { const f = n.draft.families.find(x => x.id === t.dataset.famDef); if (f) f.definition = t.value.trim().slice(0, 240); }
    else if (t.dataset.itemName !== undefined) { const it = n.draft.items[Number(t.dataset.itemName)]; if (it) it.canonical = t.value.trim().slice(0, 80) || it.canonical; }
    else if (t.dataset.itemFam !== undefined) { const it = n.draft.items[Number(t.dataset.itemFam)]; if (it) { it.family = t.value === '' ? null : t.value; saveState(); renderNormalization(designResult.res, designResult.arts); return; } }
    saveState();
  }

  // ---------------------------------------------------------------- Laporan HTML (untuk dibaca manusia)
  // Satu berkas mandiri: tanpa permintaan jaringan (CSP menutupnya), ramah cetak, dan data JSON ikut ditanam sebagai cadangan.
  const SCOPE_LABEL = {notexcluded: 'Semua artikel kecuali yang di-EXCLUDE manual', all: 'Semua artikel hasil ekstraksi', included: 'Hanya artikel INCLUDE (screening dan full-text)'};
  const REPORT_CSS = `:root{--bg:#fbfbf8;--fg:#1c1c1a;--dim:#6b6b66;--line:#d9d9d2;--accent:#d4146d;--ok:#2e7d32;--warn:#a15c00;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#101010;--fg:#ecece6;--dim:#9a9a92;--line:#33332f;--accent:#ff7ab8;--ok:#7bc47f;--warn:#e0a84f;--card:#1b1b1a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1000px;margin:0 auto;padding:28px 20px 70px}h1{font-size:24px;margin:.2em 0}h2{font-size:17px;margin:34px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--line)}h3{font-size:14px;margin:18px 0 6px}
.eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}.meta{color:var(--dim);font-size:12.5px}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}.stat{border:1px solid var(--line);background:var(--card);padding:8px 14px;min-width:120px}.stat b{display:block;font-size:20px}.stat span{font-size:11.5px;color:var(--dim)}
.card{border:1px solid var(--line);background:var(--card);padding:12px 16px;margin:10px 0}.card p{margin:.4em 0}
dl{margin:0;display:grid;grid-template-columns:170px 1fr;gap:4px 14px}dt{color:var(--dim)}dd{margin:0;white-space:pre-wrap}
ul{list-style:none;margin:0;padding-left:20px;border-left:1px solid var(--line)}.tree{padding-left:0;border-left:0}li{margin:3px 0}
summary{cursor:pointer}.nm{font-weight:600}.branch>details>summary .nm{font-size:15px}.ct{display:inline-block;min-width:22px;text-align:center;border:1px solid var(--line);font-size:11px;padding:0 6px;margin-left:6px}
.inf{color:var(--warn);font-size:11px}.ok{color:var(--ok)}.refs{color:var(--accent);font-size:11.5px;margin-left:6px}.df{color:var(--dim);font-size:12px;margin:1px 0 3px}.nt{color:var(--accent);font-size:12px}.dim,.zero>.nm,.empty{color:var(--dim)}
.family>details>summary .nm{color:var(--accent)}table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}th{background:var(--card)}td.n,th.n{text-align:center}td.z{color:var(--dim);background:repeating-linear-gradient(45deg,transparent 0 6px,var(--line) 6px 7px)}
.wrap{overflow-x:auto}.bar{display:flex;height:10px;border:1px solid var(--line);min-width:140px}.bar i{display:block}.b1{background:var(--ok)}.b2{background:var(--warn)}.b3{background:var(--line)}
table.art th:nth-child(1){width:4%}table.art th:nth-child(2){width:34%}table.art th:nth-child(7){width:8%}ol.refs-list{padding-left:0;list-style:none;font-size:12.5px}ol.refs-list li{margin:5px 0}a{color:var(--accent)}.btns{margin:10px 0}button{font:inherit;padding:4px 12px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
footer{margin-top:40px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:10px}
@media print{:root{--bg:#fff;--fg:#000;--dim:#444;--line:#bbb;--accent:#000;--card:#fff;--ok:#000;--warn:#000}.noprint{display:none}body{font-size:10.5pt}main{padding:0}a{color:inherit;text-decoration:none}h2{break-after:avoid}li.leaf,tr,.card{break-inside:avoid}.b1{background:#000}.b2{background:#808080}.b3{background:#d8d8d8}}
.tag{display:inline-block;font-size:10px;font-weight:400;letter-spacing:.08em;text-transform:uppercase;border:1px solid var(--line);color:var(--dim);padding:0 6px;margin-left:8px;vertical-align:middle}
.toolbar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:8px;padding:8px 0;margin-bottom:6px;background:var(--bg);border-bottom:1px solid var(--line)}button:disabled{opacity:.55;cursor:default}
.banner{border:1px dashed var(--warn);color:var(--warn);padding:8px 14px;margin:14px 0;font-size:12.5px}.banner ul{margin:6px 0 0;padding-left:18px;border-left:0;list-style:disc;color:var(--fg)}
.todo{color:var(--warn);font-size:12.5px}ul.plain{list-style:disc;padding-left:22px;border-left:0}ul.plain li{margin:6px 0}
html[data-view="naskah"] .audit,html[data-view="naskah"] .tag,html[data-view="naskah"] .inf{display:none}
.guide{display:none}html[data-view="panduan"] .guide{display:block}html[data-view="panduan"] main>*:not(.toolbar):not(.guide){display:none}
.guide h4{margin:14px 0 4px;font-size:14px}.guide .card{margin:10px 0}.guide ul.plain,.guide ol{margin:6px 0}.guide ol{padding-left:22px}.guide ol li{margin:5px 0}
.chip{display:inline-block;font-size:11px;border:1px solid var(--line);padding:0 7px;margin-right:4px;white-space:nowrap}.chip.s{color:var(--ok);border-color:var(--ok)}.chip.r{color:var(--warn);border-color:var(--warn)}.chip.t{color:var(--bright);border-color:var(--bright)}
.eg{border-left:3px solid var(--line);padding:6px 12px;margin:8px 0;font-size:13px;color:var(--dim)}.eg b{color:var(--fg)}.eg ul{margin:4px 0;padding-left:20px;border-left:0}
ul.chk{list-style:none;padding-left:0;border-left:0}ul.chk li{margin:5px 0}ul.chk li:before{content:"\\2610  "}
.refnote{border:1px solid var(--line);padding:7px 14px;margin:10px 0;font-size:12.5px;color:var(--dim)}
details.ex{border:1px solid var(--line);margin:10px 0}details.ex>summary{cursor:pointer;padding:9px 14px;font-weight:700}.ex-body{padding:2px 16px 10px;border-top:1px solid var(--line)}.ex-body h5{margin:14px 0 4px;font-size:13px}.ex-body p{font-size:13.5px}
.ex-cap{font-size:12px;color:var(--dim);text-align:center}pre.ex-fig{font-size:12px;line-height:1.5;border:1px solid var(--line);padding:10px 14px;overflow-x:auto;white-space:pre}`;
  function rptRefs(ids) {
    const nums = list(ids).map(id => designRefs[id]).filter(Boolean).sort((a, b) => a - b);
    return nums.length ? `<span class="refs">[${nums.join(', ')}]</span>` : '';
  }
  function rptNode(node) {
    const kids = list(node.children);
    const emptyValues = kids.filter(k => k.kind === 'value' && k.count === 0);
    const shown = kids.filter(k => !(k.kind === 'value' && k.count === 0));
    const inf = node.inferred_count ? ` <span class="inf">${esc(node.inferred_count)} disimpulkan</span>` : '';
    const head = `<span class="nm">${esc(node.name)}</span><span class="ct">${esc(node.count)}</span>${inf}${(node.kind === 'value' || node.kind === 'technique') ? rptRefs(node.article_ids) : ''}`;
    const meta = `${node.definition ? `<div class="df">${esc(node.definition)}</div>` : ''}${node.note ? `<div class="nt">${esc(node.note)}</div>` : ''}`;
    const inner = shown.map(rptNode).join('') + (emptyValues.length ? `<li class="empty">Belum ada artikel: ${emptyValues.map(k => esc(k.name)).join(', ')}</li>` : '');
    const cls = `${esc(node.kind)}${node.count === 0 ? ' zero' : ''}`;
    if (!inner) return `<li class="${cls} leaf">${head}${meta}</li>`;
    return `<li class="${cls}"><details open><summary>${head}</summary>${meta}<ul>${inner}</ul></details></li>`;
  }
  function rptCell(a, field) {
    const item = (a.research_design || {})[field] || {};
    let entries = [];
    if (Array.isArray(item.items) && item.items.length) entries = item.items.map(e => ({code: e.code, basis: e.basis}));
    else if (Array.isArray(item.value)) entries = item.value.map(v => ({code: v, basis: item.basis}));
    else if (item.value && item.value !== 'not_stated') entries = [{code: item.value, basis: item.basis}];
    if (!entries.length) return '<span class="dim">—</span>';
    return entries.map(e => `${esc(cbLabel(field, e.code))}\u00a0${e.basis === 'stated' ? '<span class="ok" title="didukung kutipan / dinyatakan">✓</span>' : '<span class="inf" title="disimpulkan AI">~</span>'}`).join('<br>');
  }
  function rptAuthors(a) {
    const names = list(a.authors).map(x => String(x)).filter(Boolean);
    return names.length ? (names.length > 3 ? names.slice(0, 3).join(', ') + ', dkk.' : names.join(', ')) : 'Penulis tidak tercatat';
  }
  // Teks dari AI kadang memuat ID artikel mentah (16 heks). Di naskah ia diganti nomor referensi laporan: [n].
  function rptDeId(text) {
    return esc(String(text || '')).replace(/\b[0-9a-f]{16}\b/g, id => designRefs[id] ? `[${designRefs[id]}]` : '[?]');
  }
  // Prosa AI juga memuat kode codebook mentah (mono_quantitative, archival_research). Di naskah diganti label codebook-nya.
  function rptProse(text) {
    let out = rptDeId(text);
    Object.values((codebook || {}).fields || {}).forEach(spec => Object.entries((spec && spec.values) || {}).forEach(([k, v]) => {
      if (k.includes('_') && v && v.label) out = out.replace(new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), esc(v.label));
    }));
    return out;
  }
  function buildDesignReport() {
    const {res, arts} = designResult, meta = state.meta || {}, ui = state.designUi || {}, approved = normState().approved, draft = normState().draft;
    designRefs = {}; arts.forEach((a, i) => { designRefs[a.id] = i + 1; });
    const when = new Date(), whenText = when.toLocaleString('id-ID', {dateStyle: 'long', timeStyle: 'short'});
    const techNames = new Set(); (function walk(n) { if (n.kind === 'technique') techNames.add(n.name); list(n.children).forEach(walk); })(res.tree);
    const bs = Object.values(res.basis_summary || {}), sum = k => bs.reduce((s, f) => s + (f[k] || 0), 0);
    const cfg = [['Research question', meta.research_question], ['Sumber/database', meta.source_name], ['Tanggal pencarian', meta.search_date], ['Search query', meta.search_query], ['Kriteria inklusi', meta.inclusion], ['Kriteria eksklusi', meta.exclusion]]
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v ? esc(v) : '<span class="dim">(tidak diisi)</span>'}</dd>`).join('');
    const topic = res.topic || ui.topic || 'Korpus artikel';
    const matrix = res.matrix, m = `<div class="wrap"><table><thead><tr><th></th>${matrix.columns.map(c => `<th class="n">${esc(c.label)}</th>`).join('')}<th class="n">Total</th></tr></thead><tbody>${matrix.rows.map(r => `<tr><td>${esc(r.name)}</td>${matrix.columns.map(c => { const n = list(r.cells[c.key]).length; return `<td class="n${n ? '' : ' z'}">${n}</td>`; }).join('')}<td class="n">${esc(r.total)}</td></tr>`).join('')}</tbody></table></div>`;
    const basis = `<div class="wrap"><table><thead><tr><th>Lapisan research onion</th><th>Proporsi</th><th class="n">Didukung kutipan</th><th class="n">Disimpulkan AI</th><th class="n">Tidak dinyatakan</th></tr></thead><tbody>${Object.values(res.basis_summary || {}).map(v => { const t = (v.stated + v.inferred + v.not_stated) || 1; return `<tr><td>${esc(v.label)}</td><td><span class="bar"><i class="b1" style="width:${v.stated / t * 100}%"></i><i class="b2" style="width:${v.inferred / t * 100}%"></i><i class="b3" style="width:${v.not_stated / t * 100}%"></i></span></td><td class="n">${esc(v.stated)}</td><td class="n">${esc(v.inferred)}</td><td class="n">${esc(v.not_stated)}</td></tr>`; }).join('')}</tbody></table></div>`;
    let normSection, famTable;
    if (approved) {
      const items = list(approved.items), fam = {}; list(approved.families).forEach(f => { fam[f.id] = f; });
      const famRows = list(approved.families).map(f => { const its = items.filter(i => i.family === f.id), names = its.map(i => i.canonical); const ids = [...new Set(its.flatMap(i => list(i.article_ids)))]; return `<tr><td><b>${esc(f.name)}</b></td><td>${f.definition ? esc(f.definition) : '<span class="todo">(definisi belum diisi)</span>'}</td><td class="n">${names.length}</td><td>${names.map(esc).join(', ')}</td><td>${rptRefs(ids) || '<span class="dim">—</span>'}</td></tr>`; }).join('');
      famTable = `<div class="wrap"><table><thead><tr><th>Keluarga</th><th>Definisi</th><th class="n">Teknik</th><th>Teknik baku</th><th>Artikel</th></tr></thead><tbody>${famRows}</tbody></table></div>`;
      const merged = items.filter(i => list(i.variants).length > 1).map(i => `<li><b>${esc(i.canonical)}</b> ← ${list(i.variants).filter(v => v !== i.canonical).map(esc).join(', ')}</li>`).join('');
      const dropped = items.filter(i => i.family === NORM_DROP).map(i => `<li>${esc(i.canonical)}${i.reason ? ` <span class="dim">(${esc(i.reason)})</span>` : ''}</li>`).join('');
      normSection = `<p class="meta">Pemetaan disetujui${approved.approved_at ? ' pada ' + esc(new Date(approved.approved_at).toLocaleString('id-ID', {dateStyle: 'long', timeStyle: 'short'})) : ''}. Usulan AI${approved.model ? ' (' + esc(approved.model) + ')' : ''}, keputusan akhir oleh peneliti.${approved.principle ? ' Prinsip: ' + esc(String(approved.principle).replace(/[.\s]+$/, '')) + '.' : ''}</p>${draft ? '<p class="inf">Catatan: ada draf pemetaan yang belum disetujui; laporan ini memakai pemetaan yang disetujui terakhir.</p>' : ''}${merged ? `<h3>Penggabungan nama</h3><ul class="tree">${merged}</ul>` : ''}${dropped ? `<h3>Dibuang karena bukan teknik</h3><ul class="tree">${dropped}</ul>` : ''}`;
    } else {
      normSection = '<p class="meta">Tidak ada normalisasi yang disetujui: teknik ditampilkan sebagaimana diekstrak, hanya digabung bila beda huruf besar/kecil atau tanda baca.</p>';
      famTable = '<p class="todo">Pengelompokan teknik belum disetujui: teknik ditampilkan seperti hasil ekstraksi.</p>';
    }
    const rows = arts.map((a, i) => `<tr><td class="n">${i + 1}</td><td>${esc(a.title || '(tanpa judul)')} <span class="dim">(${esc(a.year || 'n.d.')})</span></td><td>${rptCell(a, 'methodological_choice')}</td><td>${rptCell(a, 'strategy')}</td><td>${rptCell(a, 'data_source')}</td><td>${rptCell(a, 'time_horizon')}</td><td class="n">${list((a.research_design || {}).techniques).length}</td></tr>`).join('');
    const refs = arts.map((a, i) => { const doi = String(a.doi || '').trim(); const link = /^10\.\d{4,9}\/[-._;()\/:A-Za-z0-9]+$/.test(doi) ? ` <a href="${esc('https://doi.org/' + encodeURI(doi))}" rel="noopener noreferrer">${esc(doi)}</a>` : ''; return `<li>[${i + 1}] ${esc(rptAuthors(a))} (${esc(a.year || 'n.d.')}). ${esc(a.title || '(tanpa judul)')}.${link}</li>`; }).join('');
    // ---- bahan naskah: dihitung dari data proyek, bukan diketik ----
    const T = k => `<span class="tag">${k}</span>`, orTodo = v => v ? esc(v) : '<span class="todo">(belum diisi di Ikhtisar)</span>';
    const allA = state.articles, nInc = allA.filter(a => a.screening_decision === 'include' && a.eligibility_decision === 'include').length;
    const exScreen = allA.filter(a => a.screening_decision === 'exclude').length, exFull = allA.filter(a => a.screening_decision === 'include' && a.eligibility_decision === 'exclude').length;
    const pendN = allA.length - nInc - exScreen - exFull;
    const yearCount = {}; arts.forEach(a => { const y = String(a.year || 'n.d.'); yearCount[y] = (yearCount[y] || 0) + 1; });
    const yearText = Object.keys(yearCount).sort().map(y => `${y} (${yearCount[y]})`).join(', ');
    const query = String(meta.search_query || '').replace(/\\(["'])/g, '$1');
    const verifiedN = arts.filter(a => a.owner_verified).length, unverifiedN = arts.length - verifiedN;
    const treeFams = []; (function walk(n) { if (n.kind === 'family') treeFams.push(n); list(n.children).forEach(walk); })(res.tree);
    const noDefFam = treeFams.filter(f => !String(f.definition || '').trim()).map(f => f.name);
    const issues = [];
    if (unverifiedN) issues.push(`${unverifiedN} dari ${arts.length} artikel belum diverifikasi terhadap PDF (label desain riset adalah ekstraksi AI).`);
    if (!approved) issues.push('Pengelompokan teknik belum disetujui: teknik ditampilkan seperti hasil ekstraksi.');
    else if (draft) issues.push('Ada draf pengelompokan teknik yang belum disetujui; laporan memakai pemetaan yang disetujui terakhir.');
    if (noDefFam.length) issues.push(`${noDefFam.length} keluarga teknik belum punya definisi: ${noDefFam.map(esc).join('; ')}.`);
    const banner = issues.length ? `<div class="banner"><b>DRAFT, belum siap dikutip.</b><ul>${issues.map(x => `<li>${x}</li>`).join('')}</ul></div>` : '';
    const metodeDl = [['Sumber literatur', orTodo(meta.source_name)], ['Tanggal pencarian', orTodo(meta.search_date)], ['String pencarian', orTodo(query)], ['Kriteria inklusi', orTodo(meta.inclusion)], ['Kriteria eksklusi', orTodo(meta.exclusion)],
      ['Hasil seleksi', esc(`${allA.length} artikel diunggah dan diekstrak; ${nInc} lolos screening dan full-text; ${exScreen} dieksklusi saat screening; ${exFull} dieksklusi saat full-text${pendN > 0 ? `; ${pendN} belum diputuskan` : ''}. Angka ini berasal dari PDF yang diunggah, bukan dari jumlah hasil pencarian database.`)],
      ['Sebaran tahun', esc(`${yearText || '-'}; dari ${arts.length} artikel dalam cakupan laporan`)],
      ['Metode klasifikasi', esc(`Top-down mengikuti research onion (Saunders dkk., 2019): topik, lalu metodologi dan strategi, teknik dan prosedur, serta fondasi. Teknik yang disebut tiap artikel dikelompokkan menjadi keluarga teknik. Satu artikel dapat muncul di lebih dari satu cabang karena tiap lapisan menjelaskan dimensi yang berbeda. Label diekstrak dari teks PDF dengan bantuan model bahasa; ${verifiedN} dari ${arts.length} artikel sudah diverifikasi peneliti terhadap PDF.`)]]
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
    const defRows = []; (function walk(n, code) { list(n.children).forEach((c, i) => { if (c.kind === 'technique') return; const cd = code ? `${code}.${i + 1}` : String(i + 1);
      defRows.push(`<tr><td>${esc(cd)}</td><td>${esc(c.name)}</td><td>${c.definition ? esc(c.definition) : '<span class="todo">(definisi belum diisi)</span>'}</td><td class="n">${esc(c.count)}</td></tr>`); walk(c, cd); }); })(res.tree, '');
    const posItems = list(res.tree.children).map(b => {
      const parts = list(b.children).map(c => {
        if (c.count === 0) return '';
        const kids = list(c.children).filter(k => k.kind === 'value' && k.count > 0);
        if (c.kind === 'value') return `${esc(c.name)} (${esc(c.count)})`;
        return `${esc(c.name)}${kids.length ? ': ' + kids.map(k => `${esc(k.name)} (${esc(k.count)})`).join(', ') : ` (${esc(c.count)})`}`;
      }).filter(Boolean);
      const empty = list(b.children).filter(c => (c.kind === 'group' || c.kind === 'value') && c.count === 0).map(c => esc(c.name));
      return `<li><b>${esc(b.name)}</b> (dari ${esc(res.tree.count)} artikel): ${parts.join('; ') || '-'}.${empty.length ? ` Tanpa artikel: ${empty.join(', ')}.` : ''}</li>`;
    }).join('');
    const syn = state.synthesis; let synSection;
    if (syn && (syn.executive_synthesis || list(syn.research_gaps).length || list(syn.main_themes).length)) {
      const mism = syn.included_article_count && syn.included_article_count !== arts.length ? `<p class="todo">Sintesis dibuat dari ${esc(syn.included_article_count)} artikel, sedangkan laporan ini memakai ${esc(arts.length)} artikel; jalankan ulang sintesis bila daftarnya berubah.</p>` : '';
      synSection = `<p class="meta">Ringkasan ini dihasilkan Review Synthesis (model bahasa) dari artikel INCLUDE. Periksa dan tulis ulang dengan kata sendiri sebelum dikutip.</p>${mism}${syn.executive_synthesis ? `<p>${rptProse(syn.executive_synthesis)}</p>` : ''}`
        + (list(syn.main_themes).length ? `<h3>Tema utama</h3><ul class="plain">${list(syn.main_themes).map(t => `<li><b>${esc(t.name)}</b>${rptRefs(t.article_ids)}. ${rptProse(t.description)}</li>`).join('')}</ul>` : '')
        + (list(syn.research_gaps).length ? `<h3>Celah penelitian</h3><ul class="plain">${list(syn.research_gaps).map(g => `<li><b>${esc(g.gap)}</b>${rptRefs(g.article_ids)}${g.evidence ? ' ' + rptProse(g.evidence) : ''}${g.suggested_next_step ? ` <i>Langkah lanjut: ${rptProse(g.suggested_next_step)}</i>` : ''}</li>`).join('')}</ul>` : '');
    } else synSection = '<p class="todo">Belum ada ringkasan: jalankan Review Synthesis di tab SLR lanjutan.</p>';
    const verRows = arts.map((a, i) => `<tr><td class="n">${i + 1}</td><td>${esc(a.title || '(tanpa judul)')} <span class="dim">(${esc(a.year || 'n.d.')})</span></td><td>${a.owner_verified ? '✓ diverifikasi' + (a.owner_verified_at ? ' ' + esc(String(a.owner_verified_at).slice(0, 10)) : '') : '<span class="inf">belum</span>'}</td></tr>`).join('');
    // ---- panduan kerangka: contoh diambil dari data proyek ini ----
    const tgS = '<span class="chip s">Salin dan rapikan</span>', tgR = '<span class="chip r">Tulis ulang</span>', tgW = '<span class="chip t">Tulis sendiri</span>';
    const eg = h => `<div class="eg"><b>Contoh dari proyekmu.</b> ${h}</div>`;
    const brBy = pfx => list(res.tree.children).find(b => String(b.name).startsWith(pfx)) || {children: []};
    const grpBy = (b, pfx) => list(b.children).find(c => String(c.name).startsWith(pfx)) || {children: []};
    const valsIn = n => { const out = []; (function w(x) { list(x.children).forEach(c => { if (c.kind === 'value') out.push(c); else if (c.kind !== 'technique' && c.kind !== 'family') w(c); }); })(n); return out; };
    const fmtV = arr => arr.length ? arr.map(v => `${esc(v.name)} (${esc(v.count)})`).join('; ') : 'belum ada';
    const bMeto = brBy('Metodologi'), bStr = brBy('Strategi'), bTek = brBy('Teknik'), bFon = brBy('Fondasi');
    const metoLine = list(bMeto.children).map(c => `${esc(c.name)} (${esc(c.count)})`).join('; ') || 'belum ada';
    const emptyMeto = list(bMeto.children).filter(c => c.count === 0).map(c => esc(c.name)).join(', ');
    const strV = valsIn(bStr), strFilled = strV.filter(v => v.count > 0);
    const dataFilled = valsIn(grpBy(bTek, 'Pengumpulan')).filter(v => v.count > 0), anaFilled = valsIn(grpBy(bTek, 'Analisis')).filter(v => v.count > 0);
    const phFilled = valsIn(grpBy(bFon, 'Philosophy')).filter(v => v.count > 0), tmFilled = valsIn(grpBy(bFon, 'Time')).filter(v => v.count > 0);
    const itb = (meta.guide_context || 'itb-tmi') === 'itb-tmi';
    const phAllNot = phFilled.length > 0 && phFilled.every(v => /tidak dinyatakan/i.test(v.name));
    const famSorted = treeFams.slice().sort((a, b) => b.count - a.count), famFmt = f => `${esc(f.name)} (${esc(f.count)} artikel)`;
    const infN = sum('inferred'), totN = sum('stated') + sum('inferred') + sum('not_stated');
    const gapItems = list(syn && syn.research_gaps).slice(0, 4).map(g => `<li>${rptProse(g.gap)}</li>`).join('');
    const mapRows = [
      ['Halaman judul, abstrak (bila diminta)', 'Judul tugas, identitas, ringkasan singkat.', '—', tgW],
      ['I.1 Latar belakang dan alasan memilih topik', 'Minatmu pada topik, masalah nyata di baliknya, mengapa perlu taksonomi.', 'Bagian 1 (hanya nama topik)', tgW],
      ['I.2 Fokus dan pertanyaan penelitian', 'Pertanyaan penelitian dan batas fokus.', 'Bagian 1', tgR],
      ['I.3 Tujuan', 'Taksonomi ini disusun untuk apa.', '—', tgW],
      ['II.1 Sumber dan pencarian', 'Database, tanggal, string pencarian.', 'Bagian 2', tgS],
      ['II.2 Kriteria dan seleksi', 'Kriteria inklusi dan eksklusi, alur jumlah artikel.', 'Bagian 2', tgS],
      ['II.3 Metode klasifikasi', 'Mengapa research onion dan top-down.', 'Bagian 2', tgR],
      ['II.4 Ekstraksi dan verifikasi', 'Label dibantu model bahasa, diverifikasi peneliti.', 'Bagian 2', tgR],
      ['III.1 Hierarki taksonomi', 'Pohon topik, metodologi dan strategi, teknik, fondasi.', 'Bagian 3 (Gambar III.1)', tgS],
      ['III.2 Definisi konsep dan subkonsep', 'Tiap konsep didefinisikan jelas.', 'Bagian 4 (Tabel III.1)', tgS],
      ['III.3 Matriks metodologi dan strategi', 'Sebaran artikel per sel.', 'Bagian 5 (Tabel III.2)', tgS],
      ['III.4 Keluarga teknik dan artikelnya', 'Pengelompokan teknik beserta definisi.', 'Bagian 6 (Tabel III.3)', tgS],
      ['III.5 Posisi dalam research onion', 'Ringkasan tiap lapisan dalam paragraf.', 'Bagian 7', tgR],
      ['IV. Pembahasan', 'Makna temuan, pola, keterbatasan, celah.', 'Hanya angka pendukung', tgW],
      ['V. Kesimpulan dan saran', 'Jawaban pertanyaan penelitian, temuan utama, langkah lanjut.', '—', tgW],
      ['Daftar pustaka', 'Semua rujukan yang dikutip di teks.', 'Bagian 9', tgR],
      ['Lampiran', 'Label per artikel (opsional).', 'Lampiran E (mode lengkap)', tgS],
    ].map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join('');
    const refnote = '<p class="refnote">Dokumen ini adalah acuan data dan kerangka untuk menulis, bukan naskah final. Susun ulang sesuai format yang diminta dan tulis pembahasan sendiri; panduan lengkapnya ada di laporan HTML, tampilan Panduan kerangka.</p>';
    const exampleHtml = `<div class="card"><p><b>Teks di bagian F ini tetap</b> (tidak mengikuti datamu). Ia memakai data proyek contoh per 5 November 2026 (17 artikel ScienceDirect, topik <i>Predict-then-Optimize untuk keputusan operasional</i>) hanya untuk memperlihatkan bentuk dan nada tulisan tiap bagian. <b>Jangan disalin.</b> Alasan memilih topik, pembahasan, dan kesimpulan harus berasal dari pemikiranmu sendiri; kalimat yang ditandai <i>contoh alasan</i> sengaja dibuat sebagai pengandaian. Temuan dan celah penelitian (Bagian 8) tidak dicontohkan karena dibahas pada tahap SLR. Angka di sini bisa berbeda dari ekspormu: selalu rujuk laporanmu sendiri.</p></div>
<details class="ex"><summary>Halaman judul dan abstrak (contoh)</summary><div class="ex-body">
<p><b>Judul.</b> Taksonomi Desain Penelitian pada Studi Predict-then-Optimize untuk Keputusan Operasional Industri</p>
<p><b>Abstrak.</b> Studi predict-then-optimize (PTO) menggabungkan model prediksi dengan model optimasi untuk mengambil keputusan operasional di bawah ketidakpastian. Penelitian ini menyusun taksonomi desain penelitian dari 17 artikel jurnal ScienceDirect terbitan 2024 sampai 2026 dengan kerangka research onion. Taksonomi disusun top-down: metodologi dan strategi, teknik dan prosedur, serta fondasi dan horizon waktu, dengan sepuluh keluarga teknik di bawah metodologi kuantitatif. Seluruh artikel berstrategi eksperimen pemodelan dan simulasi dengan metodologi kuantitatif, sebagian besar (16 artikel) memakai data sekunder, dan tidak ada yang menyatakan filosofi penelitiannya. Keluarga teknik yang paling banyak muncul adalah jaringan syaraf prediktif dan optimasi matematis (masing-masing 11 artikel). Hasil ini menjadi dasar bagi tahap systematic literature review berikutnya.</p>
<p><b>Kata kunci.</b> predict-then-optimize, decision-focused learning, research onion, taksonomi penelitian</p></div></details>
<details class="ex"><summary>Bab I. Pendahuluan (contoh)</summary><div class="ex-body">
<h5>I.1 Latar belakang dan alasan memilih topik</h5>
<p>Pengambilan keputusan operasional di sektor logistik, transportasi, energi, dan industri proses hampir selalu bergantung pada parameter yang belum diketahui saat keputusan dibuat, seperti permintaan, harga, waktu tempuh, atau ketersediaan sumber daya. Pendekatan konvensional memisahkan dua pekerjaan: model prediksi memperkirakan parameter itu, lalu model optimasi memakai hasil prakiraan tersebut untuk menentukan keputusan. Pada literatur yang ditelaah (2024 sampai 2026), pola ini berkembang menjadi pendekatan yang menghubungkan keduanya lebih erat, antara lain melalui pelatihan model prediksi yang memperhitungkan dampak keputusan (<i>decision-focused learning</i>) dan penanganan ketidakpastian yang eksplisit pada tahap optimasi.</p>
<p><i>Contoh alasan; ganti dengan alasanmu yang sebenarnya.</i> Saya memilih topik ini karena berada di pertemuan dua bidang yang saya pelajari, yaitu pembelajaran mesin dan optimasi untuk sistem industri, dan karena literaturnya tersebar di banyak domain aplikasi sehingga sulit melihat pola metodologinya secara keseluruhan. Taksonomi desain penelitian diperlukan untuk memetakan bagaimana studi-studi tersebut dirancang, bukan hanya apa yang mereka hasilkan.</p>
<h5>I.2 Fokus dan pertanyaan penelitian</h5>
<p>Penelitian ini berfokus pada desain penelitian pada studi predict-then-optimize untuk keputusan operasional industri, yaitu metodologi, strategi, dan teknik yang dipakai. Studi yang hanya melakukan prediksi tanpa optimasi, atau berada di luar domain operasional dan industri, tidak masuk fokus. Pertanyaan penelitian: <i>Bagaimana desain penelitian (metodologi, strategi, teknik) pada studi predict-then-optimize untuk keputusan operasional industri?</i></p>
<h5>I.3 Tujuan</h5>
<p>Taksonomi ini bertujuan (1) memetakan posisi studi PTO pada lapisan research onion (Saunders dkk., 2019), (2) mengelompokkan teknik yang dipakai ke dalam keluarga yang terdefinisi, dan (3) menyediakan dasar untuk tahap systematic literature review berikutnya.</p></div></details>
<details class="ex"><summary>Bab II. Metode penyusunan taksonomi (contoh)</summary><div class="ex-body">
<h5>II.1 Sumber dan pencarian</h5>
<p>Literatur dicari pada ScienceDirect pada 3 November 2026 (<i>gunakan tanggal yang benar-benar kamu lakukan</i>) dengan string pencarian: ("prescriptive analytics" OR "predict-then-optimize" OR "decision-focused learning") AND ("uncertainty" OR "stochastic") AND ("optimization" OR "resource allocation" OR "logistics").</p>
<h5>II.2 Kriteria dan seleksi</h5>
<p>Kriteria inklusi: artikel jurnal peer-reviewed 2020 sampai 2026, berbahasa Inggris, yang menggabungkan prediksi (pembelajaran mesin atau forecasting) dengan model optimasi untuk keputusan operasional. Kriteria eksklusi: hanya prediksi tanpa optimasi; domain di luar operasional atau industri; artikel review atau opini; tanpa teks lengkap. Sebanyak 20 artikel diunggah dan diekstrak; 17 lolos screening dan penilaian teks lengkap, dan 3 dieksklusi pada tahap screening. Angka ini dihitung dari PDF yang dikumpulkan, bukan dari jumlah hasil pencarian database, sehingga tidak disajikan sebagai diagram alir PRISMA. Artikel yang lolos terbit pada 2024 (1 artikel), 2025 (3 artikel), dan 2026 (13 artikel).</p>
<h5>II.3 Metode klasifikasi</h5>
<p>Taksonomi disusun top-down mengikuti research onion (Saunders dkk., 2019): dari topik, dipecah menjadi metodologi dan strategi, teknik dan prosedur, serta fondasi dan horizon waktu. Pada lapisan teknik, nama teknik yang disebut tiap artikel dinormalisasi menjadi keluarga teknik; usulan awal dibuat dengan bantuan model bahasa dan seluruh pengelompokan diperiksa serta disetujui peneliti. Satu artikel dapat muncul pada lebih dari satu cabang karena tiap lapisan menjelaskan dimensi yang berbeda. <i>Contoh alasan:</i> research onion dipilih karena memberi kerangka berlapis yang eksplisit dan dipakai sebagai acuan dalam perkuliahan.</p>
<h5>II.4 Ekstraksi dan verifikasi</h5>
<p>Label desain penelitian tiap artikel diekstrak dari teks lengkap PDF dengan bantuan model bahasa, disertai kutipan bukti dan status label: dinyatakan penulis, disimpulkan, atau tidak dinyatakan. Peneliti memverifikasi seluruh 17 artikel terhadap PDF-nya. Sebagian besar label berstatus disimpulkan, sehingga hasilnya harus dibaca sebagai penafsiran peneliti atas desain studi, bukan pernyataan penulis artikel.</p></div></details>
<details class="ex"><summary>Bab III. Taksonomi penelitian (contoh)</summary><div class="ex-body">
<h5>III.1 Hierarki taksonomi</h5>
<p>Gambar III.1 menunjukkan hierarki taksonomi. Topik membentuk akar yang bercabang menjadi empat lapisan research onion. Seluruh artikel berada pada metodologi kuantitatif, sehingga sepuluh keluarga teknik ditempatkan di bawah cabang tersebut.</p>
<pre class="ex-fig">Predict-then-Optimize untuk keputusan operasional (17)
├─ 1 Metodologi
│   ├─ 1.1 Kuantitatif (17)  → 10 keluarga teknik (1.1.1 sampai 1.1.10)
│   ├─ 1.2 Kualitatif (0)
│   └─ 1.3 Campuran (0)
├─ 2 Strategi: Eksperimen pemodelan dan simulasi (17); Riset arsip (12); Studi kasus (4)
├─ 3 Teknik dan prosedur: 3.1 Pengumpulan data; 3.2 Analisis data
└─ 4 Fondasi dan horizon waktu: 4.1 Philosophy; 4.2 Approach; 4.3 Time horizon</pre>
<p class="ex-cap">Gambar III.1 Hierarki taksonomi desain penelitian pada studi predict-then-optimize (n = 17). <i>Gambar ini kamu buat sendiri di Word atau draw.io; blok di atas hanya isinya.</i></p>
<h5>III.2 Definisi konsep dan subkonsep</h5>
<p>Tabel III.1 merangkum definisi tiap konsep. Definisi lapisan research onion mengacu pada kerangka Saunders dkk. (2019), sedangkan definisi keluarga teknik disusun dari teknik yang muncul pada korpus dan disetujui peneliti. <i>(Contoh ini hanya memuat sebagian baris; naskahmu memuat semuanya.)</i></p>
<p class="ex-cap">Tabel III.1 Definisi konsep dan subkonsep (cuplikan)</p>
<div class="wrap"><table><thead><tr><th>Kode</th><th>Konsep</th><th>Definisi</th><th class="n">Artikel</th></tr></thead><tbody><tr><td>1</td><td>Metodologi</td><td>Pilihan metodologis penelitian (lapisan methodological choice pada research onion).</td><td class="n">17</td></tr><tr><td>1.1</td><td>Kuantitatif</td><td>Data dan analisis numerik, statistik, atau komputasional.</td><td class="n">17</td></tr><tr><td>1.1.1</td><td>Jaringan syaraf prediktif</td><td>Model prediktif berlapis yang mempelajari pola nonlinier dan dependensi temporal atau spasial dari data, seperti LSTM, CNN, graph convolutional network, dan Transformer.</td><td class="n">11</td></tr><tr><td>1.1.7</td><td>Pembelajaran berorientasi keputusan</td><td>Metode yang mengintegrasikan prediksi dengan tujuan optimasi secara langsung seperti SPO dan decision-focused learning.</td><td class="n">5</td></tr><tr><td>2</td><td>Strategi</td><td>Strategi penelitian (lapisan strategies). Satu artikel boleh memakai lebih dari satu strategi.</td><td class="n">17</td></tr><tr><td>3.1</td><td>Pengumpulan data</td><td>Sumber data yang dipakai.</td><td class="n">17</td></tr><tr><td>4.2</td><td>Approach to theory development</td><td>Cara penelitian berhubungan dengan teori: deduktif (menguji teori atau model yang sudah ada), induktif (membangun teori dari data), atau abduktif (bolak-balik di antara keduanya).</td><td class="n">17</td></tr></tbody></table></div>
<h5>III.3 Matriks metodologi dan strategi</h5>
<p>Tabel III.2 memperlihatkan bahwa seluruh 17 artikel berada pada metodologi kuantitatif dan menggunakan strategi eksperimen pemodelan dan simulasi; 12 artikel juga memakai strategi riset arsip dan 4 artikel berbentuk studi kasus. Satu artikel dapat berada pada lebih dari satu strategi, sehingga jumlah kolom tidak dijumlahkan.</p>
<p class="ex-cap">Tabel III.2 Sebaran artikel menurut metodologi dan strategi</p>
<div class="wrap"><table><thead><tr><th>Metodologi</th><th class="n">Eksperimen pemodelan dan simulasi</th><th class="n">Riset arsip</th><th class="n">Studi kasus</th></tr></thead><tbody><tr><td>Kuantitatif</td><td class="n">17</td><td class="n">12</td><td class="n">4</td></tr><tr><td>Kualitatif</td><td class="n">0</td><td class="n">0</td><td class="n">0</td></tr><tr><td>Campuran</td><td class="n">0</td><td class="n">0</td><td class="n">0</td></tr></tbody></table></div>
<h5>III.4 Keluarga teknik dan artikelnya</h5>
<p>Tabel III.3 menyajikan sepuluh keluarga teknik. Keluarga yang paling banyak dipakai adalah jaringan syaraf prediktif dan optimasi matematis (masing-masing 11 artikel), disusul pemrograman stokastik dan robust (9 artikel) serta pohon keputusan dan boosting (7 artikel). Yang paling jarang adalah kalibrasi dan kuantifikasi ketidakpastian prediksi (1 artikel) dan evaluasi dan interpretasi model (3 artikel). Satu artikel dapat memakai teknik dari beberapa keluarga, sehingga jumlahnya tidak dijumlahkan.</p>
<p class="ex-cap">Tabel III.3 Keluarga teknik pada korpus (jumlah artikel yang memakai sedikitnya satu teknik dari keluarga itu)</p>
<div class="wrap"><table><thead><tr><th>Kode</th><th>Keluarga</th><th class="n">Artikel</th><th>Definisi</th></tr></thead><tbody><tr><td>1.1.1</td><td>Jaringan syaraf prediktif</td><td class="n">11</td><td>Model prediktif berlapis yang mempelajari pola nonlinier dan dependensi temporal atau spasial dari data, seperti LSTM, CNN, graph convolutional network, dan Transformer.</td></tr><tr><td>1.1.2</td><td>Optimasi matematis dan algoritma solusi</td><td class="n">11</td><td>Formulasi dan penyelesaian program optimasi deterministik seperti MILP, SOCP, dan pencarian solusi.</td></tr><tr><td>1.1.3</td><td>Pemrograman stokastik dan robust</td><td class="n">9</td><td>Pendekatan optimasi yang menangani ketidakpastian melalui skenario, himpunan ambiguitas, atau kendala peluang.</td></tr><tr><td>1.1.4</td><td>Pohon keputusan dan boosting</td><td class="n">7</td><td>Model prediktif berbasis struktur pohon, baik tunggal maupun ensambel (bagging dan boosting), seperti Random Forest, XGBoost, dan LightGBM.</td></tr><tr><td>1.1.5</td><td>Heuristik dan algoritma numerik</td><td class="n">6</td><td>Prosedur pencarian dan perhitungan praktis yang menghasilkan solusi baik secara efisien tanpa jaminan optimalitas, seperti beam search, grid search, dan insertion heuristic.</td></tr><tr><td>1.1.6</td><td>Model linear, kernel, dan klaster</td><td class="n">6</td><td>Model prediktif klasik berbasis regresi linier, metode kernel, jarak, dan pengelompokan, seperti Lasso, SVM, k-NN, dan K-means.</td></tr><tr><td>1.1.7</td><td>Pembelajaran berorientasi keputusan</td><td class="n">5</td><td>Metode yang mengintegrasikan prediksi dengan tujuan optimasi secara langsung seperti SPO dan decision-focused learning.</td></tr><tr><td>1.1.8</td><td>Optimasi sekuensial dan kendali</td><td class="n">4</td><td>Teknik pengambilan keputusan berulang atas horizon waktu seperti MPC dan pemrograman dinamis.</td></tr><tr><td>1.1.9</td><td>Evaluasi dan interpretasi model</td><td class="n">3</td><td>Teknik untuk menguji signifikansi perbedaan atau menjelaskan kontribusi fitur model.</td></tr><tr><td>1.1.10</td><td>Kalibrasi dan kuantifikasi ketidakpastian prediksi</td><td class="n">1</td><td>Teknik yang mengkalibrasi atau membangkitkan kuantil/interval ketidakpastian dari model prediksi.</td></tr></tbody></table></div>
<h5>III.5 Posisi dalam research onion</h5>
<p>Pada lapisan metodologi, seluruh 17 artikel (100%) berada pada metodologi kuantitatif tunggal; tidak ada artikel kualitatif maupun campuran. Strategi yang dipakai adalah eksperimen pemodelan dan simulasi (17 artikel), riset arsip (12), dan studi kasus (4). Sumber data: data sekunder (16 artikel), data sintetis atau hasil simulasi (11), dan data primer lainnya (1); satu artikel tidak menyatakan sumber datanya. Analisis data bersifat kuantitatif pada seluruh artikel dan juga kualitatif pada satu artikel. Pada lapisan fondasi, tidak satu pun artikel menyatakan filosofi penelitiannya; seluruhnya dikategorikan berpendekatan deduktif, dengan horizon waktu longitudinal (7 artikel) atau tidak relevan (10 artikel).</p></div></details>
<details class="ex"><summary>Bab IV. Pembahasan (contoh, tanpa bagian celah)</summary><div class="ex-body">
<p><i>Bagian celah dan arah penelitian lanjut sengaja tidak dicontohkan: itu dibahas pada tahap SLR.</i></p>
<p><b>Metodologi.</b> Seluruh 17 artikel bermetodologi kuantitatif dan berstrategi eksperimen pemodelan dan simulasi (Tabel III.2). Pola ini wajar untuk bidang yang berpusat pada pengembangan dan pengujian model matematis. Namun, korpus dijaring dengan kata kunci teknis (<i>prescriptive analytics</i>, <i>predict-then-optimize</i>, <i>decision-focused learning</i>), sehingga studi kualitatif atau campuran, misalnya tentang penerapan analitik preskriptif di organisasi, kemungkinan besar tidak terjaring. Cabang kualitatif dan campuran yang kosong karena itu lebih tepat dibaca sebagai batas cakupan korpus, bukan bukti bahwa studi semacam itu tidak ada.</p>
<p><b>Strategi dan data.</b> Riset arsip muncul pada 12 artikel dan studi kasus pada 4 artikel. Data sekunder dipakai oleh 16 artikel dan data sintetis atau hasil simulasi oleh 11 artikel. Tidak ada satu pun artikel yang berstrategi eksperimen laboratorium atau lapangan, sehingga bukti dari penerapan langsung di lapangan tidak tercermin pada label desain penelitian. Dengan kata lain, klaim kinerja keputusan pada korpus ini bertumpu pada data historis dan simulasi.</p>
<p><b>Keluarga teknik.</b> Komponen prediksi dan komponen optimasi sama-sama banyak: jaringan syaraf prediktif (11 artikel) dan optimasi matematis (11 artikel) memimpin, diikuti pemrograman stokastik dan robust (9) dan model pohon (7). Pembelajaran berorientasi keputusan, yang menjadi ciri integrasi lebih erat antara prediksi dan keputusan, dipakai pada 5 artikel, misalnya untuk pengendalian iklim rumah kaca (X. Chen &amp; You, 2026), dan kalibrasi ketidakpastian prediksi pada 1 artikel. Angka ini mengisyaratkan bahwa komponen prediksi dan optimasi yang berdiri sendiri masih lebih banyak dipakai daripada pelatihan prediksi yang menimbang dampak keputusan, meskipun hubungan ini perlu dikonfirmasi dengan pembacaan yang lebih dalam.</p>
<p><b>Fondasi.</b> Tidak satu pun artikel menyatakan filosofi penelitiannya, dan label pendekatan teori serta horizon waktu tidak selalu dinyatakan penulis. Hal ini umum pada artikel teknik, tetapi berarti lapisan luar research onion pada taksonomi ini adalah penafsiran peneliti, bukan fakta yang dilaporkan penulis.</p>
<p><b>Keterbatasan.</b> Taksonomi ini dibangun dari 17 artikel pada satu database (ScienceDirect) untuk 2024 sampai 2026, sehingga tidak dapat digeneralisasi ke seluruh literatur PTO. Label diekstrak dengan bantuan model bahasa dan sebagian besar berstatus disimpulkan, walaupun seluruh artikel telah diverifikasi terhadap PDF. Satu artikel dapat berada di banyak cabang, sehingga jumlah per cabang tidak saling menjumlah. Penentuan keluarga teknik juga melibatkan penilaian peneliti, misalnya apakah suatu uji statistik dipandang sebagai teknik.</p></div></details>
<details class="ex"><summary>Bab V. Kesimpulan dan saran (contoh)</summary><div class="ex-body">
<p>Pertanyaan penelitian dijawab sebagai berikut. Studi predict-then-optimize untuk keputusan operasional pada korpus ini seragam secara metodologis (kuantitatif, eksperimen pemodelan dan simulasi, data sekunder), dan keragamannya terletak pada tekniknya. Tiga temuan utama: (1) seluruh 17 artikel kuantitatif dan tidak ada yang kualitatif atau campuran; (2) tidak ada artikel berstrategi eksperimen laboratorium atau lapangan; (3) teknik terbagi dalam sepuluh keluarga dengan prediksi dan optimasi sebagai inti, sedangkan pembelajaran berorientasi keputusan baru dipakai pada 5 artikel.</p>
<p>Saran: tahap berikutnya adalah systematic literature review formal dengan protokol pencarian yang terdokumentasi, termasuk menambah database dan memperluas kata kunci agar studi kualitatif dan campuran, bila ada, ikut terjaring.</p></div></details>
<details class="ex"><summary>Daftar pustaka (contoh, urut abjad)</summary><div class="ex-body">
<p>Contoh ini memakai gaya penulis-tahun dengan penulis pertama dan <i>dkk.</i> untuk tiga penulis atau lebih. Tulis semua penulis dan lengkapi nama jurnal, volume, dan halaman sesuai gaya sitasi yang diminta template. Dalam teks, dua artikel dengan nama belakang sama dibedakan dengan inisial (C. Wang, 2024 dan X. Wang, 2026; S. Chen, 2025 dan X. Chen, 2026).</p>
<ol class="refs-list"><li>Alkhulaifi, N., dkk. (2026). Decision-Focused Learning Enhanced by Automated Feature Engineering for Energy Storage Optimisation. <span class="todo">[nama jurnal, volume(nomor), halaman: lengkapi dari DOI]</span> https://doi.org/10.1016/j.eswa.2025.130554</li><li>Chen, S., dkk. (2025). A prescriptive tree-based model for energy-efficient room scheduling: Considering uncertainty in energy generation and consumption. <span class="todo">[nama jurnal, volume(nomor), halaman: lengkapi dari DOI]</span> https://doi.org/10.1016/j.ejor.2025.02.023</li><li>Chen, X., &amp; You, F. (2026). Decision-focused learning-augmented MPC for climate control in controlled-environment agriculture greenhouses. <span class="todo">[nama jurnal, volume(nomor), halaman: lengkapi dari DOI]</span> https://doi.org/10.1016/j.compag.2026.112496</li><li>Guo, Y., dkk. (2026). A smart predict-then-optimize framework for vehicle rebalancing problem. <span class="todo">[nama jurnal, volume(nomor), halaman: lengkapi dari DOI]</span> https://doi.org/10.1016/j.trb.2026.103411</li><li>Han, J., dkk. (2026). A predict-then-optimize framework for multi-stage agricultural production and distribution planning. <span class="todo">[nama jurnal, volume(nomor), halaman: lengkapi dari DOI]</span> https://doi.org/10.1016/j.asoc.2026.115224</li><li>Helyar, S., &amp; Alnaggar, A. (2025). Air quality monitoring and mitigation through time series forecasting and stochastic optimization. <span class="todo">[nama jurnal, volume(nomor), halaman: lengkapi dari DOI]</span> https://doi.org/10.1016/j.jenvman.2025.125540</li><li>Ji, Y., dkk. (2026). A predict-then-optimize framework for exposure allocation in online-to-offline platforms under uncertainty. <span class="todo">[nama jurnal, volume(nomor), halaman: lengkapi dari DOI]</span> https://doi.org/10.1016/j.omega.2026.103603</li><li>Li, X., dkk. (2026). Data-Driven Predict-then-Optimize framework for landing scheduling with hybrid descent modes. <span class="todo">[nama jurnal, volume(nomor), halaman: lengkapi dari DOI]</span> https://doi.org/10.1016/j.trb.2026.103535</li><li>Lin, Z., dkk. (2026). Predict-then-optimize: LM-MTSF provides data-driven support for distributionally robust operation optimization of active distribution networks. <span class="todo">[nama jurnal, volume(nomor), halaman: lengkapi dari DOI]</span> https://doi.org/10.1016/j.apenergy.2026.128393</li><li>Ribeiro, R., &amp; Fanzeres, B. (2026). Integrated estimate-and-optimize decision trees learning for two-stage linear decision-making problems. <span class="todo">[nama jurnal, volume(nomor), halaman: lengkapi dari DOI]</span> https://doi.org/10.1016/j.ejor.2025.08.048</li><li>Sheng, T., dkk. (2026). A predict-then-optimize framework for Just-In-Time arrival of vessels with probabilistic berth-availability forecasts. <span class="todo">[nama jurnal, volume(nomor), halaman: lengkapi dari DOI]</span> https://doi.org/10.1016/j.tre.2026.105033</li><li>Sun, B., &amp; Meng, Q. (2026). Customized first-and-last-mile ridesharing services with electric modular autonomous vehicles. <span class="todo">[nama jurnal, volume(nomor), halaman: lengkapi dari DOI]</span> https://doi.org/10.1016/j.tre.2026.105184</li><li>Tan, Z., dkk. (2026). Data-driven arrival time suggestion for drivers in trucking platform of export containers. <span class="todo">[nama jurnal, volume(nomor), halaman: lengkapi dari DOI]</span> https://doi.org/10.1016/j.ejor.2026.06.019</li><li>Wang, C., dkk. (2024). Refinery planning optimization based on smart predict-then-optimize method under exogenous price uncertainty. <span class="todo">[nama jurnal, volume(nomor), halaman: lengkapi dari DOI]</span> https://doi.org/10.1016/j.compchemeng.2024.108765</li><li>Wang, X., dkk. (2026). SPO-VCS: An end-to-end smart predict-then-optimize framework with alternating differentiation method for relocation problems in large-scale vehicle crowd sensing. <span class="todo">[nama jurnal, volume(nomor), halaman: lengkapi dari DOI]</span> https://doi.org/10.1016/j.tre.2025.104515</li><li>Zhang, C., dkk. (2025). Predictive and prescriptive analytics for robust airport gate assignment planning in airside operations under uncertainty. <span class="todo">[nama jurnal, volume(nomor), halaman: lengkapi dari DOI]</span> https://doi.org/10.1016/j.tre.2025.103963</li><li>Zhao, Y., dkk. (2026). Machine Learning-Enhanced Rolling Horizon Optimization algorithm for dynamic scheduling in AGV-Supported rice production. <span class="todo">[nama jurnal, volume(nomor), halaman: lengkapi dari DOI]</span> https://doi.org/10.1016/j.cor.2026.107688</li></ol></div></details>`;
    const guide = `<h2>Panduan kerangka: dari laporan ini ke naskah tugasmu</h2>
<div class="card"><p><b>Laporan ini adalah acuan, bukan naskah tugas.</b> Mode naskah berisi data, tabel, dan kerangka yang dihitung dari proyekmu. Yang dikumpulkan harus naskahmu sendiri: disusun ulang mengikuti ${itb ? 'format thesis TMI' : 'format penulisan yang diminta'}, dengan alasan memilih topik, pembahasan, dan kesimpulan yang kamu tulis sendiri. Contoh di panduan ini diambil dari proyekmu: topik <b>${esc(topic)}</b>, ${esc(arts.length)} artikel.</p>
<p>${itb ? 'Slide tugas meminta tiga hal' : 'Taksonomi penelitian yang baik menjawab tiga hal'}: (a) topik dan fokus, (b) konsep dan subkonsep yang didefinisikan, (c) pengelompokan hierarkis (top-down atau bottom-up) yang logis. Bab I dan II menjawab (a), Bab III menjawab (b) dan (c), Bab IV dan V sepenuhnya milikmu.</p>
<p>Penanda: ${tgS} bahan siap, tinggal dirapikan ke format; ${tgR} bahan ada tetapi kalimatnya harus kamu tulis ulang; ${tgW} tidak ada di laporan, harus kamu tulis.</p></div>
<h3>A. Peta kerangka dokumen</h3><div class="wrap"><table><thead><tr><th>Bab</th><th>Yang ditulis</th><th>Bahan di laporan</th><th>Status</th></tr></thead><tbody>${mapRows}</tbody></table></div>
<h3>B. Bab per bab</h3>
<div class="card"><h4>Bab I. Pendahuluan ${tgW}</h4><ul class="plain">
<li><b>Alasan memilih topik.</b> Tulis dari minatmu: apa yang membuatmu tertarik dan masalah nyata apa di baliknya. Pertanyaan pemandu: keputusan apa yang ingin dijawab bidang ini? Mengapa perlu dipetakan, bukan cukup membaca satu dua artikel?</li>
<li><b>Fokus dan pertanyaan penelitian.</b> Ambil pertanyaan dari Bagian 1, lalu jelaskan batasnya: apa yang masuk dan tidak masuk fokusmu.</li>
<li><b>Tujuan.</b> Satu paragraf: taksonomi ini disusun untuk apa, misalnya memetakan desain riset sebagai dasar tahap SLR.</li></ul>
${eg(`topik ${esc(topic)}. Pertanyaan penelitian di config: ${orTodo(meta.research_question)}`)}</div>
<div class="card"><h4>Bab II. Metode penyusunan taksonomi ${tgS} ${tgR}</h4><ul class="plain">
<li><b>Sumber dan pencarian.</b> Tulis dalam kalimat: database, tanggal, string pencarian, apa yang disaring. Bahan: Bagian 2.</li>
<li><b>Kriteria dan seleksi.</b> Sebut kriteria inklusi dan eksklusi, lalu alur jumlahnya. Tulis apa adanya: angka di laporan dihitung dari PDF yang kamu unggah, bukan dari jumlah hasil pencarian database, jadi jangan menulis seolah ada alur PRISMA lengkap.</li>
<li><b>Metode klasifikasi.</b> Jelaskan mengapa memakai research onion (Saunders dkk., 2019) dan mengapa top-down. Alasan ini harus datang darimu.</li>
<li><b>Ekstraksi dan verifikasi.</b> Sebut bahwa label diekstrak dengan bantuan model bahasa dan berapa artikel yang kamu verifikasi terhadap PDF. Terbuka soal ini melindungimu.</li></ul>
${eg(`${esc(arts.length)} artikel dalam cakupan laporan dari ${esc(meta.source_name || 'sumber yang belum diisi')}; ${esc(nInc)} lolos screening dan full-text; ${esc(exScreen)} dieksklusi saat screening; ${esc(verifiedN)} dari ${esc(arts.length)} artikel sudah kamu verifikasi.`)}</div>
<div class="card"><h4>Bab III. Taksonomi penelitian ${tgS} ${tgR}</h4><ul class="plain">
<li><b>Gambar III.1 (pohon, Bagian 3).</b> Buat ulang di Word atau draw.io dari tombol "Salin outline teks". Bila terlalu besar, gambar sampai level keluarga teknik dan taruh nama tekniknya di Tabel III.3.</li>
<li><b>Tabel III.1 (definisi, Bagian 4).</b> Salin dan rapikan. Definisi dari Saunders dkk. sebaiknya kamu parafrasa atau kutip dengan rujukan.</li>
<li><b>Tabel III.2 (matriks, Bagian 5) dan Tabel III.3 (keluarga teknik, Bagian 6).</b> Salin, lalu periksa angkanya terhadap laporan.</li>
<li><b>Posisi dalam onion (Bagian 7).</b> Ubah daftar menjadi paragraf, satu lapisan per kalimat atau dua.</li>
<li><b>Setiap gambar dan tabel:</b> judul bernomor, dirujuk di teks, satu kalimat pengantar dan satu kalimat interpretasi.</li></ul>
${eg(`posisi dalam onion pada proyekmu:<ul class="plain">${posItems}</ul>`)}</div>
<div class="card"><h4>Bab IV. Pembahasan ${tgW} (seluruhnya milikmu)</h4>
<p>Pola tiap paragraf: <b>temuan</b> (angka dari tabelmu), lalu <b>makna</b>, lalu <b>pembanding atau rujukan</b> [artikel], lalu <b>batasnya</b>. Pertanyaan pemandu beserta data dari proyekmu:</p>
<ol>
<li><b>Metodologi.</b> Mengapa distribusinya begini: sifat bidang atau cara kamu memilih artikel? Apa arti cabang yang kosong bagi klaim taksonomimu?${eg(`${metoLine}.${emptyMeto ? ` Cabang tanpa artikel: ${emptyMeto}.` : ''}`)}</li>
<li><b>Strategi.</b> Satu artikel boleh punya beberapa strategi: mana yang tumpang tindih dan mengapa? Apa artinya bagi bukti dari lapangan?${eg(`${fmtV(strFilled)}.`)}</li>
<li><b>Data dan analisis.</b> Seberapa bergantung bidang ini pada data sekunder atau sintetis, dan apa risikonya?${eg(`pengumpulan data: ${fmtV(dataFilled)}. Analisis: ${fmtV(anaFilled)}.`)}</li>
<li><b>Keluarga teknik.</b> Teknik mana yang menjadi inti metodologi dan mana yang baru muncul? Bagaimana hubungan antar keluarga, misalnya satu keluarga yang menyuplai masukan bagi keluarga lain?${eg(`terpadat: ${famSorted.slice(0, 3).map(famFmt).join('; ') || 'belum ada'}. Tertipis: ${famSorted.slice(-3).reverse().map(famFmt).join('; ') || 'belum ada'}.`)}</li>
<li><b>Fondasi.</b> ${phAllNot ? 'Tidak ada artikel yang menyatakan filosofinya. Jangan mengarang: sebut sebagai keterbatasan, lalu jelaskan apa dampaknya pada lapisan luar onion.' : 'Bandingkan artikel yang menyatakan filosofi atau pendekatan teorinya dengan yang tidak: apa bedanya, dan apa dampaknya pada lapisan luar onion? Jangan mengarang label yang tidak dinyatakan penulis.'}${eg(`Philosophy: ${fmtV(phFilled)}. Time horizon: ${fmtV(tmFilled)}.`)}</li>
<li><b>Keterbatasan.</b> Apa yang tidak bisa disimpulkan dari taksonomi ini? Pikirkan jumlah artikel, satu sumber, label yang disimpulkan AI, dan satu artikel yang masuk banyak cabang.${eg(`${esc(arts.length)} artikel; ${esc(infN)} dari ${esc(totN)} label adalah kesimpulan AI, bukan pernyataan penulis; ${esc(verifiedN)} artikel sudah kamu verifikasi.`)}</li>
<li><b>Celah dan langkah lanjut.</b> Pilih dua atau tiga celah dan buktikan dari tabelmu sendiri, bukan dari kalimat AI. Hubungkan ke tahap SLR.${gapItems ? eg(`celah dari Review Synthesis (bahan berpikir, bukan untuk disalin):<ul class="plain">${gapItems}</ul>`) : eg('belum ada hasil Review Synthesis. Jalankan dulu bila ingin memakainya sebagai bahan.')}</li></ol>
<p><b>Hindari:</b> menyalin Bagian 8 apa adanya; menulis hubungan sebab-akibat dari data yang hanya deskriptif; menggeneralisasi seluruh bidang dari ${esc(arts.length)} artikel; menyebut proses PRISMA penuh bila tidak dijalankan.</p></div>
<div class="card"><h4>Bab V. Kesimpulan dan saran ${tgW}</h4><ul class="plain">
<li>Jawab pertanyaan penelitian dalam beberapa kalimat, tanpa angka baru.</li>
<li>Rangkum tiga temuan utama dari Bab IV.</li>
<li>${itb ? 'Saran: langkah berikutnya, yaitu SLR formal sesuai arahan dosen, dan apa yang ingin kamu periksa lebih lanjut.' : 'Saran: langkah berikutnya, misalnya SLR formal, dan apa yang ingin kamu periksa lebih lanjut.'}</li></ul></div>
<div class="card"><h4>Daftar pustaka ${tgR}</h4><ul class="plain">
<li>Nomor [n] di laporan hanya penomoran internal laporan. Di naskah, ganti dengan gaya sitasi yang diminta template.</li>
<li>Lengkapi nama jurnal, volume, dan halaman dari DOI. Laporan hanya memuat penulis, tahun, judul, dan DOI.</li>
<li>Pastikan setiap rujukan di teks ada di daftar pustaka, dan sebaliknya.</li></ul></div>
<h3>C. Alur kerja menuju dokumen akhir</h3>
<div class="card"><ol>
<li>Pastikan banner DRAFT tidak muncul: verifikasi semua artikel, setujui pemetaan teknik, isi definisi yang kosong.</li>
<li>Periksa Ikhtisar (tanggal, query, kriteria, pertanyaan penelitian), lalu ekspor ulang laporan ini.</li>
<li>Cetak naskah (PDF bersih) sebagai acuan dan baca sampai habis.</li>
<li>Siapkan dokumen Word dengan struktur bab pada Peta kerangka, memakai Styles.</li>
<li>Salin Tabel III.1 sampai III.3 dan buat Gambar III.1.</li>
<li>Tulis Bab I dan II dengan kata sendiri memakai bahan Bagian 1 dan 2.</li>
<li>Tulis Bab IV dan V memakai pertanyaan pemandu di atas.</li>
<li>Lengkapi daftar pustaka dan ganti [n] dengan gaya sitasi.</li>
<li>Baca ulang: setiap angka di naskahmu harus bisa ditemukan di laporan, dan setiap label yang kamu bahas sudah kamu cek di PDF artikelnya.</li>
<li>${itb ? 'Cek aturan dosen soal penggunaan AI, lalu kumpulkan hardcopy dan softcopy sesuai slide.' : 'Cek aturan penggunaan AI di mata kuliahmu, lalu kumpulkan sesuai ketentuan.'}</li></ol></div>
<h3>D. Catatan format</h3>
<div class="card">${itb ? `<ul class="plain">
<li>Slide tugas meminta format penulisan thesis TMI. Template prodi menang bila berbeda dari catatan ini.</li>
<li>Rujukan yang kutemukan, yaitu Petunjuk Teknis Penulisan Tesis Magister ITB Sekolah Pascasarjana (2017, revisi 2019): Times New Roman 12, rata kiri-kanan, spasi 1,5; judul bab di tengah, tebal ukuran 14; judul subbab tebal ukuran 12; setiap bab dimulai di halaman baru.</li>
<li>Gambar, tabel, dan rumus bernomor dua angka: angka Romawi untuk bab dan angka Arab untuk urutan di bab itu (Gambar III.1, Tabel III.2). Header tabel diulang bila tabel pindah halaman, gambar tidak boleh melewati margin.</li>
<li>Daftar pustaka memakai gaya CSL ITB Sekolah Pascasarjana dengan baris kedua menjorok. Margin dari diagram contoh tampaknya kiri 4 cm dan sisi lain 3 cm; periksa langsung ke dokumen aslinya karena hasil ekstraksinya tidak rapi dan mungkin sudah ada edisi baru.</li></ul>` : `<ul class="plain"><li>Ikuti pedoman penulisan yang diminta program studi atau dosenmu: ukuran huruf, spasi, margin, penomoran halaman, penomoran gambar dan tabel, serta gaya sitasi mengikuti pedoman itu.</li><li>Bila ada template resmi, pakai template itu dari awal; mengubah format di akhir hampir selalu merusak penomoran gambar, tabel, dan daftar isi.</li><li>Gambar, tabel, dan rumus sebaiknya diberi nomor yang konsisten dan dirujuk di teks. Header tabel diulang bila tabel pindah halaman, dan gambar tidak boleh melewati margin.</li></ul>`}</div>
<h3>E. Daftar periksa sebelum menyerahkan</h3>
<div class="card"><ul class="chk">
<li>Bab I, IV, dan V ditulis dengan kata sendiri.</li>
<li>Tidak ada kalimat AI yang disalin apa adanya, termasuk Bagian 8.</li>
<li>Setiap angka dan label yang dikutip sudah dicek terhadap laporan dan PDF artikel.</li>
<li>Semua gambar dan tabel bernomor, berjudul, dan dirujuk di teks.</li>
<li>Rujukan [n] sudah diganti gaya sitasi template, dan daftar pustaka lengkap.</li>
<li>Penggunaan bantuan AI disebut di metode dan sesuai aturan dosen.</li>
<li>Format mengikuti ${itb ? 'template thesis TMI' : 'pedoman penulisan yang diminta'}.</li></ul></div>
<h3>F. Contoh naskah (kasus: Predict-then-Optimize)</h3>${exampleHtml}`;
    const data = {generated_at: when.toISOString(), topic, scope: ui.scope, codebook_version: res.codebook_version, review: meta, design: res, normalization: approved || null,
      articles: arts.map((a, i) => ({n: i + 1, id: a.id, title: a.title, year: a.year, doi: a.doi, authors: a.authors, verified: !!a.owner_verified}))};
    const dataJson = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return `<!doctype html><html lang="id" data-view="lengkap"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:"><title>Taksonomi desain riset: ${esc(topic)}</title><style>${REPORT_CSS}</style></head><body><main>
<div class="toolbar noprint"><button id="v-naskah" type="button">Pratinjau naskah</button><button id="v-lengkap" type="button">Tampilan lengkap</button><button id="v-panduan" type="button">Panduan kerangka</button><button id="p-naskah" type="button">Cetak naskah (PDF bersih)</button><button id="p-lengkap" type="button">Cetak lengkap (audit)</button></div>
<section class="guide" id="panduan">${guide}</section>
<p class="eyebrow audit">Laporan taksonomi desain riset · SLR Protocol</p><h1>${esc(topic)}</h1>
<p class="meta audit">Dibuat ${esc(whenText)} · kerangka research onion (Saunders dkk., 2019) · codebook ${esc(res.codebook_version)} · cakupan: ${esc(SCOPE_LABEL[ui.scope] || ui.scope || '-')}</p>
${banner}
${refnote}
<div class="stats audit"><div class="stat"><b>${esc(res.n_with_design)}</b><span>artikel dianalisis</span></div><div class="stat"><b>${esc(techNames.size)}</b><span>teknik baku</span></div><div class="stat"><b>${esc((res.normalization_status || {}).families || 0)}</b><span>keluarga teknik</span></div><div class="stat"><b>${esc(sum('inferred'))}</b><span>label disimpulkan AI (dari ${esc(sum('stated') + sum('inferred') + sum('not_stated'))})</span></div></div>
<h2>1. Topik dan fokus penelitian${T('naskah')}</h2><div class="card"><dl><dt>Topik utama</dt><dd>${esc(topic)}</dd><dt>Pertanyaan penelitian</dt><dd>${orTodo(meta.research_question)}</dd></dl></div>
<h2>2. Metode penyusunan taksonomi${T('naskah')}</h2><div class="card"><dl>${metodeDl}</dl></div>
<h2>3. Taksonomi penelitian (research onion)${T('naskah')}</h2><div class="btns noprint"><button id="open-all" type="button">Buka semua</button> <button id="close-all" type="button">Tutup semua</button></div><ul class="tree"><li class="root"><span class="nm" style="font-size:16px">${esc(topic)}</span> <span class="ct">${esc(res.tree.count)}</span><ul>${list(res.tree.children).map(rptNode).join('')}</ul></li></ul>
<h2>4. Definisi konsep dan subkonsep${T('naskah')}</h2><div class="wrap"><table><thead><tr><th>Kode</th><th>Konsep</th><th>Definisi</th><th class="n">Artikel</th></tr></thead><tbody>${defRows.join('')}</tbody></table></div>${defRows.join('').includes('[ekstensi]') ? '<p class="meta">Tanda [ekstensi]: kategori tambahan tool di luar daftar asli Saunders dkk.</p>' : ''}
<h2>5. Matriks metodologi × strategi${T('naskah')}</h2><p class="meta">Sel kosong (berarsir) belum punya artikel di korpus ini: bisa berarti celah riset, atau hanya keterbatasan pencarian.</p>${m}
<h2>6. Keluarga teknik dan pemetaan artikel${T('naskah')}</h2>${famTable}
<h2>7. Posisi dalam research onion${T('naskah')}</h2><ul class="plain">${posItems}</ul>
<h2>8. Temuan dan celah penelitian${T('naskah')}</h2>${synSection}
<h2>9. Daftar pustaka${T('naskah')}</h2><p class="todo">Nama jurnal, volume, dan halaman belum tersedia dari ekstraksi PDF; lengkapi dari DOI sebelum dikutip.</p><ol class="refs-list">${refs}</ol>
<section class="audit"><h2>Lampiran A. Konfigurasi review (mentah)${T('audit')}</h2><div class="card"><dl>${cfg}</dl></div></section>
<section class="audit"><h2>Lampiran B. Cara membaca dan cara pembuatan${T('audit')}</h2><div class="card"><p>Label desain riset diekstrak dari teks PDF tiap artikel dengan bantuan AI, mengikuti codebook research onion. Setiap kutipan bukti diperiksa benar-benar ada di PDF, tetapi <b>keberadaan kutipan tidak menjamin ia mendukung label</b>; periksa artikel kunci sebelum dikutip.</p><p><span class="ok">✓</span> didukung kutipan (label eksplisit seperti <i>Case study</i> hanya diterima bila penulis menyebut istilahnya sendiri) · <span class="inf">~</span> disimpulkan AI, tidak dinyatakan penulis · <span class="dim">—</span> tidak dinyatakan. Angka dalam kotak = jumlah artikel; <span class="refs">[n]</span> = nomor referensi pada bagian 8.</p><p>Nama dan keluarga teknik diusulkan AI lalu disetujui peneliti (bagian 5). Daftar teknik per artikel dibatasi maksimal 8 teknik utama, sehingga jumlah di pohon berarti “disebut sebagai teknik utama”, bukan pemakaian lengkap. Laporan ini bukan penilaian kualitas artikel.</p></div></section>
<section class="audit"><h2>Lampiran C. Penggabungan dan pembuangan nama${T('audit')}</h2>${normSection}</section>
<section class="audit"><h2>Lampiran D. Kepercayaan label${T('audit')}</h2>${basis}</section>
<section class="audit"><h2>Lampiran E. Label per artikel${T('audit')}</h2><div class="wrap"><table class="art"><thead><tr><th class="n">No</th><th>Artikel</th><th>Metodologi</th><th>Strategi</th><th>Pengumpulan data</th><th>Time horizon</th><th class="n">Teknik</th></tr></thead><tbody>${rows}</tbody></table></div></section>
<section class="audit"><h2>Lampiran F. Status verifikasi artikel${T('audit')}</h2><div class="wrap"><table><thead><tr><th class="n">No</th><th>Artikel</th><th>Status</th></tr></thead><tbody>${verRows}</tbody></table></div></section>
<footer class="audit">Berkas ini adalah potret data pada waktu pembuatan; buat ulang bila data berubah. Data JSON ditanam di bawah (elemen <code>#slr-data</code>) sebagai cadangan.</footer></main>
<script type="application/json" id="slr-data">${dataJson}</script>
<script>(function(){var d=document,h=d.documentElement,prev=null;function all(o){d.querySelectorAll('details').forEach(function(x){x.open=o})}function view(v){h.setAttribute('data-view',v);['naskah','lengkap','panduan'].forEach(function(k){var b=d.getElementById('v-'+k);if(b)b.disabled=(v===k)})}function pr(v){prev=h.getAttribute('data-view');view(v);setTimeout(function(){window.print()},60)}function el(i,f){var x=d.getElementById(i);if(x)x.onclick=f}el('open-all',function(){all(true)});el('close-all',function(){all(false)});el('v-naskah',function(){view('naskah')});el('v-lengkap',function(){view('lengkap')});el('v-panduan',function(){view('panduan')});el('p-naskah',function(){pr('naskah')});el('p-lengkap',function(){pr('lengkap')});window.addEventListener('beforeprint',function(){all(true)});window.addEventListener('afterprint',function(){if(prev){view(prev);prev=null}});view('lengkap')})();</script></body></html>`;
  }
  function downloadDesignReport() {
    if (!designResult) { toast('Belum ada pohon untuk diekspor.', 'error'); return; }
    let html;
    try { html = buildDesignReport(); } catch (e) { toast('Gagal membuat laporan: ' + (e.message || e), 'error'); return; }
    const slug = String((state.designUi || {}).topic || 'topik').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'topik';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([html], {type: 'text/html;charset=utf-8'}));
    link.download = `laporan-desain-riset-${slug}-${new Date().toISOString().slice(0, 10)}.html`;
    link.click(); URL.revokeObjectURL(link.href);
    toast('Laporan HTML diunduh.', 'success');
  }
  function renderTopicOutline(root, nodes) {
    const kids = {}; nodes.forEach(n => { (kids[String(n.parent_id || root.id)] = kids[String(n.parent_id || root.id)] || []).push(n); });
    const walk = (parentId) => (kids[String(parentId)] || []).map(n => {
      const sub = walk(n.id);
      const leaf = !sub;
      return `<li class="dt-item"><span class="dt-name">${esc(n.name || 'Node')}</span><span class="dt-count">${list(n.article_ids).length}</span>${n.description ? `<span class="dt-def">${esc(n.description)}</span>` : ''}${leaf && list(n.article_ids).length ? `<span class="dt-chips">${citationChips(n.article_ids)}</span>` : ''}${sub ? `<ul class="dt-list">${sub}</ul>` : ''}</li>`;
    }).join('');
    const body = walk(root.id || 'root');
    return `<div class="dt-root">${esc(root.name || 'Konsep utama')}</div>${body ? `<ul class="dt-list dt-root-list">${body}</ul>` : ''}`;
  }

  function renderTaxonomy() {
    const s = state.synthesis;
    const box = $('#taxonomy-content');
    if (s && s.taxonomy_status === 'failed') {
      box.innerHTML = `<div class="empty-state"><strong>Sintesis berhasil, tetapi taxonomy belum berhasil dibuat.</strong><p>${esc(s.taxonomy_error || 'Model tidak menghasilkan struktur taxonomy yang dapat dipakai.')}</p><p>Sintesis tidak perlu diulang: klik tombol di bawah untuk membuat ulang peta topik saja (satu panggilan AI).</p><button type="button" class="button" id="taxonomy-retry">Buat ulang peta topik</button></div>`;
      return;
    }
    if (!s || !s.taxonomy) { box.innerHTML = '<div class="empty-state">Jalankan Review Synthesis untuk menghasilkan peta topik dari artikel yang termasuk.</div>'; return; }
    $$('.taxonomy-tab').forEach(b => b.classList.toggle('active', b.dataset.taxonomy === activeTaxonomy));
    if (activeTaxonomy === 'hierarchical') {
      const h = s.taxonomy.hierarchical || {}; const root = h.root || {id:'root',name:'Konsep utama'}; const nodes = list(h.nodes);
      const levels = list(h.levels), cov = s.taxonomy_coverage;
      const principle = levels.length ? `<p class="taxonomy-help"><strong>Prinsip pengelompokan:</strong> ${levels.map(l=>`level ${esc(l.level)}: ${esc(l.principle)}`).join(' · ')}</p>` : '';
      const covLine = cov ? `<p class="taxonomy-help">Cakupan: ${esc(cov.covered)}/${esc(cov.total)} artikel punya tempat di hierarki${list(cov.uncovered_ids).length ? ` · belum terpetakan: ${list(cov.uncovered_ids).map(id=>esc((findArticle(id)||{}).title||id)).join('; ')}` : ''}${cov.parent_fixes ? ` · ${esc(cov.parent_fixes)} relasi induk diperbaiki otomatis` : ''}.</p>` : '';
      box.innerHTML = `<div class="synth-eyebrow">HIERARCHICAL TAXONOMY</div><h2 class="taxonomy-title">Peta topik: apa yang diteliti</h2><p class="taxonomy-help">Diusulkan AI dari artikel terpilih, lalu dirapikan dan diperiksa cakupannya oleh kode. Periksa definisi dan pengelompokan sebelum dipakai.</p>${principle}${covLine}${nodes.length ? topicTreeSvg(root,nodes) + '<div class="topic-outline">' + renderTopicOutline(root,nodes) + '</div>' : '<div class="empty-state">Belum ada peta topik yang dihasilkan.</div>'}`;
    } else if (activeTaxonomy === 'faceted') {
      const f=s.taxonomy.faceted||{}; const facets=list(f.facets);
      box.innerHTML = `<div class="synth-eyebrow">FACETED TAXONOMY</div><h2 class="taxonomy-title">Klasifikasi berdasarkan beberapa facet</h2><p class="taxonomy-help">Setiap kolom menunjukkan dimensi atribut yang berbeda untuk mendeskripsikan studi atau konsep.</p>${facets.length ? `<div class="facet-diagram">${facets.map((facet,i)=>`<div class="facet-column"><div class="facet-head">${esc(facet.name||'Facet '+(i+1))}</div>${list(facet.values).map(v=>`<div class="facet-value"><strong>${esc(v.name||'Kategori')}</strong><small>${esc(v.description||'')}</small><span>${list(v.article_ids).length} artikel</span></div>`).join('')}</div>`).join('')}</div>` : '<div class="empty-state">Belum ada facet yang dihasilkan. Jalankan ulang sintesis untuk membuat klasifikasi multi-dimensi.</div>'}`;
    } else if (activeTaxonomy === 'flat') {
      const data = list(s.taxonomy.flat);
      box.innerHTML = `<div class="synth-eyebrow">FLAT / LIST TAXONOMY</div><h2 style="font-size:17px;margin:0 0 15px">Kategori pada level yang sama</h2>${data.length ? `<div class="taxonomy-list">${data.map((x,i)=>`<div class="taxonomy-item"><div class="taxonomy-index">KATEGORI ${String(i+1).padStart(2,'0')}</div><h3>${esc(x.name || 'Kategori')}</h3><p>${esc(x.description || '')}</p><span class="evidence-count">${list(x.article_ids).length} artikel pendukung</span><div class="source-chips">${citationChips(x.article_ids)}</div></div>`).join('')}</div>` : '<div class="empty-state">Model tidak menghasilkan daftar kategori. Periksa data sintesis atau coba ulangi.</div>'}`;
    } else if (activeTaxonomy === 'poly') {
      const data = s.taxonomy.polyhierarchy || {};
      const nodes = list(data.nodes);
      const nodeNames = Object.fromEntries(nodes.map(n => [n.id, n.name]));
      box.innerHTML = `<div class="synth-eyebrow">POLY-HIERARCHICAL TAXONOMY</div><h2 style="font-size:17px;margin:0 0 7px">Satu konsep dapat memiliki beberapa parent</h2><p style="color:#9a9a9a;font-size:11px;margin:0 0 15px">Relasi parent berasal dari struktur model dan harus diverifikasi secara konseptual.</p>${nodes.length ? `<div id="poly-canvas" class="system-map-canvas"></div><div class="poly-tree">${nodes.map(n=>`<div class="poly-node"><h3>${esc(n.name || n.id)}</h3><p>${esc(n.description || '')}</p><div class="poly-parents">Parent: ${list(n.parent_ids).length ? list(n.parent_ids).map(id=>esc(nodeNames[id] || id)).join(' · ') : 'Tidak ditentukan'}</div><div class="source-chips">${citationChips(n.article_ids)}</div></div>`).join('')}</div>` : '<div class="empty-state">Belum ada node poly-hierarchy pada hasil sintesis.</div>'}`;
      if (nodes.length) polyDiagram($('#poly-canvas'), nodes, list(data.edges));
    } else {
      const m = s.taxonomy.matrix || {};
      const cols = list(m.columns);
      const rows = list(m.rows);
      box.innerHTML = `<div class="synth-eyebrow">MATRICES TAXONOMY</div><h2 style="font-size:17px;margin:0 0 7px">Klasifikasi silang antar dimensi</h2><p style="font-size:11px;color:#9a9a9a;margin:0 0 15px">Baris: ${esc(m.row_axis_name || 'Dimensi baris')} · Kolom: ${esc(m.column_axis_name || 'Dimensi kolom')}</p>${rows.length && cols.length ? `<div class="matrix-wrap"><table class="matrix-table"><thead><tr><th>${esc(m.row_axis_name || 'Kategori')}</th>${cols.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr><td>${esc(row.name || 'Baris')}</td>${cols.map(col=>{const cell=list(row.cells).find(c=>c.column===col);return `<td>${esc(cell ? cell.summary || '—' : '—')}${cell && list(cell.article_ids).length ? `<span class="matrix-cell-evidence">${list(cell.article_ids).length} artikel</span><div class="source-chips">${citationChips(cell.article_ids)}</div>` : ''}</td>`}).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">Belum ada matriks taxonomy pada hasil sintesis.</div>'}`;
    }
    if (s.taxonomy_status === 'partial') box.insertAdjacentHTML('afterbegin', `<div class="notice notice-warm"><strong>Peta topik parsial</strong><span>${esc(s.taxonomy_note || 'Respons AI terpotong; hanya bagian yang utuh yang dipakai.')}</span><button type="button" class="button button-quiet button-small" id="taxonomy-retry">Buat ulang peta topik</button></div>`);
  }

  // Buat ulang taksonomi saja (tanpa mengulang 29 panggilan sintesis).
  let taxonomyBusy = false;
  async function retryTaxonomy() {
    if (taxonomyBusy || isBusy) return;
    const s = state.synthesis; if (!s) return;
    if (!currentCounts().included) { toast('Belum ada artikel INCLUDE pada screening dan full-text eligibility.', 'error'); return; }
    taxonomyBusy = true;
    const btn = $('#taxonomy-retry'); if (btn) { btn.disabled = true; btn.textContent = 'Menyusun peta topik…'; }
    try {
      const data = await api('/api/taxonomy', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({articles: state.articles, main_themes: list(s.main_themes), ...getMetaFromForm()})});
      addUsage(data.usage);
      s.taxonomy = data.taxonomy; s.taxonomy_coverage = data.taxonomy_coverage; s.taxonomy_status = data.taxonomy_status;
      if (data.taxonomy_note) s.taxonomy_note = data.taxonomy_note; else delete s.taxonomy_note;
      delete s.taxonomy_error;
      saveState(); renderTaxonomy();
      toast((data.taxonomy_status === 'partial' ? 'Peta topik dibuat sebagian (respons AI terpotong).' : 'Peta topik berhasil dibuat.') + usageText(data.usage), data.taxonomy_status === 'partial' ? '' : 'success');
    } catch (error) {
      addUsage(error.usage);
      s.taxonomy_status = 'failed'; s.taxonomy_error = error.message; saveState(); renderTaxonomy();
      toast(error.message, 'error');
    } finally { taxonomyBusy = false; }
  }

  function typeColor(type) {
    const colours = {concept:'#ffffff', factor:'#dcb85c', outcome:'#9fd09f', context:'#86b4d8', method:'#e8906e'};
    return colours[type] || colours.concept;
  }
  // Mode formal: warna diagram non-taksonomi dipetakan ke abu-abu di atas putih (untuk unduhan SVG)
  const FORMAL_MAP = {'#000000':'#ffffff','#101010':'#f2f2f2','#3a3a3a':'#c4c4c4','#e8e8e8':'#111111','#ffffff':'#000000','#9a9a9a':'#555555','#9fd09f':'#3a3a3a','#86b4d8':'#6a6a6a','#e8906e':'#8f8f8f','#dcb85c':'#b0b0b0','#c9a0dc':'#7d7d7d','#7fd1c7':'#999999','#d98ba0':'#a5a5a5'};
  const formalizeSvg = s => document.body.classList.contains('formal') ? s.replace(/#[0-9a-fA-F]{6}\b/g, h => FORMAL_MAP[h.toLowerCase()] || h) : s;
  function downloadSvg(selector, filename) { const svg=$(selector); if(!svg){toast('Diagram belum tersedia.','error');return;} const blob=new Blob([formalizeSvg(svg.outerHTML)],{type:'image/svg+xml;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url); }
  async function checkHealth() {
    const pill = $('#ai-status');
    try {
      const h = await api('/api/health');
      healthInfo = h; updateUsageDot();
      if (h.max_files_per_batch) { serverLimits = {maxFiles: h.max_files_per_batch, maxFileMb: h.max_file_mb || 12}; applyServerLimits(); }
      if (h.ai_configured) {
        pill.className = 'status-pill status-ok';
        pill.innerHTML = '<span class="status-dot"></span> Model siap · ' + esc(h.model);
      } else {
        pill.className = 'status-pill status-warn';
        pill.innerHTML = '<span class="status-dot"></span> API key belum dipasang';
      }
    } catch (error) {
      pill.className = 'status-pill status-error';
      pill.innerHTML = '<span class="status-dot"></span> Backend tidak terhubung';
    }
  }

  async function handleUpload(event) {
    event.preventDefault();
    if (isBusy) return;
    clearGlobalMessage();
    const input = $('#pdf-files');
    let files = Array.from(input.files || []);
    if (!files.length) { globalMessage('Pilih setidaknya satu PDF.', 'error'); return; }
    const bad = files.filter(f=>f.size>serverLimits.maxFileMb*1024*1024 || (!f.name.toLowerCase().endsWith('.pdf') && f.type!=='application/pdf'));
    if (bad.length) { globalMessage(`Periksa file: ${bad.map(f=>f.name).join(', ')}. Setiap file harus PDF dan maksimal ${serverLimits.maxFileMb} MB.`, 'error'); return; }
    // Cek duplikat di browser sebelum upload: PDF yang hash-nya sudah ada di proyek tidak dikirim ke AI (hemat biaya).
    const skipped = [];
    if (window.crypto && crypto.subtle) {
      // Hanya artikel yang sudah dianalisis dengan versi analisis TERBARU yang dianggap 'sudah ada'. Artikel versi lama boleh diunggah ulang untuk dianalisis ulang.
      await loadCodebook();
      const known = new Set(state.articles.filter(a => (a.analysis_version || 1) >= currentAnalysisVersion()).map(a => a.hash).filter(Boolean));
      const fresh = [];
      for (const f of files) {
        let hash = null;
        try { hash = await sha256Hex(f); } catch (_) { /* file tidak terbaca: biarkan server memeriksa */ }
        if (hash && known.has(hash)) { skipped.push(f.name); continue; }
        if (hash) known.add(hash);
        fresh.push(f);
      }
      files = fresh;
    }
    if (skipped.length) {
      state.identifiedTotal = (state.identifiedTotal || 0) + skipped.length;
      state.duplicateCount = (state.duplicateCount || 0) + skipped.length;
      saveState(); renderAll();
    }
    if (!files.length) {
      input.value = ''; renderSelectedFiles();
      globalMessage(`${skipped.length} file sudah ada di proyek ini (hash sama), jadi tidak diproses ulang dan tidak memakai AI.`, 'success');
      return;
    }
    if (files.length > serverLimits.maxFiles) { globalMessage(`Maksimal ${serverLimits.maxFiles} PDF per batch. Pilih atau unggah batch yang lebih kecil.`, 'error'); return; }
    saveMetaFromForm(false);
    const meta = getMetaFromForm();
    const data = new FormData();
    files.forEach(f=>data.append('pdfs',f));
    data.append('research_question', meta.research_question);
    data.append('inclusion', meta.inclusion);
    data.append('exclusion', meta.exclusion);
    data.append('source_name', meta.source_name || 'Upload manual');
    data.append('search_query', meta.search_query);
    data.append('search_date', meta.search_date);
    setBusy(true, `Memproses ${files.length} PDF…`);
    $('#process-log').innerHTML = '<div class="process-log-item">Mengirim file ke backend…</div>';
    renderProcessProgress({percent:0, stage:'Mengirim file', current:0, total:files.length, logs:[]});
    const jobId = newJobId();
    data.append('job_id', jobId);
    const stopPolling = startProgressPolling('analysis', jobId);
    try {
      const response = await api('/api/analyze', {method:'POST', body:data});
      addUsage(response.usage);
      const newArticles = list(response.articles);
      let added=0, duplicates=0, reanalysed=0;
      for (const article of newArticles) {
        const idx = state.articles.findIndex(a=>a.hash===article.hash || a.id===article.id);
        if (idx >= 0 && (state.articles[idx].analysis_version || 1) < (article.analysis_version || 1)) {
          // Analisis ulang: ganti hasil ekstraksi, pertahankan keputusan manual pengguna, jangan hitung sebagai record baru.
          article.screening_decision = state.articles[idx].screening_decision;
          article.eligibility_decision = state.articles[idx].eligibility_decision;
          state.articles[idx] = article; reanalysed++; continue;
        }
        state.identifiedTotal = (state.identifiedTotal || 0) + 1;
        if (idx >= 0) { state.duplicateCount = (state.duplicateCount || 0)+1; duplicates++; continue; }
        state.articles.push(article); added++;
      }
      if (added || duplicates || reanalysed) state.synthesis = null;
      saveState(); renderAll();
      let message = `${added} artikel berhasil dianalisis.`;
      if (reanalysed) message += ` ${reanalysed} artikel lama dianalisis ulang (keputusan screening dipertahankan).`;
      if (duplicates) message += ` ${duplicates} duplikat dikenali dan tidak ditambahkan lagi.`;
      if (skipped.length) message += ` ${skipped.length} file dilewati karena sudah ada di proyek (tanpa biaya AI).`;
      if (list(response.errors).length) message += ' Beberapa file tidak berhasil dianalisis.';
      message += usageText(response.usage);
      if (list(response.errors).length) {
        const detailed = `${message} Detail: ${response.errors.map(e=>`${e.filename}: ${e.error}`).join(' | ')}`;
        globalMessage(detailed, 'error'); toast(message, 'error');
      } else {
        globalMessage(message, 'success'); toast(message, 'success');
      }
      input.value=''; renderSelectedFiles();
      navigate('articles');
    } catch (error) {
      addUsage(error.usage);
      globalMessage(error.message, 'error');
      toast(error.message, 'error');
    } finally { await stopPolling(); setBusy(false); }
  }

  async function handleSynthesis() {
    if (isBusy) return;
    clearGlobalMessage();
    saveMetaFromForm(false);
    const c = currentCounts();
    if (!c.included) { globalMessage('Belum ada artikel INCLUDE pada screening dan full-text eligibility. Buka tab Artikel untuk menetapkan keputusan manual.', 'error'); return; }
    setBusy(true, `Menyintesis ${c.included} artikel yang disetujui…`, 'synthesis');
    renderProcessProgress({percent:0, stage:'Mengirim data ke server', indeterminate:true, logs:[]}, 'synthesis');
    const jobId = newJobId();
    const stopPolling = startProgressPolling('synthesis', jobId);
    $('#run-synthesis').textContent = '* Menyintesis…';
    try {
      const data = await api('/api/synthesize', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({articles:state.articles, ...getMetaFromForm(), job_id:jobId})
      });
      addUsage(data.usage);
      state.synthesis = data.synthesis;
      saveState(); renderAll(); navigate('synthesis');
      const doneMessage = 'Review synthesis berhasil dibuat.' + usageText(data.usage);
      globalMessage(doneMessage, 'success'); toast(doneMessage, 'success');
    } catch (error) {
      addUsage(error.usage);
      globalMessage(error.message, 'error');
      toast(error.message, 'error');
    } finally { await stopPolling(); setBusy(false); $('#run-synthesis').textContent = '* Jalankan sintesis'; }
  }

  function renderSelectedFiles() {
    const files=Array.from($('#pdf-files').files||[]), box=$('#selected-files');
    if(!files.length){box.classList.add('hidden');box.innerHTML='';return;}
    box.classList.remove('hidden');
    box.innerHTML=files.map(f=>`<span class="file-chip"><span>▤</span><span>${esc(f.name)} · ${fileSize(f.size)}</span></span>`).join('');
  }
  function exportProject() {
    const payload = {format:'slr-protocol-project', version:1, exported_at:new Date().toISOString(), ...state};
    const blob = new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`slr-protocol-project-${new Date().toISOString().slice(0,10)}.json`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
    toast('Backup proyek diekspor sebagai JSON.', 'success');
  }
  async function importProject(file) {
    try {
      const data=JSON.parse(await file.text());
      if (!Array.isArray(data.articles)) throw new Error('File JSON tidak memiliki daftar artikel yang valid.');
      state={...structuredClone(DEFAULT_STATE), ...data, articles:data.articles, meta:data.meta||{}, usage:normaliseUsage(data.usage)};
      state.synthesis=data.synthesis||null;
      saveState();applyMeta(state.meta);renderAll();toast('Proyek berhasil diimpor.', 'success');
    } catch(error) { toast(`Impor gagal: ${error.message}`, 'error'); }
  }
  function renderAll() {
    renderUsage();renderMetrics();renderArticles();renderPrisma();renderSynthesis();renderTaxonomy();renderSystemMap();renderCooccurrence();
  }
  function handleDecisionChange(event) {
    const el=event.target;
    if (!(el instanceof HTMLSelectElement) || !el.dataset.id || !el.dataset.field) return;
    const article=findArticle(el.dataset.id); if(!article) return;
    article[el.dataset.field]=el.value;
    if (el.dataset.field==='screening_decision' && el.value!=='include') article.eligibility_decision='pending';
    // Any manual decision change can invalidate the previously generated collective synthesis.
    state.synthesis=null;
    saveState();renderAll();
    if (activeArticleDetail) renderArticleDetail(activeArticleDetail);
    toast('Keputusan tersimpan. Jalankan ulang sintesis bila daftar artikel yang termasuk berubah.', 'success');
  }

  // ---- Arah Riset (langkah 0, khusus TMI ITB) ----
  // Pilihan disimpan di kunci SENDIRI: tidak ikut Ekspor proyek dan tidak terhapus bersama artikel.
  const AR_KEY = 'slr_arah_riset_v1';
  const AR_LAYERS = [
    ['kk', 'Kelompok keilmuan', 'Kamu tertarik masuk kelompok keilmuan apa?'],
    ['masalah', 'Jenis masalah', 'Masalah seperti apa yang ingin kamu analisis?'],
    ['sektor', 'Sektor / konteks', 'Di sektor atau konteks apa?'],
    ['kelompok_metode', 'Kelompok metode', 'Pendekatan metodenya yang mana?'],
    ['metode', 'Metode spesifik', 'Ada metode spesifik yang menarik?'],
    ['pendekatan', 'Bentuk penelitian', 'Penelitianmu menghasilkan apa?']
  ];
  let ar = loadAr();
  let arReady = false, arShowEx = false, arLast = null, arSeq = 0;
  const arLabels = {}, arStore = {};

  function loadAr() {
    try {
      const v = JSON.parse(localStorage.getItem(AR_KEY) || '{}');
      const ids = AR_LAYERS.map(l => l[0]);
      const sel = {};
      Object.entries(v.sel || {}).forEach(([k, val]) => { if (ids.includes(k) && typeof val === 'string' && val) sel[k] = val; });
      return { sel, active: Number.isInteger(v.active) && v.active >= 0 && v.active < ids.length ? v.active : 0, extra: typeof v.extra === 'string' ? v.extra : '' };
    } catch (_) { return { sel: {}, active: 0, extra: '' }; }
  }
  function saveAr() { try { localStorage.setItem(AR_KEY, JSON.stringify(ar)); } catch (_) { /* penyimpanan penuh/diblokir: abaikan */ } }
  async function arApi(path, body) {
    const res = await fetch('/api/arah-riset/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('Gagal memuat Arah Riset (' + res.status + ').'));
    return data;
  }

  async function renderArahRiset() {
    if (!arReady) {
      try {
        const meta = await arApi('meta');
        $('#ar-total').textContent = meta.total.toLocaleString('id-ID');
        const kk = await arApi('options', { selected: {}, layer: 'kk' });
        kk.options.forEach(o => { arLabels['kk:' + o.value] = o.label; });
        arReady = true;
      } catch (err) { $('#ar-step').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`; return; }
    }
    renderArTabs();
    await renderArStep();
  }
  function renderArTabs() {
    $('#ar-tabs').innerHTML = AR_LAYERS.map(([id, title], i) =>
      `<button class="taxonomy-tab ${i === ar.active ? 'active' : ''}" data-ar-tab="${i}" role="tab" aria-selected="${i === ar.active}">${String(i + 1).padStart(2, '0')} / ${esc(title)}${ar.sel[id] ? ' ✓' : ''}</button>`).join('');
  }
  async function renderArStep() {
    const seq = ++arSeq;
    const [layer, title, question] = AR_LAYERS[ar.active];
    const box = $('#ar-step');
    let data;
    try { data = await arApi('options', { selected: ar.sel, layer }); }
    catch (err) { if (seq === arSeq) box.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`; return; }
    if (seq !== arSeq) return; // klik cepat: hanya render terakhir yang dipakai
    data.options.forEach(o => { arLabels[layer + ':' + o.value] = o.label; });
    const max = Math.max(1, ...data.options.map(o => o.count));
    const anySel = Object.keys(ar.sel).length > 0;
    const canGen = !!(ar.sel.masalah || ar.sel.sektor || ar.sel.metode || ar.sel.kelompok_metode);
    const chosen = AR_LAYERS.filter(([id]) => ar.sel[id]).map(([id]) => arLabels[id + ':' + ar.sel[id]] || ar.sel[id]);
    box.innerHTML = `<h2>${esc(title)}</h2><p class="ar-q">${esc(question)}</p>
      ${chosen.length ? `<p class="ar-hint">Pilihanmu: ${esc(chosen.join(' / '))}</p>` : ''}
      <p class="ar-count ${data.n === 0 ? 'ar-warn' : ''}">${data.n} tesis cocok dengan pilihan lain${data.n === 0 ? '. Kombinasi ini belum pernah ada; longgarkan pilihan lain.' : ''}</p>
      ${data.options.length ? data.options.map(o => `<button class="ar-opt ${ar.sel[layer] === o.value ? 'sel' : ''}" data-ar-v="${esc(o.value)}"><i style="width:${Math.round(o.count / max * 100)}%"></i><span>${esc(o.label)}</span><span class="ar-n">${o.count} tesis</span></button>`).join('') : '<p class="ar-hint">Tidak ada opsi umum untuk kombinasi ini. Lewati, atau longgarkan pilihan lain.</p>'}
      <div class="ar-actions">
        <button class="button button-quiet" data-ar-act="skip">Belum tahu</button>
        <button class="button button-quiet" data-ar-act="examples" ${anySel ? '' : 'disabled title="Pilih minimal satu hal dulu"'}>${arShowEx ? 'Sembunyikan contoh' : 'Lihat contoh tesis'}</button>
        <button class="button button-primary" data-ar-act="generate" ${canGen ? '' : 'disabled title="Pilih minimal masalah, sektor, atau metode"'}>Buat hasil</button>
        <button class="button button-quiet" data-ar-act="reset">Mulai ulang</button>
      </div>
      <div id="ar-examples"></div>
      <div class="field ar-extra"><label for="ar-extra">Kata kunci tambahan <span class="optional">(bahasa Inggris, pisahkan koma, opsional)</span></label><input id="ar-extra" type="text" maxlength="200" placeholder="contoh: cold chain, perishable" value="${esc(ar.extra)}"></div>`;
    if (arShowEx) await loadArExamples();
  }
  async function loadArExamples() {
    try {
      const data = await arApi('examples', { selected: ar.sel });
      const el = $('#ar-examples'); if (!el) return;
      el.innerHTML = `<ul class="ar-ex">${data.examples.map(e => `<li>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.judul)}</a>` : esc(e.judul)}${e.angkatan ? `<small>angkatan ${esc(e.angkatan)}</small>` : ''}</li>`).join('')}</ul><p class="ar-hint">Sampel acak dari ${data.n} tesis yang cocok. Tekan Lihat contoh lagi untuk sampel baru.</p>`;
    } catch (err) { toast(err.message, 'error'); }
  }
  async function generateArahRiset() {
    try {
      const j = await arApi('generate', { selected: ar.sel, extra: ar.extra });
      arLast = j;
      const list = a => `<ul>${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
      const parts = [
        ['topik', 'Topik umum', `<p>${esc(j.topik_umum)}</p>${j.topik_en ? `<p class="ar-hint">${esc(j.topik_en)}</p>` : ''}`, j.topik_umum],
        ['rq', 'Research question', `<p>${esc(j.research_question)}</p>`, j.research_question],
        ['rqslr', 'RQ untuk SLR', `<p>${esc(j.rq_untuk_slr)}</p>`, j.rq_untuk_slr],
        ['qsd', `Query ScienceDirect (${j.operator_sciencedirect} operator)`, `<pre>${esc(j.query_sciencedirect)}</pre><p class="ar-hint">Tempel di kolom Title, abstract or author-specified keywords.</p>`, j.query_sciencedirect],
        ['qsc', `Query Scopus (${j.operator_scopus} operator)`, `<pre>${esc(j.query_scopus)}</pre>`, j.query_scopus],
        ['inc', 'Kriteria inklusi', list(j.inklusi), j.inklusi.map(x => '- ' + x).join('\n')],
        ['exc', 'Kriteria eksklusi', list(j.eksklusi), j.eksklusi.map(x => '- ' + x).join('\n')]
      ];
      parts.forEach(p => { arStore[p[0]] = p[3]; });
      arStore.all = parts.map(p => p[1] + '\n' + p[3]).join('\n\n');
      const gaps = (j.celah_jurusan || []).length ? `<div class="ar-card"><h3>Celah di jurusanmu</h3>${list(j.celah_jurusan)}<p class="ar-hint">Belum ada di jurusanmu bukan berarti belum ada di literatur, dan belum tentu layak dikerjakan.</p></div>` : '';
      $('#ar-result').innerHTML = `<h2>Hasil</h2><p class="ar-count">${j.jumlah_tesis_serupa} tesis serupa di jurusanmu</p>
        ${parts.map(p => `<div class="ar-card"><h3>${esc(p[1])}<button class="button button-quiet button-small" data-ar-copy="${p[0]}">Salin</button></h3>${p[2]}</div>`).join('')}
        <div class="ar-card"><h3>Kalau hasil pencarian tidak pas</h3><p>${esc(j.panduan_hasil)}</p></div>${gaps}
        <div class="ar-actions"><button class="button button-quiet" data-ar-copy="all">Salin semua</button><button class="button button-quiet" data-ar-act="download">Unduh JSON</button></div>`;
      if (window.innerWidth <= 1100) $('#ar-result').scrollIntoView({ behavior: 'smooth' });
    } catch (err) { toast(err.message, 'error'); }
  }
  async function arClick(e) {
    const t = e.target.closest('[data-ar-tab],[data-ar-v],[data-ar-act],[data-ar-copy]');
    if (!t || t.disabled) return;
    if (t.dataset.arTab !== undefined) { ar.active = +t.dataset.arTab; arShowEx = false; saveAr(); renderArTabs(); renderArStep(); return; }
    if (t.dataset.arV !== undefined) {
      const layer = AR_LAYERS[ar.active][0];
      if (ar.sel[layer] === t.dataset.arV) delete ar.sel[layer]; else { ar.sel[layer] = t.dataset.arV; if (ar.active < AR_LAYERS.length - 1) ar.active++; }
      arShowEx = false; saveAr(); renderArTabs(); renderArStep(); return;
    }
    if (t.dataset.arCopy !== undefined) {
      const text = arStore[t.dataset.arCopy] || '';
      if (await copyText(text)) toast('Disalin ke clipboard.', 'success'); else showCopyFallback(text);
      return;
    }
    const act = t.dataset.arAct;
    if (act === 'guide') { const g = $('#ar-guide'); g.classList.toggle('hidden'); t.setAttribute('aria-expanded', String(!g.classList.contains('hidden'))); }
    else if (act === 'skip') { const layer = AR_LAYERS[ar.active][0]; delete ar.sel[layer]; if (ar.active < AR_LAYERS.length - 1) ar.active++; arShowEx = false; saveAr(); renderArTabs(); renderArStep(); }
    else if (act === 'examples') { arShowEx = !arShowEx; if (arShowEx) { t.textContent = 'Sembunyikan contoh'; await loadArExamples(); } else { t.textContent = 'Lihat contoh tesis'; $('#ar-examples').innerHTML = ''; } }
    else if (act === 'generate') await generateArahRiset();
    else if (act === 'reset') { ar = { sel: {}, active: 0, extra: '' }; arShowEx = false; arLast = null; saveAr(); renderArTabs(); renderArStep(); $('#ar-result').innerHTML = '<div class="empty-state">Belum ada hasil. Pilih beberapa hal, lalu tekan Buat hasil.</div>'; }
    else if (act === 'download' && arLast) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(arLast, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'arah-riset.json'; a.click(); URL.revokeObjectURL(url);
    }
  }

  // ===== Diagram taksonomi desain riset (halaman "Diagram Taksonomi") =====
  // Memvisualkan pohon dari /api/design-taxonomy sebagai diagram SVG (pohon horizontal atau radial).
  // SVG memakai warna literal (bukan variabel CSS) agar hasil unduhan SVG/PNG berdiri sendiri.
  const DG = {layout: 'tree', collapsed: new Set(), selected: null, zoom: 1, fit: true, all: false, refs: false, resetScroll: false, root: null, key: '', W: 0, H: 0, req: 0};
  const DG_BRANCH = {
    dark: {root: '#ffffff', metodologi: '#9fd09f', strategi: '#86b4d8', teknik: '#e8906e', fondasi: '#dcb85c'},
    // Mode formal (pohon): semua hitam, tanpa pembeda warna.
    light: {root: '#000000', metodologi: '#000000', strategi: '#000000', teknik: '#000000', fondasi: '#000000'},
  };
  const DG_PAL = {
    dark: {bg: '#000000', text: '#e8e8e8', dim: '#9a9a9a', nodeFill: '#101010', nodeStroke: '#3a3a3a', rootText: '#000000', sel: '#ffffff', arc: '#000000'},
    light: {bg: '#ffffff', text: '#000000', dim: '#555555', nodeFill: '#ffffff', nodeStroke: '#000000', rootText: '#ffffff', sel: '#000000', arc: '#7a7a7a'},
  };
  // Sunburst formal: tiap cabang punya dasar abu-abu (gelap sampai terang); makin ke cincin luar makin mendekati putih.
  const DG_GRAY = {metodologi: 30, strategi: 85, teknik: 140, fondasi: 190};
  const dgTheme = () => document.body.classList.contains('formal') ? 'light' : 'dark';
  const dgSwatch = id => {
    if (dgTheme() === 'light' && DG.layout === 'sunburst') { const v = DG_GRAY[id] ?? 60; return `rgb(${v},${v},${v})`; }
    const bc = DG_BRANCH[dgTheme()]; return bc[id] || bc.root;
  };
  const DG_KIND = {root: 'Topik (akar)', branch: 'Cabang', group: 'Kelompok', family: 'Keluarga teknik', value: 'Kategori', technique: 'Teknik', more: 'Ringkasan'};
  const DG_FONT = "'Inter', 'Segoe UI', Arial, sans-serif"; // lebar karakter rata-rata ~0,55 em: perkiraan 7,3 px/huruf di dgW dan sunburst masih aman
  const dgVK = n => DG.collapsed.has(n.id) ? [] : n.children;
  // Nomor jurnal sebuah simpul, nomornya sama dengan tab Desain Riset (designRefs). Deret berurutan >= 3 diringkas: [1–3, 5, 8].
  // Akar tidak diberi nomor (berisi semua artikel).
  function dgRefs(n) { return n.kind === 'root' ? '' : fmtRefs(n.article_ids, designRefs); }
  const dgTip = n => `${n.name}${n.count ? ` — ${n.count} artikel` : ''}${DG.refs && dgRefs(n) ? '\nNo. jurnal: ' + dgRefs(n) : ''}${n.definition ? '\n' + n.definition : ''}`;
  const dgTrunc = (s, m = 40) => { s = String(s || ''); return s.length > m ? s.slice(0, m - 1) + '…' : s; };
  // Teks panjang dibungkus (wrap) menjadi beberapa baris; nama lengkap tidak lagi dipotong.
  function dgWrap(s, max) {
    const out = []; let cur = '';
    String(s || '').trim().split(/\s+/).filter(Boolean).forEach(word => {
      while (word.length > max) {                        // kata yang lebih panjang dari satu baris: pecah dengan tanda hubung
        if (cur) { out.push(cur); cur = ''; }
        out.push(word.slice(0, max - 1) + '-'); word = word.slice(max - 1);
      }
      if (!cur) cur = word;
      else if ((cur + ' ' + word).length <= max) cur += ' ' + word;
      else { out.push(cur); cur = word; }
    });
    if (cur) out.push(cur);
    return out.length ? out : [''];
  }
  function dgMeasure(n) {
    const cap = n.kind === 'root' ? 24 : n.kind === 'branch' ? 26 : 32;
    n._lines = dgWrap(n.name, cap);
    const rs = DG.refs ? dgRefs(n) : '';
    n._rl = rs ? dgWrap(rs, cap) : [];   // baris nomor jurnal (opsional), digambar di bawah nama
    n._h = Math.max(24, (n._lines.length + n._rl.length) * 14.5 + 9);
    const cw = n.kind === 'root' ? 8.2 : n.kind === 'branch' ? 7.6 : 7.3, widest = Math.max(...n._lines.concat(n._rl).map(l => l.length));
    n._w = Math.round(widest * cw + (n.kind === 'root' ? 32 : 30) + (n.count > 0 && n.kind !== 'root' ? 30 : 0));
  }

  function dgPrep(node, depth, branch, path) {
    const id = path ? `${path}/${node.id}` : String(node.id);
    const br = depth === 1 ? node.id : branch;
    const CAP = DG.all ? Infinity : 15;   // DG.all (Buka semua) = tampilkan semua teknik; ringkasan "+N teknik lain" muncul pada tampilan awal dan Collapse
    // Simpul tanpa artikel (dan tanpa turunan yang punya artikel) tidak digambar. Cabang kosong tetap terlihat di tab Taksonomi Desain Riset.
    const alive = k => (k.count || 0) > 0 || list(k.children).some(alive);
    const kids = list(node.children).filter(alive);
    const techs = kids.filter(k => k.kind === 'technique');
    const out = [...kids.filter(k => k.kind !== 'technique'), ...techs.slice(0, CAP)].map(k => dgPrep(k, depth + 1, br, id));
    if (techs.length > CAP) {
      const hidden = techs.slice(CAP);
      out.push({id: id + '/~more', name: `+ ${hidden.length} teknik lain`, kind: 'more', count: 0, definition: 'Daftar lengkap ada pada Unduh JSON di halaman Taksonomi Desain Riset.', note: hidden.map(h => h.name).join('; '), article_ids: [], inferred_count: 0, children: [], depth: depth + 1, branch: br});
    }
    return {id, name: node.name, kind: node.kind, count: node.count || 0, definition: node.definition || '', note: node.note || '', article_ids: list(node.article_ids), inferred_count: node.inferred_count || 0, children: out, depth, branch: br};
  }
  function dgReprep() { if (DG.res) DG.root = dgPrep(DG.res.tree, 0, '', ''); }
  function dgWalk(n, fn) { fn(n); n.children.forEach(k => dgWalk(k, fn)); }
  function dgVWalk(n, fn) { fn(n); dgVK(n).forEach(k => dgVWalk(k, fn)); }
  function dgFind(id) { let hit = null; if (DG.root) dgWalk(DG.root, n => { if (n.id === id) hit = n; }); return hit; }

  function dgNodeSvg(n, pal, bc, x, y, rot, x0, dir) {
    const col = bc[n.branch] || bc.root, w = n._w, h = n._h || 24, L = n._lines || [n.name], RL = n._rl || [], A = L.concat(RL), sel = DG.selected === n.id;
    const isRoot = n.kind === 'root', isBranch = n.kind === 'branch', isMore = n.kind === 'more';
    const fill = isRoot ? col : pal.nodeFill;
    const stroke = sel ? pal.sel : isBranch ? col : isRoot ? col : pal.nodeStroke;
    const sw = sel ? 2.6 : isBranch ? 1.8 : 1;
    const tcol = isRoot ? pal.rootText : isBranch ? col : isMore ? pal.dim : pal.text;
    const weight = isRoot ? 800 : isBranch ? 700 : 500;
    const tip = dgTip(n);
    let g = `<g class="dg-node" data-id="${esc(n.id)}" transform="translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${rot.toFixed(2)})" style="cursor:pointer"><title>${esc(tip)}</title>`;
    g += `<rect x="${x0}" y="${(-h / 2).toFixed(1)}" width="${w}" height="${h.toFixed(1)}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${isMore ? ' stroke-dasharray="4 3"' : ''}/>`;
    if (!isRoot && !isBranch && !isMore) g += `<rect x="${x0 + 7}" y="-3" width="6" height="6" fill="${col}"/>`;
    const tx0 = x0 + (isRoot || isBranch || isMore ? 12 : 19);
    const tsp = A.map((t, i) => `<tspan x="${tx0}" y="${((i - (A.length - 1) / 2) * 14.5 + 4.2).toFixed(1)}"${i >= L.length ? ` fill="${pal.dim}" font-size="11" font-weight="400" font-style="normal"` : ''}>${esc(t)}</tspan>`).join('');
    g += `<text font-family="${DG_FONT}" font-size="${isRoot ? 13 : 12}" font-weight="${weight}"${isMore ? ' font-style="italic"' : ''} fill="${tcol}">${tsp}</text>`;
    if (n.count > 0 && !isRoot) {
      g += `<rect x="${x0 + w - 28}" y="-8.5" width="23" height="17" rx="6" fill="${col}" fill-opacity="0.18"/><text x="${x0 + w - 16.5}" y="4" text-anchor="middle" font-family="${DG_FONT}" font-size="11" font-weight="700" fill="${col}">${n.count}</text>`;
    }
    if (n.children.length && !isRoot) {
      const cx = dir > 0 ? x0 + w + 9 : x0 - 9;
      g += `<g class="dg-toggle" data-id="${esc(n.id)}"><rect x="${cx - 7.5}" y="-7.5" width="15" height="15" fill="${pal.bg}" stroke="${col}" stroke-width="1.4"/><text x="${cx}" y="4" text-anchor="middle" font-family="${DG_FONT}" font-size="12" font-weight="700" fill="${col}">${DG.collapsed.has(n.id) ? '+' : '−'}</text></g>`;
    }
    return g + '</g>';
  }

  function dgSizes(root) {
    const cols = [];
    (function f(n, d) { dgMeasure(n); cols[d] = Math.max(cols[d] || 0, n._w + (n.children.length && n.kind !== 'root' ? 18 : 0)); dgVK(n).forEach(k => f(k, d + 1)); })(root, 0);
    return cols;
  }

  function dgBuild(theme) {
    const root = DG.root, pal = DG_PAL[theme], bc = DG_BRANCH[theme], cols = dgSizes(root), formal = theme === 'light';
    const links = [], nodes = [];
    let W, H, tx, ty;
    if (DG.layout === 'tree') {
      const GAP = 62, PAD = 28, VPAD = 8;
      const xs = []; cols.forEach((w, i) => { xs[i] = i ? xs[i - 1] + cols[i - 1] + GAP : 0; });
      // Tinggi tiap subpohon = yang terbesar antara tinggi simpulnya sendiri dan jumlah tinggi anak-anaknya (simpul yang di-wrap lebih tinggi)
      const need = n => { const k = dgVK(n); n._need = Math.max(n._h + VPAD, k.reduce((t, c) => t + need(c), 0)); return n._need; };
      need(root);
      (function pos(n, d, top) {
        const kids = dgVK(n); n._x = xs[d];
        if (!kids.length) { n._y = top + n._need / 2; return; }
        const sum = kids.reduce((t, c) => t + c._need, 0); let cur = top + (n._need - sum) / 2;
        kids.forEach(k => { pos(k, d + 1, cur); cur += k._need; });
        n._y = (kids[0]._y + kids[kids.length - 1]._y) / 2;
      })(root, 0, 0);
      dgVWalk(root, n => {
        const col = bc[n.branch] || bc.root, kids = dgVK(n);
        const startX = n._x + n._w + (n.children.length && n.kind !== 'root' ? 18 : 0);
        kids.forEach(k => {
          const xm = (startX + k._x) / 2;
          links.push(`<path d="M${startX} ${n._y.toFixed(1)} C${xm} ${n._y.toFixed(1)} ${xm} ${k._y.toFixed(1)} ${k._x} ${k._y.toFixed(1)}" fill="none" stroke="${col}" stroke-opacity="${formal ? 1 : 0.5}" stroke-width="${formal ? 1.2 : 1.4}"/>`);
        });
        nodes.push(dgNodeSvg(n, pal, bc, n._x, n._y, 0, 0, 1));
      });
      W = xs[xs.length - 1] + cols[cols.length - 1] + PAD * 2 + 12; H = root._need + PAD * 2; tx = PAD; ty = PAD;
    } else {
      // Sunburst: cincin = kedalaman, lebar busur sebanding dengan jumlah daun yang tampil. Label panjang dibungkus per baris.
      const LH = 13, CW = 6.9, labelOf = n => n.name + (n.count ? ` (${n.count})` : '');
      const labLen = [];
      dgVWalk(root, n => { if (n.kind !== 'root') labLen[n.depth] = Math.max(labLen[n.depth] || 0, Math.min(labelOf(n).length, 30)); });
      const maxD = labLen.length - 1, thick = [];
      for (let d = 1; d <= maxD; d++) thick[d] = Math.min(210, Math.max(100, (labLen[d] || 0) * CW + 24));
      const wt = n => { const k = dgVK(n); n._wt = k.length ? k.reduce((t, c) => t + wt(c), 0) : 1; return n._wt; };
      wt(root);
      // Radius dalam diperbesar secukupnya agar label yang berbaris-baris muat di sepanjang busurnya
      const offs = []; let off = 0; for (let d = 1; d <= maxD; d++) { offs[d] = off; off += thick[d]; }
      let R0 = 82;
      dgVWalk(root, n => {
        if (n.kind === 'root') return;
        const wr = Math.max(6, Math.floor((thick[n.depth] - 12) / CW));
        n._sl = dgWrap(labelOf(n), wr); n._nl = n._sl.length;
        const rs = DG.refs ? dgRefs(n) : '';
        if (rs) {   // nomor jurnal: maksimal 2 baris di bawah nama; selengkapnya ada di tooltip dan panel detail
          let rl = dgWrap(rs, wr);
          if (rl.length > 2) { rl = rl.slice(0, 2); rl[1] = rl[1].slice(0, Math.max(1, wr - 1)) + '…'; }
          n._sl = n._sl.concat(rl);
        }
        const need = (n._sl.length * LH + 8) / (2 * Math.PI * n._wt / root._wt) - offs[n.depth] - thick[n.depth] / 2;
        if (need > R0) R0 = need;
      });
      R0 = Math.ceil(Math.min(R0, 900));
      const inner = [0, R0], outer = [R0];
      for (let d = 1; d <= maxD; d++) { outer[d] = inner[d] + thick[d]; inner[d + 1] = outer[d]; }
      (function pos(n, a0, a1) {
        n._a0 = a0; n._a1 = a1; let cur = a0;
        dgVK(n).forEach(k => { const span = (a1 - a0) * k._wt / n._wt; pos(k, cur, cur + span); cur += span; });
      })(root, -Math.PI / 2, 1.5 * Math.PI);
      const P = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
      const arc = (r0, r1, a0, a1) => {
        a1 = Math.min(a1, a0 + 2 * Math.PI - 0.002);
        const [x0, y0] = P(r1, a0), [x1, y1] = P(r1, a1), [x2, y2] = P(r0, a1), [x3, y3] = P(r0, a0), lg = a1 - a0 > Math.PI ? 1 : 0;
        return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${r1} ${r1} 0 ${lg} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}A${r0} ${r0} 0 ${lg} 0 ${x3.toFixed(1)} ${y3.toFixed(1)}Z`;
      };
      dgVWalk(root, n => {
        const col = bc[n.branch] || bc.root, tip = dgTip(n);
        if (n.kind === 'root') {
          const rr = R0 - 2, fs = Math.max(12, Math.min(22, rr / 6.5)), lh = fs * 1.22;
          const lines = dgWrap(n.name, Math.max(11, Math.floor(rr * 1.5 / (fs * 0.62))));
          const ls = lines.map((t, i) => `<tspan x="0" y="${((i - (lines.length - 1) / 2) * lh + fs * 0.33).toFixed(1)}">${esc(t)}</tspan>`).join('');
          nodes.push(`<g class="dg-node" data-id="${esc(n.id)}" style="cursor:pointer"><title>${esc(tip)}</title><circle r="${rr}" fill="${col}" stroke="${DG.selected === n.id ? pal.sel : pal.bg}" stroke-width="${DG.selected === n.id ? 3 : 2}"/><text text-anchor="middle" font-family="${DG_FONT}" font-size="${fs.toFixed(1)}" font-weight="800" fill="${pal.rootText}">${ls}</text></g>`);
          return;
        }
        const r0 = inner[n.depth] + 1, r1 = outer[n.depth] - 1, sel = DG.selected === n.id, solid = n.depth === 1;
        let fill = col, op = solid ? 0.95 : n.depth === 2 ? 0.5 : 0.3, tcol = solid ? pal.rootText : pal.text;
        if (formal) {   // putih → hitam: dasar abu-abu per cabang, makin terang ke cincin luar
          const base = DG_GRAY[n.branch] ?? 60, t = n.depth <= 1 ? 0 : n.depth === 2 ? 0.45 : 0.75, v = Math.round(base + (255 - base) * t);
          fill = `rgb(${v},${v},${v})`; op = 1; tcol = v > 140 ? '#111111' : '#ffffff';
        }
        const am = (n._a0 + n._a1) / 2, rm = (r0 + r1) / 2, arcLen = (n._a1 - n._a0) * rm;
        let g = `<g class="dg-node" data-id="${esc(n.id)}" style="cursor:pointer"><title>${esc(tip)}</title><path d="${arc(r0, r1, n._a0, n._a1)}" fill="${fill}" fill-opacity="${op}" stroke="${sel ? pal.sel : pal.arc}" stroke-width="${sel ? 2.6 : formal ? 0.8 : 1.5}"/>`;
        const maxLines = Math.floor((arcLen - 4) / LH);
        if (maxLines >= 1 && (n._a1 - n._a0) > 0.004) {
          let L = n._sl;
          if (L.length > maxLines) { L = L.slice(0, maxLines); const cap = Math.max(6, Math.floor((thick[n.depth] - 12) / CW)), last = L[maxLines - 1]; L[maxLines - 1] = (last.length >= cap ? last.slice(0, cap - 1) : last) + '…'; }  // hanya bila busur terlalu sempit; nama lengkap ada di tooltip dan panel detail
          const flip = Math.cos(am) < 0, [tx0, ty0] = P(rm, am), deg = am * 180 / Math.PI + (flip ? 180 : 0);
          const ls = L.map((t, i) => `<tspan x="0" y="${((i - (L.length - 1) / 2) * LH + 4).toFixed(1)}"${i >= n._nl ? ' font-size="11" font-weight="400" fill-opacity="0.8"' : ''}>${esc(t)}</tspan>`).join('');
          g += `<text transform="translate(${tx0.toFixed(1)},${ty0.toFixed(1)}) rotate(${deg.toFixed(2)})" text-anchor="middle" font-family="${DG_FONT}" font-size="12" font-weight="${solid ? 700 : 500}" fill="${tcol}">${ls}</text>`;
        }
        nodes.push(g + '</g>');
      });
      W = H = Math.ceil(outer[maxD] * 2 + 56); tx = W / 2; ty = H / 2;
    }
    DG.W = Math.ceil(W); DG.H = Math.ceil(H);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DG.W} ${DG.H}" width="${DG.W}" height="${DG.H}" role="img" aria-label="Diagram taksonomi desain riset"><rect width="100%" height="100%" fill="${pal.bg}"/><g transform="translate(${tx},${ty})">${links.join('')}${nodes.join('')}</g></svg>`;
    return svg;
  }

  function dgPaint() {
    const box = $('#dg-canvas'); if (!box || !DG.root) return;
    const reset = DG.resetScroll; DG.resetScroll = false;
    const sx = reset ? 0 : box.scrollLeft, sy = reset ? 0 : box.scrollTop;
    box.innerHTML = dgBuild(dgTheme());
    const aw = (box.clientWidth || DG.W) - 24;
    if (DG.fit === 'all') DG.zoom = Math.max(0.08, Math.min(1.5, aw / DG.W, (Math.max(280, window.innerHeight * 0.74) - 24) / DG.H));   // tombol Pas: seluruh diagram muat di layar
    else if (DG.fit) DG.zoom = Math.max(0.15, Math.min(1, aw / DG.W));
    const el = box.querySelector('svg');
    el.setAttribute('width', Math.round(DG.W * DG.zoom)); el.setAttribute('height', Math.round(DG.H * DG.zoom));
    box.scrollLeft = sx; box.scrollTop = sy;
    $$('[data-dg-layout]').forEach(b => b.classList.toggle('active', b.dataset.dgLayout === DG.layout));
    if (DG.res) dgLegend(DG.res);
  }

  function dgDetail(id) {
    const n = dgFind(id), box = $('#dg-detail'); if (!n || !box) return;
    const arts = list(n.article_ids).map(findArticle).filter(Boolean);
    const lines = arts.slice(0, 40).map(a => `<li><span class="dg-ref">[${esc(designRefs[a.id] || '?')}]</span> ${esc(a.title || '(tanpa judul)')} <span class="dim">(${esc(a.year || 'n.d.')})</span></li>`).join('');
    box.innerHTML = `<div class="dg-d-kind">${esc(DG_KIND[n.kind] || n.kind)}</div><h3>${esc(n.name)}</h3>`
      + (n.count ? `<div class="dg-d-count">${n.count} artikel${n.inferred_count ? ` · ${n.inferred_count} disimpulkan AI` : ''}</div>` : '')
      + (n.definition ? `<p>${esc(n.definition)}</p>` : '') + (n.note ? `<p class="dg-d-note">${esc(n.note)}</p>` : '')
      + (lines ? `<ol class="dg-d-list">${lines}</ol>${arts.length > 40 ? `<div class="dg-hint">+ ${arts.length - 40} artikel lain</div>` : ''}` : '');
  }

  function dgLegend(res) {
    const items = list(res.tree.children).map(b => `<div class="dg-lg"><i style="background:${dgSwatch(b.id)}"></i><span>${esc(b.name)}</span></div>`).join('');
    let total = 0, shown = 0; dgWalk(DG.root, () => { total++; }); const walk = n => { shown++; dgVK(n).forEach(walk); }; walk(DG.root);
    $('#dg-legend').innerHTML = `<div class="dg-d-kind">${dgTheme() === 'light' && DG.layout === 'tree' ? 'KETERANGAN' : 'LEGENDA'}</div>${dgTheme() === 'light' && DG.layout === 'tree' ? '' : `<div class="dg-lg-row">${items}</div>`}`
      + `<ul class="dg-notes"><li>Angka pada simpul = jumlah artikel.</li>${DG.refs ? '<li>Angka dalam [ ] = nomor jurnal (sama dengan tab Desain Riset); 3 nomor berurutan atau lebih ditulis sebagai rentang, mis. 1–3.</li>' : ''}<li><b>+</b> / <b>−</b> atau klik dua kali = buka / tutup cabang.</li><li>Satu artikel boleh masuk ke beberapa simpul.</li><li>Menampilkan ${shown} dari ${total} simpul.</li></ul>`;
  }

  async function renderDesignDiagram() {
    const box = $('#dg-canvas'); if (!box) return;
    state.designUi = {topic: '', scope: 'notexcluded', ...(state.designUi || {})};
    const arts = designScopeArticles(), mine = ++DG.req;
    const empty = msg => { DG.root = null; box.innerHTML = `<div class="empty-state">${msg}</div>`; $('#dg-legend').innerHTML = ''; };
    if (!arts.length) { $('#dg-meta').textContent = 'Belum ada artikel pada cakupan ini.'; empty('Belum ada artikel. Unggah PDF di Ikhtisar, lalu kembali ke halaman ini.'); return; }
    $('#dg-meta').textContent = 'Menyusun diagram…';
    let res;
    try {
      res = await api('/api/design-taxonomy', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({articles: arts, topic: state.designUi.topic, normalization: normState().approved})});
    } catch (e) { if (mine === DG.req) { $('#dg-meta').textContent = 'Gagal.'; empty(esc(e.message || 'Gagal menyusun diagram taksonomi.')); } return; }
    if (mine !== DG.req) return;
    if (!res.n_with_design) { $('#dg-meta').textContent = 'Belum ada label desain riset.'; empty('Belum ada artikel dengan label desain riset pada cakupan ini.'); return; }
    designRefs = {}; arts.forEach((a, i) => { designRefs[a.id] = i + 1; });
    DG.res = res; DG.root = dgPrep(res.tree, 0, '', '');
    const key = [res.n_with_design, state.designUi.topic, state.designUi.scope, res.tree.name].join('|');
    if (DG.key !== key) { DG.key = key; DG.selected = null; DG.fit = true; DG.collapsed = new Set(); dgWalk(DG.root, n => { if (n.depth >= 3 && n.children.length) DG.collapsed.add(n.id); }); }
    const scopes = {notexcluded: 'semua kecuali yang di-EXCLUDE', all: 'semua artikel', included: 'hanya INCLUDE'};
    $('#dg-meta').innerHTML = `Topik: <b>${esc(res.tree.name)}</b> · ${esc(res.n_with_design)} artikel · cakupan: ${esc(scopes[state.designUi.scope] || state.designUi.scope)} · codebook ${esc(res.codebook_version)}`;
    dgLegend(res); dgPaint();
    if (DG.selected && dgFind(DG.selected)) dgDetail(DG.selected);
  }

  function dgToggle(id) {
    const n = dgFind(id); if (!n || !n.children.length || n.kind === 'root') return;
    if (DG.collapsed.has(id)) DG.collapsed.delete(id); else DG.collapsed.add(id);
    dgLegend(DG.res); dgPaint();
  }
  function dgDownload(kind) {
    if (!DG.root) { toast('Belum ada diagram untuk diunduh.', 'error'); return; }
    const svg = dgBuild(dgTheme());   // unduhan mengikuti Mode formal
    dgPaint();   // dgBuild memperbarui ukuran; gambar layar dibangun ulang
    const slug = String((state.designUi || {}).topic || 'topik').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'topik';
    const save = (blob, ext) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `diagram-taksonomi-${slug}.${ext}`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
    if (kind === 'svg') { save(new Blob([svg], {type: 'image/svg+xml;charset=utf-8'}), 'svg'); return; }
    const scale = Math.min(2, 8000 / Math.max(DG.W, DG.H)), img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = Math.round(DG.W * scale); c.height = Math.round(DG.H * scale);
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => b ? save(b, 'png') : toast('Gagal membuat PNG. Gunakan unduhan SVG.', 'error'), 'image/png');
    };
    img.onerror = () => toast('Gagal membuat PNG. Gunakan unduhan SVG.', 'error');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function attachDiagramEvents() {
    const fm = $('#formal-toggle');
    if (fm) {
      const apply = on => {
        document.body.classList.toggle('formal', on); fm.setAttribute('aria-pressed', on ? 'true' : 'false');
        try { localStorage.setItem('slr-formal-mode', on ? '1' : '0'); } catch (_) { /* penyimpanan diblokir: abaikan */ }
        if (DG.root) dgPaint();
      };
      let saved = false; try { saved = localStorage.getItem('slr-formal-mode') === '1'; } catch (_) { /* abaikan */ }
      apply(saved);
      fm.addEventListener('click', () => apply(!document.body.classList.contains('formal')));
    }
    const rf = $('#dg-refs');
    if (rf) {
      const applyRefs = on => { DG.refs = on; rf.setAttribute('aria-pressed', on ? 'true' : 'false'); };
      let savedRefs = false; try { savedRefs = localStorage.getItem('slr-dg-refs') === '1'; } catch (_) { /* abaikan */ }
      applyRefs(savedRefs);
      rf.addEventListener('click', () => {
        applyRefs(!DG.refs);
        try { localStorage.setItem('slr-dg-refs', DG.refs ? '1' : '0'); } catch (_) { /* penyimpanan diblokir: abaikan */ }
        if (DG.root) { dgLegend(DG.res); dgPaint(); }
      });
    }
    const cv = $('#dg-canvas'); if (!cv) return;
    cv.addEventListener('click', e => {
      const tg = e.target.closest('.dg-toggle'); if (tg) { dgToggle(tg.dataset.id); return; }
      const nd = e.target.closest('.dg-node'); if (!nd) return;
      DG.selected = nd.dataset.id; dgPaint(); dgDetail(DG.selected);
    });
    cv.addEventListener('dblclick', e => { const nd = e.target.closest('.dg-node'); if (nd) dgToggle(nd.dataset.id); });
    $$('[data-dg-layout]').forEach(b => b.addEventListener('click', () => { DG.layout = b.dataset.dgLayout; DG.fit = true; dgPaint(); }));
    $('#dg-expand').addEventListener('click', () => { if (!DG.root) return; DG.all = true; dgReprep(); DG.collapsed.clear(); DG.fit = true; dgPaint(); });
    $('#dg-collapse').addEventListener('click', () => { if (!DG.root) return; DG.all = false; dgReprep(); dgWalk(DG.root, n => { if (n.depth >= 1 && n.children.length) DG.collapsed.add(n.id); }); DG.fit = true; dgPaint(); });
    $('#dg-zoom-in').addEventListener('click', () => { DG.fit = false; DG.zoom = Math.min(2.5, DG.zoom * 1.2); dgPaint(); });
    $('#dg-zoom-out').addEventListener('click', () => { DG.fit = false; DG.zoom = Math.max(0.2, DG.zoom / 1.2); dgPaint(); });
    $('#dg-fit').addEventListener('click', () => { if (!DG.root) return; DG.fit = 'all'; DG.resetScroll = true; dgPaint(); });   // hanya zoom: lipatan tidak berubah
    $('#dg-svg').addEventListener('click', () => dgDownload('svg'));
    $('#dg-png').addEventListener('click', () => dgDownload('png'));
    window.addEventListener('resize', () => { if (DG.root && DG.fit && $('#design-diagram').classList.contains('active-section')) dgPaint(); });
  }

  function attachEvents() {
    attachDiagramEvents();
    $$('.nav-item').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.target)));
    $$('[data-go]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.go)));
    $('#arah-riset').addEventListener('click',arClick);
    $('#arah-riset').addEventListener('input',e=>{if(e.target.id==='ar-extra'){ar.extra=e.target.value;saveAr();}});
    $('#project-form').addEventListener('submit',e=>{e.preventDefault();saveMetaFromForm(true);});
    $('#upload-form').addEventListener('submit',handleUpload);
    $('#run-synthesis').addEventListener('click',handleSynthesis);
    $('#design-topic').addEventListener('input',e=>{state.designUi={...(state.designUi||{}),topic:e.target.value};saveState();clearTimeout(window.__designTimer);window.__designTimer=setTimeout(renderDesign,350);});
    $('#design-scope').addEventListener('change',e=>{state.designUi={...(state.designUi||{}),scope:e.target.value};saveState();renderDesign();});
    $('#design-report').addEventListener('click', downloadDesignReport);
    $('#norm-panel').addEventListener('click', handleNormClick);
    $('#norm-panel').addEventListener('change', handleNormChange);
    $('#design-copy').addEventListener('click',async()=>{if(!designResult){return;}const t=dtText(designResult.res.tree)+'\nReferensi:\n'+designResult.arts.filter(a=>designResult.res.tree.article_ids.includes(a.id)).map(a=>`[${designRefs[a.id]}] ${a.title} (${a.year||'n.d.'})`).join('\n');if(await copyText(t)){toast('Outline taksonomi disalin ke clipboard.','success');return;}toast('Browser memblokir clipboard. Teks ditampilkan di bawah: pilih semua lalu salin manual (Ctrl+C).','error');showCopyFallback(t);});
    $('#design-download').addEventListener('click',()=>{if(!designResult){return;}const blob=new Blob([JSON.stringify({...designResult.res, normalization: normState().approved},null,2)],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='taksonomi-desain-riset.json';link.click();URL.revokeObjectURL(link.href);});
    $('#pdf-files').addEventListener('change',renderSelectedFiles);
    const dz=$('#dropzone');
    ['dragenter','dragover'].forEach(name=>dz.addEventListener(name,e=>{e.preventDefault();dz.classList.add('dragging');}));
    ['dragleave','drop'].forEach(name=>dz.addEventListener(name,e=>{e.preventDefault();dz.classList.remove('dragging');}));
    dz.addEventListener('drop',e=>{const all=Array.from(e.dataTransfer.files||[]).filter(f=>f.name.toLowerCase().endsWith('.pdf'));if(!all.length){toast('File yang dijatuhkan bukan PDF.', 'error');return;}const max=serverLimits.maxFiles,files=all.slice(0,max);const transfer=new DataTransfer();files.forEach(f=>transfer.items.add(f));$('#pdf-files').files=transfer.files;renderSelectedFiles();if(all.length>max)toast(`Hanya ${max} PDF pertama yang dipilih (batas per batch). ${all.length-max} file lain tidak ikut; unggah di batch berikutnya.`, 'error');});
    $('#articles-body').addEventListener('change',handleDecisionChange);
    $('#articles-body').addEventListener('click',e=>{const b=e.target.closest('[data-detail]');if(b)renderArticleDetail(b.dataset.detail);});
    $('#article-search').addEventListener('input',renderArticles);
    $('#article-filter').addEventListener('change',renderArticles);
    $('#article-detail').addEventListener('click',e=>{if(e.target.id==='close-detail'){activeArticleDetail=null;$('#article-detail').classList.add('hidden');}});
    $('#article-detail').addEventListener('change',e=>{const el=e.target;if(!(el instanceof HTMLInputElement)||el.id!=='verify-article')return;const a=findArticle(el.dataset.id);if(!a)return;if(el.checked){a.owner_verified=true;a.owner_verified_at=new Date().toISOString();}else{delete a.owner_verified;delete a.owner_verified_at;}saveState();renderArticles();renderDesignSteps();toast(el.checked?'Ditandai sudah diverifikasi.':'Tanda verifikasi dicabut.','success');});
    $('#clear-articles').addEventListener('click',()=>{if(!state.articles.length)return;if(!confirm('Hapus semua artikel dan hasil sintesis dari proyek browser ini? Tindakan ini tidak dapat dibatalkan, ekspor backup dahulu jika perlu.'))return;state.articles=[];state.identifiedTotal=0;state.duplicateCount=0;state.synthesis=null;activeArticleDetail=null;$('#article-detail').classList.add('hidden');saveState();renderAll();toast('Daftar artikel dihapus.','success');});
    $$('.taxonomy-tab').forEach(b=>b.addEventListener('click',()=>{activeTaxonomy=b.dataset.taxonomy;renderTaxonomy();}));
    $('#cooccurrence-min')?.addEventListener('change',renderCooccurrence);
    $('#cooccurrence-dominant')?.addEventListener('change',renderCooccurrence);
    $('#cooccurrence-relayout')?.addEventListener('click',renderCooccurrence);
    ['#system-map-max','#system-map-main','#system-map-hier'].forEach(id=>$(id)?.addEventListener('change',renderSystemMap));
    $('#system-map-relayout')?.addEventListener('click',renderSystemMap);
    $('#taxonomy-content')?.addEventListener('click',e=>{ if(e.target.closest('#taxonomy-retry')) retryTaxonomy(); });
    $('#cooccurrence-download')?.addEventListener('click',()=>{ const c=$('#cooccurrence-canvas'); if(c&&c._net) c._net.clear(); downloadSvg('#cooccurrence-canvas svg','cooccurrence-network.svg'); });
    $('#export-json').addEventListener('click',exportProject);
    setupUsagePopover();
    $('#import-json').addEventListener('click',()=>$('#import-json-file').click());
    $('#import-json-file').addEventListener('change',e=>{if(e.target.files[0])importProject(e.target.files[0]);e.target.value='';});
    // Import is reachable with keyboard shortcut Ctrl/Cmd+Shift+O; exports remain accessible in the header.
    document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='o'){e.preventDefault();$('#import-json-file').click();}});
    $('#print-prisma').addEventListener('click',()=>{navigate('prisma');setTimeout(()=>window.print(),200);});
    $('#system-map-download').addEventListener('click',()=>{
      const sc=$('#system-map-canvas'); if(sc&&sc._net) sc._net.clear();
      const svg=$('#system-map-svg');if(!svg){toast('Belum ada system map untuk diunduh.','error');return;}
      const clone=svg.cloneNode(true);clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
      const blob=new Blob([formalizeSvg(new XMLSerializer().serializeToString(clone))],{type:'image/svg+xml;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='system-map.svg';a.click();URL.revokeObjectURL(url);toast('System map diekspor sebagai SVG.','success');
    });
    // Persist form edits even if the user navigates away before pressing save.
    ['research-question','source-name','search-date','search-query','inclusion','exclusion'].forEach(id=>$('#'+id).addEventListener('change',()=>saveMetaFromForm(false)));
  }

  document.addEventListener('DOMContentLoaded',()=>{
    // This script is deferred; DOM is ready by the time it runs in modern browsers.
    applyMeta(state.meta);attachEvents();renderAll();checkHealth();loadCodebook();
    const h=location.hash.slice(1);const hs=h&&document.getElementById(h);if(hs&&hs.classList.contains('page-section'))navigate(h);
    window.addEventListener('hashchange',()=>{const t=location.hash.slice(1),el=t&&document.getElementById(t);if(el&&el.classList.contains('page-section')&&!el.classList.contains('active-section'))navigate(t);});
    if (!state.meta.search_date) { const d=new Date();$('#search-date').value=d.toISOString().slice(0,10); }
  });
})();