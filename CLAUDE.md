# CLAUDE.md — SLR Protocol: panduan teknis end-to-end

Dokumen ini untuk developer dan agen AI (Claude Code) yang akan membaca atau mengubah repo ini.
Baca bagian 1–3 dulu, lalu loncat ke bagian yang relevan. README.md berisi panduan untuk pengguna akhir.

## 1. Ringkasan

SLR Protocol adalah web app satu-halaman untuk systematic literature review:

1. Pengguna mengisi konteks review (research question, kriteria inklusi/eksklusi, sumber, query).
2. Pengguna mengunggah PDF. Backend mengekstrak teks (PyMuPDF), meminta LLM menyusun **JSON terstruktur** per
   artikel, dan mengembalikannya ke browser.
3. Pengguna menetapkan keputusan **screening** dan **full-text eligibility** secara manual.
4. Pengguna menjalankan **sintesis**: LLM menyintesis semua artikel INCLUDE (tema, kesepakatan, kontradiksi,
   research gap) dan menyusun **peta topik** (taxonomy) lewat satu panggilan terpisah.
5. Frontend merender PRISMA, sintesis, peta topik, co-occurrence, dan system map. **Co-occurrence dan system map dihitung kode**
   dari data ekstraksi tiap artikel (`topic_tags`, `concepts`, `relationships`), bukan keluaran sintesis AI (bagian 4.2a).
6. Proyek diekspor sebagai **JSON** (backup, bisa diimpor ulang) atau **HTML interaktif hanya-baca** (semua tab, grafik tetap bisa
   dikontrol, dibuka offline; bagian 4.2b).

Status: **prototype** untuk riset pribadi dan kelompok. Proyek tidak disimpan di server (tidak ada database proyek). Ada dua mode:

- **Mode mandiri:** `.env` memilih provider AI (Ollama atau DeepSeek dengan key sendiri). Tanpa akun.
- **Mode terkelola (cara distribusi ke pengguna):** aplikasi berjalan di laptop pengguna, pengguna mendaftar sekali lewat `/signup`,
  AI lewat proxy Supabase Edge Function yang memegang key DeepSeek admin, dan pemakaian token dicatat per akun di Supabase.
  Rincian di bagian 9.1.

Ada tes otomatis (bagian 10), tetapi belum ada CI.

### Prinsip desain (jangan dilanggar tanpa alasan kuat)

- **Satu berkas backend utama (`app.py`) dan satu berkas frontend (`static/app.js`)**, tanpa framework dan tanpa build
  step. Mudah dibaca dan diubah. Modul pendamping kecil yang sudah ada: `arah_riset.py` dan `user_auth.py`. Jangan memecah
  lebih jauh atau menambah toolchain kecuali diminta.
- **State milik browser.** Server hampir stateless: hanya menyimpan progres pekerjaan di memori (sementara).
  Sumber kebenaran proyek adalah `localStorage` + file Ekspor JSON.
- **AI hanya membantu, manusia memutuskan.** Rekomendasi screening AI tidak pernah otomatis menjadi keputusan
  (`screening_decision` dan `eligibility_decision` selalu mulai `pending`).
- **Provider AI dapat dipertukarkan lewat `.env`** (`ollama` atau `deepseek`) tanpa mengubah kode. Di mode terkelola provider
  dipaksa `deepseek` dan diarahkan ke proxy.
- **Rahasia tidak pernah ada di repo atau di laptop pengguna.** Key DeepSeek admin hanya ada sebagai secret Supabase.
  `.env.example` publik dan menjadi bawaan semua pengguna di mode terkelola, jadi jangan isi rahasia di sana.
- Teks UI, pesan error, dan log berbahasa **Indonesia**. Nama variabel/fungsi berbahasa Inggris.

## 2. Struktur repo

```
app.py                  Backend Flask. Config, provider AI, progres, biaya, prompt, semua route.
templates/index.html    Satu halaman Jinja (hanya url_for untuk gambar). Semua tab ada di sini.
static/app.js           Frontend: IIFE tunggal, state, render, upload, progres, popup token, ekspor/impor.
static/style.css        Tema terminal (monokrom, font mono, variabel CSS).
templates/landing.html  Landing page (halaman depan di `/`). Berdiri sendiri; CSS-nya `static/landing.css`, TIDAK memuat style.css. Urutan: hero (daftar 10 tab), statistik, **Tur hasil** (carousel 8 slide), Fitur (9 kartu), Alur kerja (4 langkah), Bisa ditelusuri, Prinsip, FAQ, CTA.
static/landing.css      Gaya landing saja. Tema terminal yang SAMA dengan workspace, tetapi `:root` disalin (bukan di-import): ubah warna/font di `style.css` = ubah juga di sini.
arah_riset.py          Langkah 0 (khusus TMI ITB): mesin pertanyaan dan generator topik/RQ/query/kriteria. Murni komputasi, tanpa AI.
arah_riset_data/        thesis_facets.json (facet tesis TMI) + vocab_en.json (istilah query bahasa Inggris). BUKAN di data/ karena data/ di-gitignore.
requirements.txt        Flask, PyMuPDF, python-dotenv. (Sengaja tanpa SDK Supabase: user_auth.py memakai urllib.)
synthesis_pdf.py        PDF Review Synthesis (PyMuPDF Story): `build_html`, `build_pdf`. Dipakai `POST /api/synthesis-pdf`. Bagian 4.2c.
user_auth.py            Mode terkelola: gerbang /signup, daftar ke Supabase (RPC), tulis USER_API_KEY ke .env, arahkan AI ke proxy. Bagian 9.1.
templates/signup.html   Halaman pendaftaran (berdiri sendiri, CSS inline, tema sama dengan landing).
supabase/schema.sql     Tabel users/token_logs, RLS, fungsi register_user dan check_user, view usage_per_user. Dijalankan manual di SQL Editor.
supabase/functions/llm-proxy/index.ts   Edge Function (Deno): cek akun/kuota, teruskan ke DeepSeek, catat token. Di-deploy manual, TIDAK ikut git pull.
slr-protocol.bat        Peluncur Windows: git pull, .env minimal, venv, pip install, buka browser, python app.py. Harus CRLF (lihat .gitattributes).
.gitattributes          `*.bat text eol=crlf` supaya .bat tetap CRLF setelah clone.
.env.example            Konfigurasi bersama dan penjelasannya. Di mode terkelola SEMUA nilai terisi menjadi bawaan untuk pengguna.
.gitignore              Mengabaikan .env, .env.tmp, .venv, venv, data/, dan berkas ekspor proyek.
tests/                  python: test_routes, test_arah_riset, test_research_design, test_user_auth, test_json_repair, test_export_html, test_synthesis_pipeline, test_synthesis_pdf. node: ui_smoke, ui_report_check (butuh jsdom, opsional), viewer_smoke, live_export_smoke (pakai dom_shim.js buatan sendiri, tanpa npm install).
```

Aset gambar di `static/`: `slr.png` (logo + favicon), `latte0nim.jpg` dan `feinstehaar.jpg` (avatar credit), `qris.png`
(QRIS di popup token; kotaknya menyembunyikan diri bila gambar tidak ada), `slr.ico` (ikon shortcut Windows, dibuat dari `slr.png`).

Folder `data/` hanya dibuat saat `KEEP_SERVER_PDFS` / `KEEP_SERVER_JSON` dinyalakan (`data/pdfs`, `data/json`),
dan **tidak pernah dibaca kembali** oleh aplikasi. Keduanya mati secara bawaan.

## 3. Menjalankan dan konfigurasi

```bash
pip install -r requirements.txt
cp .env.example .env     # isi LLM_PROVIDER dan kredensial
python app.py            # http://127.0.0.1:5000 (alamat dan port dari HOST/PORT, lihat bagian 3 dan 11)
```

Itu cara mode mandiri. Pengguna di mode terkelola cukup `git clone` lalu klik dua kali `slr-protocol.bat` (bagian 9.1).
Server bawaan Flask dipakai untuk penggunaan lokal. Distribusi ke pengguna dijelaskan di bagian 9.1; batasan bila aplikasi
di-host di server dicatat di bagian 9.2.

`.env` dimuat dari folder `app.py` dengan `override=False` (variabel environment sistem menang atas `.env`).
**Nilai yang ada di `.env`/environment selalu mengalahkan nilai bawaan kode.** Contoh jebakan: `.env` lama yang berisi
`MAX_TEXT_CHARS=18000` membuat bawaan DeepSeek (130000) tidak berlaku.

Di mode terkelola ada satu lapis tambahan, `user_auth.prepare_env()`, yang dipanggil tepat setelah `load_dotenv`. Urutan
prioritas: environment sistem > `.env` > `.env.example` (nilai yang terisi) > bawaan kode. Karena itu `.env` pengguna cukup berisi
`USER_API_KEY`, dan perubahan di `.env.example` sampai ke semua pengguna lewat `git pull` tanpa menyentuh `.env` mereka.
Pada mode mandiri atau `USER_AUTH=off`, `.env.example` diabaikan sepenuhnya (hanya `SUPABASE_URL`/`SUPABASE_ANON_KEY` yang dibaca
untuk menentukan apakah mode terkelola aktif).

### Variabel konfigurasi

| Variabel | Bawaan | Fungsi |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | `ollama` atau `deepseek`. Nilai lain menghentikan start (`SystemExit`). Mode terkelola memaksa `deepseek`. |
| `OLLAMA_URL` / `OLLAMA_MODEL` | `http://127.0.0.1:11434/api/chat` / `qwen3-vl:8b-instruct` | Ollama lokal. |
| `OLLAMA_NUM_CTX` / `OLLAMA_MAX_OUTPUT_TOKENS` | `12288` / `3500` | Konteks dan plafon output Ollama. |
| `DEEPSEEK_API_KEY` | kosong | Wajib bila provider deepseek (mode mandiri). Tanpa ini `AI_CONFIGURED=False` dan route AI menjawab 503. Mode terkelola: diisi otomatis dari `USER_API_KEY`. |
| `DEEPSEEK_MODEL` / `DEEPSEEK_URL` | `deepseek-flash` / `https://api.deepseek.com/chat/completions` | Model dan endpoint. Mode terkelola: `DEEPSEEK_URL` bawaan `<SUPABASE_URL>/functions/v1/llm-proxy`. |
| `DEEPSEEK_PRICE_INPUT_MISS/HIT`, `DEEPSEEK_PRICE_OUTPUT` | `0.15` / `0.003` / `0.60` | USD per 1 juta token, tarif **off-peak**. |
| `DEEPSEEK_PEAK_MULTIPLIER` | `2` | Pengali tarif saat jam peak. Isi `1` untuk mematikan. |
| `USD_TO_IDR` | `18000` | Kurs untuk estimasi rupiah (hanya tampilan). |
| `MAX_TEXT_CHARS` | 18000 ollama / 130000 deepseek | Teks isi artikel per PDF yang dikirim ke AI (di luar daftar pustaka). Dibatasi keras 200000. Naik/turunnya angka ini TIDAK memengaruhi citation graph: daftar pustaka diurai kode dari teks yang dibuang, sebelum pemotongan. |
| `MAX_FILES_PER_BATCH` | 8 / 20 | PDF per upload. |
| `MAX_FILE_MB` | 12 / 30 | Ukuran per PDF. |
| `SYNTH_BATCH_SIZE` / `REDUCE_GROUP_SIZE` | 4 / 4 (ollama), 8 / 12 (deepseek) | Ukuran batch sintesis dan grup penggabungan. Reduce sengaja baru terjadi bila batch > 12 karena penggabungan membuang detail. `.env` menimpa bawaan kode: samakan dengan `.env.example`. |
| `LLM_OUTPUT_SCALE` | `1` ollama / `1.75` deepseek | Pengali plafon token output (hanya plafon, bukan target). |
| `KEEP_SERVER_PDFS` / `KEEP_SERVER_JSON` | `false` / `false` | Salinan opsional di `data/`. |
| `APP_USERNAME` / `APP_PASSWORD` | `slr-user` / kosong | HTTP Basic Auth. Kosong = tanpa auth (peringatan dicetak bila provider deepseek). |
| `HOST` / `PORT` | `0.0.0.0` / `5000` | Alamat dan port saat `python app.py`. `HOST=127.0.0.1` = hanya komputer ini. Mode terkelola: `HOST` bawaan `127.0.0.1`. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | kosong | Diisi admin di `.env.example`. Keduanya terisi (dan `USER_AUTH` bukan `off`) = mode terkelola aktif. Anon key aman dipublikasikan (bagian 9.1). |
| `USER_API_KEY` | kosong | Key pribadi pengguna (`slr_` + 48 heksadesimal), ditulis otomatis ke `.env` oleh `/signup`. Jangan di-commit. |
| `USER_AUTH` | kosong | `off` (atau `0`/`false`/`no`) mematikan mode terkelola walau Supabase terisi. Dipakai admin saat pengembangan dan di `tests/test_routes.py`. |

Bawaan batas bergantung provider karena model lokal 8B berkonteks sempit, sedangkan API berkonteks besar.
`MAX_CONTENT_LENGTH` Flask dihitung dari `MAX_FILES_PER_BATCH × ukuran file + 5 MB`; error 413 ditangani.

## 4. Alur end-to-end

```
Browser                                   Flask (app.py)                          LLM
  |  GET /api/health  --------------------> limits, provider, status tarif
  |  (pre-check) SHA-256 tiap PDF; lewati yang hash-nya sudah ada di state.articles
  |  POST /api/analyze (multipart + job_id) -> new_progress(job) ; per PDF:
  |       <-- polling GET /api/analysis-progress?job_id  read_pdf -> article_prompt -> llm_json (stream) ---> chat completions
  |                                           normalisasi -> record artikel (id = sha256[:16])
  |  <-- {articles, errors, model, usage}
  |  state.articles += artikel baru (dedupe by hash/id); simpan ke localStorage
  |  pengguna mengubah screening_decision / eligibility_decision di tab Artikel (state.synthesis di-reset)
  |  POST /api/synthesize (json + job_id) --> filter INCLUDE+INCLUDE -> alias ID -> batch -> (reduce)* -> final 1/2 + 2/2 -> cek cakupan -> per tema -> taksonomi
  |  POST /api/synthesis-pdf (synthesis+articles+meta) --> synthesis_pdf.build_pdf --> application/pdf (tanpa AI)
  |       <-- polling GET /api/synthesis-progress?job_id
  |  <-- {synthesis, usage}  -> state.synthesis; render PRISMA / sintesis / taxonomy / peta literatur / system map
```

### 4.1 Analisis (`POST /api/analyze`)

Form multipart: `pdfs` (banyak), `research_question`, `inclusion`, `exclusion`, `source_name`, `search_query`,
`search_date`, `job_id`. Panjang tiap teks dipotong di server (RQ 1000, kriteria 3000).

Per PDF (berurutan, satu request panjang):
1. Validasi: ukuran ≤ `MAX_FILE_MB`, signature `%PDF`.
2. `read_pdf()`: PyMuPDF membaca SEMUA halaman (batas keras 600.000 karakter) dengan penanda `[PAGE n]`.
   `split_references()` memisahkan daftar pustaka dari isi artikel: isi diteruskan ke AI, daftar pustaka TIDAK dikirim ke AI tetapi diurai kode
   (`parse_references`, tanpa token) menjadi `record.references`; lalu `trim_text()` memotong ke `MAX_TEXT_CHARS` dengan
   menyimpan 70% awal + sisanya dari AKHIR dokumen (penanda `[... bagian tengah dipotong ...]`). Dulu hanya
   bagian awal yang disimpan sehingga limitations dan kesimpulan hilang. Teks < 100 karakter dianggap PDF scan
   (tidak ada OCR) dan dilaporkan sebagai error file.
3. `article_prompt()`: instruksi anti-halusinasi, konteks review, teks artikel, dan skema JSON yang diminta.
   Teks PDF diperlakukan sebagai data, bukan instruksi (mitigasi prompt injection).
4. `llm_json()` mengembalikan dict; hasilnya dinormalisasi (`normalise_list`, `safe_string`, batas panjang).
   Kutipan bukti diverifikasi terhadap teks PDF per halaman (`verify_quote`, field `verified`; halaman hasil
   pencocokan menggantikan tebakan AI). `research_design` divalidasi terhadap codebook (`normalise_research_design`):
   kode di luar codebook dibuang, dan basis `stated` diturunkan ke `inferred` bila kutipan buktinya tidak ada di teks.
5. Dibentuk **record artikel** (lihat 5.1). `screening_suggestion.decision` diperiksa ∈ {include, exclude, review}.
6. Opsional: salin PDF/JSON ke `data/` bila saklar `KEEP_SERVER_*` menyala.

Respons: `{articles, errors, model, usage}`. File yang gagal masuk `errors` dan **tidak menghentikan** batch.
Status HTTP: 400 (tanpa file / terlalu banyak), 503 (AI belum dikonfigurasi), 413 (total unggahan terlalu besar).

### 4.2a Matriks ekstraksi, peta topik, peta literatur, system map (SLR lanjutan)

Peta fitur (tab 04 dan 05 sampai 10). Kolom "AI?" menunjukkan apakah ada panggilan model; semua yang bertanda tidak dihitung murni oleh kode.

| Tab | Sumber data | AI? | Fungsi kunci di `app.js` |
|---|---|---|---|
| 04 Diagram Taksonomi | `POST /api/design-taxonomy` (hasil yang sama dengan tab 03) | tidak | `dg*`, `dgRefs`, `fmtRefs` (bagian 4.9) |
| 05 PRISMA Flow | hitungan dari keputusan manual + `identifiedTotal`/`duplicateCount` | tidak | `renderPrisma` |
| 06 Review Synthesis | `POST /api/synthesize` (batch, reduce, final 2 panggilan, cek cakupan, per tema); `POST /api/synthesis-pdf` | ya | `renderSynthesis`, `downloadSynthesisPdf` |
| 07 Matriks Ekstraksi | `authors`, `year`, `research_design.techniques` (+ `state.norm.approved`), `methods`, `context`, `findings` per artikel | tidak | `renderMatrix`, `mxRows`, `mxTechMap`, `mxDownload`, `xlsxBlob` |
| 08 Peta Topik | `state.synthesis.taxonomy` dari `run_taxonomy`; poly dan pemeriksaan diturunkan kode | ya (satu panggilan) | `renderTaxonomy`, `topicTreeSvg`, `polyDiagram`, `derivePolyhierarchy`, `taxonomyChecks`, `retryTaxonomy` |
| 09 Peta Literatur (tab Co-occurrence / Co-authorship / Citation) | co-occurrence: `topic_tags` + nama `concepts`; co-authorship: `authors` | tidak | `setLitTab`, `renderCooccurrence`, `ccBuild`, `ccCanon`, `renderCoauthor`, `caBuild`, `caParse` |
| 10 System Map | `relationships` (+ opsional `concepts.parent_concepts`) per artikel | tidak | `renderSystemMap`, `smBuild`, `SM_ROLE` |

Tab 07, 09, dan 10 **tidak membutuhkan sintesis**: cukup artikel hasil ekstraksi (artikel INCLUDE di kedua tahap; bila belum ada, semua artikel yang
ekstraksinya berhasil, lewat `ccDocs`). Karena itu keduanya tetap muncul walaupun sintesis gagal atau belum dijalankan.

**Matriks ekstraksi, Peta Literatur, dan unduhan PNG (19 Nov 2026).**
- **Matriks Ekstraksi** (tab 07, `extraction-matrix`) memenuhi tahap 3 tugas metlit: kolom Author, Method, Object, Findings. Dibangun kode, tanpa AI.
  Author = "Han et al. (2026)" (1 penulis: nama; 2: "A & B"; 3+: "et al.") + judul; Method = label teknik (nama baku dari `state.norm.approved.items`,
  teknik berstatus `__drop__` dibuang, teknik yang belum terpetakan tampil mentah) + teks `methods`; Object = `context` (cadangan `objective`);
  Findings = `findings[]`. Teks > 170 karakter dipotong (`MX_CLAMP`) dan bisa dibuka per sel ("selengkapnya") atau semua sekaligus. Cakupan = `ccDocs`
  (sama dengan peta literatur). Kolom "No" = nomor baris, BUKAN nomor jurnal Desain Riset. Ekspor memuat teks lengkap + kolom tambahan (Tahun, Judul,
  DOI, Penulis lengkap): CSV (UTF-8 BOM, koma) dan XLSX tanpa pustaka (`zipStore` = ZIP tanpa kompresi, `xlsxBlob` = sheet inline-string, header
  dibekukan, filter otomatis). Excel berbahasa Indonesia sering memakai titik koma sebagai pemisah CSV, jadi untuk Excel gunakan tombol XLSX.
  Jangan rancukan dengan tab "05 / Matrices" di Peta Topik (klasifikasi silang lain).
- **Peta Literatur** (`literature-map`, sebelumnya `cooccurrence`) berisi tiga tab dalam halaman: Co-occurrence, Co-authorship, Citation graph (lihat di bawah). Kelas tab `.lm-tab` (SENGAJA bukan `.taxonomy-tab`, karena pendengar
  `.taxonomy-tab` mengatur Peta Topik). Id elemen co-occurrence tidak berubah.
- **Co-authorship** (`caBuild`): simpul = penulis, garis = jumlah artikel bersama; memakai `netLayout`/`netView`/`netCommunities` yang sama. Nama
  dinormalisasi `caParse` (huruf besar/kecil, aksen, "Belakang, Depan", "Han J", akhiran Jr/II): kunci = belakang|nama depan; nama berinisial ("J. Han")
  digabung ke nama lengkap HANYA bila tepat satu kandidat di korpus, bila ambigu dibiarkan terpisah. Penulis ganda dalam satu artikel dihitung sekali.
  Penulis yang sama di beberapa artikel otomatis menghubungkan kelompok-kelompoknya. Pada korpus nyata (17 artikel) belum ada penulis berulang, jadi
  jaringannya 17 kelompok terpisah; ada catatan di atas peta untuk itu. Batas tampilan `#coauthor-max` (default 120).
- **Citation graph** (`renderCitation`, `ciBuild`; tab ke-3 Peta Literatur): dihitung kode dari `record.references`, tanpa AI. Pembacaan dapus ada di
  `app.py`: `split_references` → `split_reference_entries` (gaya author-year Elsevier/APA, bernomor `[n]`, dan `1.`; baris yang terpotong digabung, DOI yang
  terpotong di akhir baris disambung, kepala/kaki halaman berulang dibuang lewat `running_lines`) → `parse_reference_entry` (DOI, tahun, penulis, judul).
  Tiga tampilan (`#cite-view`): (1) **Bibliographic coupling** (utama, gaya VOSviewer): simpul = artikel, garis = jumlah rujukan yang sama, ukuran lingkaran =
  jumlah rujukan terbaca; (2) **Sitasi langsung**: panah A→B bila daftar pustaka A memuat DOI B (`doi_detected`||`doi`) atau judul B (cocok sebagai substring
  setelah normalisasi huruf/angka); artikel yang terbit berdekatan jarang saling mengutip, jadi graf ini bisa nyaris kosong; (3) **Rujukan bersama**: daftar
  karya yang dikutip ≥2 artikel (tanpa gambar, jadi tombol PNG disembunyikan lewat `syncLitDownload`). Pencocokan rujukan antar artikel memakai DUA kunci per
  rujukan (penulis+tahun+judul, dan DOI bila ada) yang disatukan union-find, sehingga rujukan yang hanya punya DOI di satu artikel tetap cocok dengan
  versi tanpa DOI di artikel lain. Keterbatasan yang dijelaskan di UI: dapus tanpa DOI atau berformat berbeda bisa terlewat, jadi hasilnya batas bawah. Pada tiga PDF
  Elsevier yang diuji, hanya satu yang punya DOI di sebagian entri (38%), dua lainnya tanpa DOI sama sekali; pencocokan penulis+tahun+judul yang menyelamatkannya.
  Artikel yang `references`-nya kosong (dianalisis sebelum v7) dikecualikan dari coupling dan dilaporkan di catatan; unggah ulang PDF-nya untuk mengisi.
  Data per rujukan ~400 byte; ada di localStorage proyek dan ikut ekspor/impor JSON dan HTML.
- **Mode formal untuk Peta Literatur**: tiga peta (kelas SVG `lit-svg`) memakai latar putih TETAP BERWARNA, bukan abu-abu: `LIT_PAL` (palet gelap) dipetakan ke
  `LIT_FORMAL_PAL` (versi lebih pekat) oleh `LIT_FORMAL_MAP`. Tampilan layar memakai aturan CSS yang disuntikkan dari peta yang sama (`body.formal .lit-svg [fill=…]`),
  unduhan PNG memakai `formalizeLit`; kedua jalur memakai satu peta sehingga hasilnya sama. Warna ke-8 palet SENGAJA `#ececec`, bukan `#e8e8e8` (warna teks), supaya
  bisa dipetakan terpisah. Chip legenda diwarnai lewat atribut `data-c`. Diagram lain (taksonomi, system map) tetap abu-abu lewat `filter:invert(1) grayscale(1)`.
- **Unduh PNG Peta Topik**: tombol `#taxonomy-download` di judul halaman Peta Topik, tampil hanya di tab Hierarchical (wadah `#topic-tree-canvas`) dan Poly-hierarchical (`#poly-canvas`); memakai `downloadNetPng` yang sama dengan peta lain (mode formal = abu-abu seperti tampilan layar). Tab Faceted, List, dan Matrices tidak punya PNG.
- **Footer**: keterangan "Workspace pribadi · Data proyek tersimpan di browser ini" dan titik pink berkedip (`.private-dot`) ada di footer halaman (`.app-footer`,
  `#footer-note`), bukan lagi kartu di sidebar; mode ekspor hanya-baca mengganti teks `#footer-note`.
- **Semua ekspor gambar kini PNG** (`svgToPng`: canvas, skala maks 2, sisi terpanjang maks 8000 px; `downloadNetPng` menyalin SVG, menghapus sorotan, lalu
  mengikuti Mode formal lewat `formalizeSvg`). Tombol dan fungsi unduh SVG dihapus (`dg-svg`, `downloadSvg`). Satu tombol `#litmap-download` mengunduh
  tab Peta Literatur yang aktif.


- **Taksonomi** dibuat `run_taxonomy` (satu panggilan AI, dipakai `/api/synthesize` dan `POST /api/taxonomy`). `llm_json(..., salvage=True)`
  menyelamatkan JSON yang terpotong lewat `repair_truncated_json` (tutup string/array/objek, atau potong ke koma/penutup valid terakhir)
  tanpa panggilan ulang; hasilnya `taxonomy_status = "partial"` + `taxonomy_note`. Status lain: `ok`, `fallback`, `failed`.
  Tombol "Buat ulang peta topik" (`#taxonomy-retry`, `retryTaxonomy`) memanggil `/api/taxonomy` supaya kegagalan taksonomi tidak
  memaksa seluruh sintesis diulang. Tes: `tests/test_json_repair.py`.
- **Poly-hierarchy**: prompt taksonomi melarang artikel yang sama di dua kategori sejajar (aturan 3) dan menyuruh array kosong bila tak ada bukti (aturan 8),
  sehingga `polyhierarchy` dari AI hampir selalu kosong. Bila kosong, UI memakai `derivePolyhierarchy`: konsep irisan = pasangan subkategori dari dua cabang
  berbeda yang berbagi >= 2 artikel (induk = kedua subkategori; maks 12). Dihitung kode, diberi catatan di UI, tidak mengubah data tersimpan.
- **Pemeriksaan taksonomi** (`taxonomyChecks`, kotak "Perlu dicek" per tab; dihitung kode, bukan AI): (1) kategori yang namanya memuat kata cara-riset
  (validasi/benchmark/eksperimen/...) = petunjuk bahwa itu bukan topik; (2) dimensi faceted yang tidak mencakup semua artikel; (3) baris matrix yang hanya
  mengutip sebagian artikel dari kategori padanannya (dicocokkan lewat nama).
- **Co-occurrence** tidak lagi bergantung pada sintesis: istilah dari `topic_tags` + nama `concepts`, digabung oleh `ccCanon` (huruf besar/kecil,
  tanda hubung, ejaan optimise/optimize, akhiran framework/approach, jamak, singkatan dalam kurung). Istilah yang muncul di >=60% artikel
  disembunyikan secara default (checkbox `#cooccurrence-dominant`) karena membentuk jaringan bintang. Warna = klaster (`netCommunities`).
- **System map** dibangun kode dari `relationships` (+ opsional `concepts.parent_concepts`) tiap artikel; entitas digabung `ccCanon`.
  Peran simpul bersifat struktural (asal / perantara / tujuan hubungan), bukan klaim AI. Klik simpul/panah menampilkan kutipan bukti.
- **Mesin jaringan**: `netLayout` (force-directed deterministik + tumbukan kotak; tiap komponen terhubung ditata sendiri lalu disusun berbaris),
  `netView` (SVG, hover/klik/seret, unduhan memakai warna literal), `scopeRefs`/`fmtRefs` (nomor jurnal sama dengan tab Desain Riset).
  `system_map` sudah dihapus dari prompt sintesis akhir (UI memakainya tidak lagi). Anggaran token sintesis akhir dinaikkan 1700 -> 2600 karena JSON-nya
  terpotong dan bagian ekor (`limitations_of_corpus`, `review_notes`) hilang saat "diperbaiki".

### 4.2b Ekspor proyek (JSON atau HTML)

Tombol **Ekspor proyek** membuka menu: **JSON** (backup, bisa diimpor ulang; `exportProject`) atau **HTML** (`exportProjectHtml`).
Tombol "Ekspor laporan (HTML)" di tab Taksonomi Desain Riset (`buildDesignReport`, versi naskah/audit) tetap ada dan tidak berubah.

- **Cara kerja ekspor HTML**: klien mengirim `{state, design:{article_ids, topic, normalization}}` ke `POST /api/export-html`. Server
  (`build_project_html`) merakit satu berkas dari `templates/index.html` + `static/style.css` + `static/app.js` (di-inline; `@import` font web dibuang;
  `</script` di-escape), menanam `window.__SLR_VIEWER__ = {state, design, codebook, generated_at, topic}` (`json_for_script` meng-escape `< > &`),
  dan memasang CSP (`connect-src 'none'`). `design` = hasil `build_design_taxonomy` untuk cakupan yang sama dengan layar; `codebook` = `codebook_payload()`.
- **Mode viewer** (`const VIEWER` di app.js): `loadState` membaca payload, `saveState` tidak menulis apa pun, `api()` dijawab `viewerApi`
  (hanya `/api/design-taxonomy` dan `/api/codebook` dari payload; selain itu error), `checkHealth` dilewati, tab Arah Riset TMI tidak ikut.
  `initViewer` mengunci formulir, memasang spanduk, dan memblokir klik/ubah pada pengubah data di fase capture. CSS `body.is-viewer ...` menyembunyikan
  unggah PDF, jalankan sintesis, hapus artikel, normalisasi, pemakaian token, dan donasi. Select keputusan dan checkbox verifikasi dirender `disabled`.
- **Tetap hidup di viewer**: semua tab, pencarian/filter artikel, kontrol Peta Literatur (minimum, istilah dominan, atur ulang; tab Co-authorship), pencarian dan buka-tutup teks Matriks Ekstraksi, unduh CSV/Excel matriks, System Map (maksimum,
  kelompok terbesar, hierarki), Diagram Taksonomi (pohon/sunburst, nomor jurnal, mode formal), unduh PNG, dan **Unduh data (JSON)**.
- **Batas**: potret data saat ekspor (ekspor ulang bila data berubah); font Inter/Poppins tidak ikut (memakai font sistem); avatar kredit sidebar dibuang
  (teks kredit tetap); berkas memuat seluruh data ekstraksi artikel seperti JSON, jadi perlakukan sama saat dibagikan.
- **Tes**: `tests/test_export_html.py` (rute + kerapian HTML + payload), `tests/viewer_smoke.js` (menjalankan berkas hasil ekspor dengan DOM tiruan
  `tests/dom_shim.js`, semua tab dan kontrol), `tests/live_export_smoke.js` (menu dan payload di aplikasi biasa). Semuanya bukan pengganti mencoba di browser.

### 4.2 Sintesis (`POST /api/synthesize`)

Body JSON: `articles` (seluruh array state), `research_question`, `inclusion`, `exclusion`, `job_id`.
Server **menyaring sendiri**: hanya artikel dengan `screening_decision == "include"` **dan**
`eligibility_decision == "include"`. Kosong → 400; lebih dari 250 → 400.

Pipeline (semua panggilan lewat `llm_json`; jumlah langkah dihitung di awal untuk persen progres: `batch + reduce + 4`, lalu
`progress.total_steps` ditambah jumlah tema setelah tema diketahui):

0. **Alias ID pendek.** ID artikel asli (16 heksa) memakan banyak token output, jadi model hanya melihat `A1..An`
   (`compact_p`, urutan = urutan artikel INCLUDE; `real_of` memetakan balik, `label_of` memberi label baca `NamaBelakang et al. Tahun`).
   Semua hasil dikembalikan lewat `_unalias(obj, real_of, label_of)` sebelum disimpan: `article_ids`/`article_id` jadi ID asli (alias
   asing dibuang) dan alias yang ditulis model **di dalam teks naratif** (mis. "(A12, A40)") diganti label penulis-tahun. Prompt
   final/tema meminta rujukan inline berbentuk ID dalam kurung itu. Tes memastikan ID asli tidak pernah muncul di prompt.
1. **Batch**: artikel dipadatkan (`compact_article`, potong tiap field) lalu dibagi per `SYNTH_BATCH_SIZE` (bawaan 8 untuk DeepSeek).
   Tiap batch → `batch_synthesis_prompt` → ringkasan (`batch_overview`, **`gaps` lebih dulu**, themes, agreements, contradictions,
   taxonomy_seeds, system_relationships). Prompt membatasi jumlah item dan panjang kalimat agar JSON selesai sebelum plafon.
   `max_output_tokens=3200` (1800 bila batch ≤ 6) × `LLM_OUTPUT_SCALE`, `salvage=True`.
2. **Reduce** (hanya bila ringkasan > `REDUCE_GROUP_SIZE`, bawaan 12): gabung per grup berulang-ulang sampai muat satu
   panggilan akhir. Grup berisi 1 ringkasan dilewatkan tanpa AI (`count_reduce_calls` meniru logika ini). Penggabungan membuang detail,
   jadi `REDUCE_GROUP_SIZE` sengaja lebih besar dari jumlah batch tipikal (69 artikel = 9 batch = tanpa reduce).
3. **Final dua panggilan** (dipecah karena satu JSON besar terpotong persis di bagian akhir, yaitu `research_gaps`):
   - 1/2 `final_synthesis_prompt`: `research_question_refinement`, `subquestions`, `executive_synthesis`, `main_themes`.
   - 2/2 `gaps_synthesis_prompt`: `research_gaps` (6-10) lebih dulu, lalu `agreements`, `contradictions`, `limitations_of_corpus`,
     `review_notes`. Menerima `gap_digest` = `future_research` + `limitations` tiap artikel (dipotong) sebagai dasar gap. Dicoba ulang
     sekali bila `research_gaps` kosong; bila tetap kosong, `review_notes` diberi catatan eksplisit (tidak gagal diam-diam).
   Keduanya `max_output_tokens=3600`, `salvage=True`.
4. **Cek cakupan** (`coverage_prompt`): `_cited_aliases` menghitung artikel yang dikutip di tema/kesepakatan/kontradiksi/gap. Yang belum
   terkutip ditempatkan ke tema yang ada (`assignments`, dicatat di `theme.coverage_notes`) atau dikelompokkan jadi tema baru
   (`new_themes`). Dilewati bila semua sudah terkutip. Sisa yang masih terlewat dicatat di `review_notes`. Kegagalan langkah ini tidak
   membatalkan sintesis.
5. **Sintesis mendalam per tema** (`theme_deep_prompt`, satu panggilan per tema, `max_output_tokens=3000`): membaca temuan, metode, dan
   keterbatasan artikel pendukung tema itu langsung (`_theme_article_slim`: temuan maks 5 × 230 karakter, metode 300), **bukan** dari ringkasan
   batch. Mengisi `deep_synthesis`, `key_findings[{finding, article_ids}]`, `methodological_patterns`, `evidence_strength`,
   `open_questions` pada tema. Gagal pada satu tema hanya dicatat di log; tema tetap tampil dengan `synthesis` ringkasnya.
6. **Taksonomi topik terpisah** (`taxonomy_only_prompt`, dengan `taxonomy_catalog` yang memuat metode, konsep, dan
   ringkasan desain; hierarki 3 level dengan satu prinsip pengelompokan per level; hasil dirapikan oleh
   `finalize_hierarchy`: perbaikan id/parent/siklus, roll-up `article_ids`, dan `taxonomy_coverage`). Berjalan setelah alias
   dikembalikan ke ID asli. Panggilan sendiri supaya taksonomi tidak berebut batas token dengan sintesis. Hasilnya `taxonomy_status` ∈
   `ok` | `partial` | `fallback` | `failed` (rincian di 4.2a). Kegagalan taksonomi tidak membatalkan sintesis.
7. `filter_references()` membuang `article_ids` yang tidak ada di korpus (mencegah AI mengarang rujukan).
   `parent_ids` taksonomi dicek di frontend.

Pelajaran yang mendorong desain ini (uji nyata 69 artikel): batch 12 artikel dengan plafon ±2.6k token **selalu terpotong**; panggilan
"perbaiki JSON" hanya merapikan teks yang sudah terpotong, jadi bagian ekor (`gaps`, `limitations_of_corpus`, `review_notes`) hilang tanpa
suara. Sintesis yang murah sekali (< Rp800) adalah gejala itu, bukan penghematan. Setelah perbaikan: tanpa potongan, 69/69 artikel
terkutip, 8 tema dengan sintesis mendalam, sekitar 20 panggilan dan < Rp1.000 dengan `deepseek-flash`. Cara memeriksa run sintesis:
tidak ada baris "output terpotong" di log, `research_gaps` terisi, dan jumlah artikel terkutip = jumlah INCLUDE.

Respons: `{synthesis, usage}`. Kegagalan → `{error, usage}` dengan 502.

### 4.2c Unduh PDF Review Synthesis (`POST /api/synthesis-pdf`)

Modul `synthesis_pdf.py` (PyMuPDF `Story`, tanpa dependensi baru, **tanpa AI dan tanpa biaya**). Tombol `#download-synthesis-pdf`
(di `.title-actions` halaman Review Synthesis; `hidden` selama `state.synthesis` kosong dan di mode `VIEWER`) memanggil `downloadSynthesisPdf`:
klien mengirim `{synthesis (tanpa taxonomy), articles (id,title,year,authors,doi untuk artikel di evidence_catalog), meta}` lalu menyimpan blob
`review-synthesis-<tanggal>.pdf`.

- `build_html(synthesis, articles, meta)`: merakit HTML+CSS. Semua teks lewat `_t`/`_e` (di-escape; karakter di luar font bawaan seperti ≈ → ≤ diganti ASCII
  lewat `_SUBS`). Label rujukan dari `_label`/`_build_labels` (`NamaBelakang et al. Tahun`, kembar → akhiran a/b), sama dengan `_alias_label` di `app.py`.
- `build_pdf(synthesis, articles, meta)`: A4, margin 56/66/56/62, `Story.write` dengan `positionfn` mengumpulkan heading untuk **bookmark**
  (`doc.set_toc`, level dirapikan agar tidak melompat). Lewat kedua: header "Review Synthesis" (mulai halaman 2), footer dan "Halaman n / N" (butuh total halaman, jadi
  dipasang setelah dokumen jadi). Sintesis tanpa `executive_synthesis` dan `main_themes` → `ValueError` → rute membalas 400 `{error}`; galat lain → 500.
- Isi: judul + metadata, sintesis eksekutif, tema utama (deskripsi, `deep_synthesis`, `key_findings` bersitasi, pola metode, kekuatan bukti, pertanyaan terbuka, sumber),
  konsistensi, kontradiksi, research gaps, limitasi, catatan verifikasi, daftar artikel rujukan (urut abjad label). Hanya teks; diagram taksonomi tidak ikut.
- Batasan `Story` yang sudah dicoba: `page-break-inside: avoid` **tidak berpengaruh**; `background-color` pada `.note` bocor sebagai pita tipis di
  atas heading halaman lain (jadi `.note` hanya memakai `border-left`); judul bisa terpisah dari isi di dasar halaman (label GAP digabung ke `<h3>` agar tidak yatim).
- Tes: `tests/test_synthesis_pdf.py` (18 pengecekan).

### 4.3 Progres (`GET /api/analysis-progress`, `GET /api/synthesis-progress`)

Query `job_id` (dibuat frontend via `crypto.randomUUID`). Kelas `Progress` (thread-safe, dengan lock) menyimpan:
`percent` (monoton, maks 99 sampai `finish()`), `stage`, `current/total`, `filename`, `indeterminate`
(true hanya saat menunggu byte pertama dari AI), `elapsed`, `logs` (maks 150), `usage` (objek yang sama yang
dimutasi `add_usage`, sehingga biaya live). Registry `PROGRESS_JOBS` di memori, kunci `"{kind}:{job_id}"`,
dibersihkan bila > 1 jam atau > 40 job. Job yang belum terdaftar → `{"pending": true}` (frontend menahan
teks awal). **Persen = (langkah selesai + pecahan langkah berjalan) / total langkah.** Pecahan langkah berjalan
berasal dari jumlah token yang sudah di-stream terhadap ≈ setengah plafon, dibatasi per fase, jadi tidak pernah
melompat ke 100% sebelum panggilan selesai.

Baris log bertanda `live: true` adalah baris yang terus diganti selama AI menulis; `finish_live()` menggantinya
dengan baris final (token masuk/keluar, cache, detik, biaya). Retry dicatat sebagai peringatan.

### 4.4 Route lain

| Route | Auth | Fungsi |
|---|---|---|
| `GET /` | ya | Landing page (`landing.html`). |
| `GET /app` | ya | Workspace (`index.html`). Tombol di landing mengarah ke sini; `/app#<id-tab>` membuka tab langsung. |
| `GET /api/health` | ya | Status AI + limits (`max_files_per_batch`, `max_file_mb`, `max_text_chars`, `synth_batch_size`, `keep_server_*`) + `pricing` (periode, waktu pergantian, tarif efektif; `null` untuk Ollama). |
| `POST /api/taxonomy` | ya | Buat ulang HANYA peta topik (satu panggilan AI) dari artikel INCLUDE + `main_themes` yang sudah ada. Body: `articles`, `main_themes`, `research_question`. Dipakai tombol "Buat ulang peta topik". Respons: `{taxonomy, taxonomy_coverage, taxonomy_status, taxonomy_note?, usage}`; gagal total → 502 `{error, usage}`. |
| `POST /api/synthesis-pdf` | ya | Susun hasil Review Synthesis jadi PDF A4 (bagian 4.2c). Body: `{synthesis, articles[], meta{research_question, source_name, search_date}}`. Respons: `application/pdf` dengan `Content-Disposition: attachment`, tanpa cache. Sintesis kosong atau body bukan JSON → 400 `{error}`; galat penyusunan → 500. Tanpa AI. |
| `POST /api/export-html` | ya | Merakit ekspor proyek HTML hanya-baca (bagian 4.2b). Body: `{state, design:{article_ids, topic, normalization}}`. Respons: `text/html` (tanpa cache). `state` tanpa daftar `articles` → 400. |
| `GET /api/test-ai` | ya | Satu panggilan kecil non-streaming untuk uji koneksi/JSON; mengembalikan `usage`. |
| `GET`/`POST /signup` | tidak | Hanya mode terkelola (`user_auth.py`). GET menampilkan form; POST mendaftar dan menulis `USER_API_KEY` ke `.env`. Bila sudah terdaftar atau mode mati, dialihkan ke `/app`. Gerbang `_gate` mengalihkan jalur lain ke sini selama key kosong (bagian 9.1). |

`auth_guard` memakai HTTP Basic Auth bila `APP_PASSWORD` terisi (perbandingan string biasa, bukan constant-time;
cukup untuk prototype di atas HTTPS).

### 4.5 Taksonomi desain riset (research onion)

`RESEARCH_ONION` di `app.py` adalah codebook (Saunders dkk., 2019): philosophy, approach, methodological_choice,
strategy, time_horizon, data_source, analysis. Satu sumber kebenaran untuk prompt ekstraksi, validasi, dan taksonomi.
Analisis v5: `EVIDENCE_TERMS` + `apply_evidence_gates()` membuang `data_source.synthetic_simulated` bila AI melampirkan kutipan yang
tidak memuat istilah relevan (synthetic/simulat/generat/dst.). Kutipan yang ADA di PDF belum tentu mendukung label; tanpa
kutipan, label tetap diterima sebagai `inferred`. Dasar: artikel PM2.5 (data publik nyata) keliru berlabel sintetis lewat kutipan
\"sample average approximation\"; keempat label sintetis yang benar lolos. Prompt juga menegaskan bahwa diskretisasi skenario/SAA
bukan data sintetis.

Analisis v4: (a) `SELF_REFERENCE_RULES` memulihkan `case_study` yang terlewat AI bila penulis menulis kalimat orang pertama
(\"we present a ... case study\", sengaja sempit; kalimat pustaka dan judul bagian tidak cocok). Item hasilnya `source: \"rule\"`,
`stated` dengan kutipan terverifikasi, dan dicatat di `warnings`. Kode strategi lain belum diberi aturan (\"we survey the
literature\" bukan survei kuesioner; tambahkan hanya bila ada kasus terlewat yang teramati). (b) Lencana UI: \"dinyatakan ✓\"
hanya untuk label eksplisit (`/api/codebook` -> `explicit_terms`); label lain yang `stated` tampil \"didukung kutipan ✓\"
karena kode hanya memastikan kutipan ada di PDF. (c) `time_horizon: not_applicable` tidak membawa evidence (ketiadaan tidak
bisa dikutip; kutipan AI biasanya soal horizon perencanaan model).

Codebook v3 (dari audit 5 artikel contoh): (a) field multi-nilai (`strategy`, `data_source`, `analysis`) memakai basis dan bukti
PER NILAI (`items[]`), karena satu kutipan tidak boleh "menyatakan" dua label; (b) label di `EXPLICIT_TERMS` (semua `philosophy`,
serta strategi survey/case_study/ethnography/grounded_theory/narrative_inquiry/action_research) hanya diterima bila `stated`
dengan kutipan terverifikasi yang MEMUAT istilahnya, selain itu dibuang dengan peringatan (bukan sekadar `inferred`);
(c) `time_horizon` dijawab berurutan: deret waktu historis eksplisit = longitudinal, satu waktu = cross_sectional, selain itu
not_applicable. Pada v2: `time_horizon` baku untuk studi pemodelan/optimasi/simulasi adalah `not_applicable` (longitudinal hanya bila
artikel eksplisit menganalisis deret waktu historis); prompt menegaskan bahwa "rolling/planning/total horizon" adalah
horizon perencanaan model, bukan time horizon penelitian. Kode bertanda `[ekstensi]` (mis. `experiment_modeling_simulation`, `synthetic_simulated`) bukan dari Saunders; ditambahkan
agar cocok dengan riset pemodelan. Ubah `CODEBOOK_VERSION` bila arti kode berubah.

Prinsip: AI hanya **mengklasifikasikan satu artikel ke kode codebook** (dengan `basis` stated/inferred/not_stated dan
bukti). Pohon **dihitung kode** oleh `build_design_taxonomy` (group-by), tanpa LLM: `POST /api/design-taxonomy`,
tab Taksonomi Desain Riset (label sidebar; id `design`). Cabang: Metodologi (Kuantitatif/Kualitatif/Campuran lalu teknik), Strategi, Teknik & prosedur,
Fondasi & horizon waktu; plus matriks Metodologi x Strategi (sel kosong = kandidat gap) dan ringkasan
stated/inferred/not_stated. `GET /api/codebook` memberi label untuk UI.

`ANALYSIS_VERSION` (app.py, juga dikirim lewat `/api/codebook`) adalah versi format analisis per artikel; naikkan bila skema atau aturan
ekstraksi berubah. Artikel dengan versi lebih rendah tidak dianggap duplikat: boleh diunggah ulang, hasil baru menggantikan yang
lama dan keputusan screening/eligibility dipertahankan. Hanya artikel dengan versi terbaru yang dilewati sebagai duplikat.

### 4.6 Normalisasi teknik (tahap 3)

Daftar teknik hasil ekstraksi (`research_design.techniques`) masih mentah: sinonim terpisah, kadang berisi istilah yang bukan
teknik. Tahap ini memberi satu kosakata baku dan keluarga metode, yang menjadi kotak di bawah cabang Kuantitatif/Kualitatif
pada pohon desain riset.

Prinsip: **AI hanya mengusulkan, pengguna menyetujui, kode menerapkan secara deterministik.**
- `collect_techniques()` menggabungkan nama yang hanya beda huruf besar/kecil dan tanda baca (tanpa AI).
- `POST /api/normalize-techniques` (satu panggilan AI pendek per `NORM_CHUNK` nama, default 150; chunk berikutnya menerima
  keluarga dari chunk sebelumnya sebagai konteks) mengusulkan `merges` (sinonim persis), `drops` (bukan teknik: topik,
  dataset, metrik, komponen model), `families` (4-8, satu prinsip), `assign`. Mengembalikan `usage`, juga saat gagal.
- `finalize_normalization()` merapikan usulan dan MENJAMIN setiap nama masukan berakhir tepat sekali (dibuang, varian dari
  nama baku, atau nama baku sendiri). Nama karangan diabaikan, id keluarga tidak valid menjadi \"belum dikelompokkan\",
  keluarga duplikat nama menyatu, drop menang atas merge, dan pemetaan yang sudah ada tidak diubah. Ia TIDAK bisa menilai
  kebenaran semantik sebuah penggabungan; itu tugas pengguna lewat tombol × (pisahkan varian) di editor.
- State browser: `state.norm = {draft, approved}`. Pohon hanya memakai `approved` (dikirim ke `/api/design-taxonomy` sebagai
  `normalization`); `draft` adalah usulan/hasil edit yang belum disetujui. Ikut ekspor proyek; unduhan JSON taksonomi memuat
  `normalization`.
- Inkremental (diperbarui 3 Nov 2026): "Perbarui untuk teknik baru" mempertahankan keluarga dan item lama, memproses hanya teknik
  yang tidak ada di pemetaan (termasuk item "belum dikelompokkan"), dan MENEMPELKAN nama baru ke item lama alih-alih membuat item
  duplikat. Urutannya: (1) `consolidate_normalization()` menggabung duplikat yang sudah ada di pemetaan (kunci nama sama; hanya bila
  keluarga sama; duplikat lintas keluarga hanya dilaporkan di `review`); (2) `auto_attach()` menempelkan nama baru yang jelas sama
  tanpa AI (`_merge_key`: singkatan kurung dan kata generik di ujung diabaikan); (3) AI hanya untuk sisanya, dengan daftar NAMA BAKU
  YANG SUDAH ADA di prompt dan field `attach` (nama baru -> nama baku lama); (4) `refresh_item_counts()` menghitung ulang artikel dan
  ejaan pada item lama. Hasil melaporkan `attached`, `merged_existing`, `review`; item yang tersentuh membawa `touched` (UI: "+N varian baru").
- `_tech_key()` mengabaikan singkatan di kurung pada ujung nama HANYA bila huruf-hurufnya inisial kata sebelumnya ("random forest (RF)");
  "(RBF)" pada "support vector machine" tidak dibuang. Penjaga varian bermakna (`_MODIFIERS`: weighted, quantile, conformal, robust,
  stochastic, distributionally) berlaku di `finalize_normalization` untuk `merges` dan `attach`: anggota dengan kata pengubah yang
  tidak sama dengan nama baku dikeluarkan menjadi item sendiri. Daftar kata pengubah ini dipilih dari korpus Predict-then-Optimize;
  korpus bidang lain mungkin butuh tambahan.
- Tanpa pemetaan, pohon tetap daftar datar seperti sebelumnya.
- Editor draf bertab (9 Nov 2026): tab Semua / Kuantitatif / Kualitatif / Campuran (+ Tidak dinyatakan bila ada) adalah FILTER tampilan,
  bukan induk keluarga. Satu keluarga tetap satu entitas (nama/definisi berlaku di semua tab); tab hanya menampilkan teknik yang dipakai
  artikel berlabel metode itu (`methodological_choice`, kelompok sama dengan cabang pohon), dan keluarga yang daunnya berasal dari
  beberapa jenis artikel muncul di beberapa tab dengan daunnya masing-masing. Pohon desain riset TIDAK berubah: cabang ditentukan
  artikel, bukan keluarga (satu artikel hanya di satu cabang metodologi). Tiap keluarga menunjukkan sebaran artikelnya, tiap teknik
  menunjukkan label metode artikelnya, dan keluarga yang punya teknik yang hanya dipakai artikel kuantitatif DAN teknik lain yang hanya
  dipakai artikel kualitatif ditandai ⚠ (saran memecah; keputusan tetap di pengguna, label campuran diabaikan sebagai bukti).
  Field `method` pada keluarga (quantitative|qualitative|mixed) HANYA petunjuk tab untuk keluarga yang belum punya teknik berartikel
  (dipilih saat Tambah keluarga); setelah ada daun berartikel diabaikan dan tampilan mengikuti artikel. Backend tidak memvalidasi atau
  memakai `method`. Prompt normalisasi memuat sebaran label metode per teknik (`collect_techniques` -> `methods`, dihitung kode, bukan AI)
  dan aturan: satu keluarga tidak boleh mencampur teknik kuantitatif-saja dengan kualitatif-saja, pecah jadi dua keluarga bernama
  berbeda. Itu saran ke AI, bukan jaminan: karena itu ada penanda ⚠ di editor. Efek aturan ini pada kualitas usulan belum diuji di
  korpus nyata. Pemetaan lama tidak berubah sendiri ("Perbarui" mempertahankan keluarga lama); penanda ⚠ tetap bekerja untuknya.

Audit pertama pada korpus nyata (17 artikel INCLUDE, 109 nama teknik): usulan AI umumnya baik (sebagian besar penggabungan benar,
keluarga koheren), tetapi ada kesalahan material yang kini ditangani lewat prompt dan editor: (a) AI membuang 9 nama arsitektur
model prediksi (TCN, DCRNN, TGCN, ASTGCN, Transformer decoder-only, KAN, dst.) sebagai \"bukan teknik\" sementara arsitektur sejenis
(LSTM, Transformer) dipertahankan; (b) perangkat lunak/solver (Gurobi, CPLEX) dikelompokkan sebagai teknik; (c) beberapa
penggabungan menyatukan varian metodologis (quantile/XGB-CQR ke XGBoost, robust/stochastic MPC ke MPC, weighted SAA ke SAA);
(d) satu keluarga \"Evaluasi dan validasi\" menampung teknik yang tidak cocok (K-means, reduced error pruning). Editor sekarang
membuka bagian \"Dibuang\" secara otomatis dengan peringatan; keputusan akhir tetap di pengguna. Dua item yang tidak diberi
keluarga tetap tampil di \"Belum dikelompokkan\". Dua item beranama baku identik di keluarga yang SAMA digabung oleh pohon
(cara kerja untuk penggabungan manual); di keluarga berbeda tampil terpisah.

`ANALYSIS_VERSION` 7: daftar pustaka diurai kode saat PDF dibaca (`references`, `doi_detected`) untuk citation graph; PDF lama perlu diunggah ulang untuk mengisinya.
`ANALYSIS_VERSION` 6: prompt ekstraksi meminta nama metode saja (tanpa \"classifier\"/\"framework\") dan melarang topik, dataset,
metrik, atau komponen model dimasukkan sebagai teknik.

### 4.7 Laporan HTML (untuk dibaca manusia)

Tombol **Ekspor laporan (HTML)** di tab Desain Riset (`buildDesignReport()` di `app.js`, dibuat sepenuhnya di browser dari hasil
`/api/design-taxonomy` dan pemetaan normalisasi yang DISETUJUI). JSON tetap untuk mesin (cadangan, impor, analisis); HTML untuk
dibaca, dibagikan, dan dicetak ke PDF.

- Satu berkas mandiri: CSS dan skrip kecil inline, tanpa sumber daya luar. Meta CSP (`default-src 'none'`) menutup permintaan jaringan.
- Dua mode dalam SATU berkas (atribut `data-view` pada `<html>`, tombol di bilah atas): NASKAH (acuan menulis, PDF bersih tanpa hal teknis
  tool) dan LENGKAP (audit untuk dicek manusia). Bagian naskah bernomor 1-9: topik dan fokus, metode penyusunan (dibaca dari config
  Ikhtisar dan dihitung dari data: hasil seleksi, sebaran tahun), pohon research onion, definisi konsep (kode hierarkis), matriks
  metodologi x strategi, keluarga teknik + artikel, posisi dalam onion (kalimat otomatis, cabang kosong disebut), temuan dan celah
  (dari Review Synthesis; ID artikel mentah diganti nomor referensi, kode codebook diganti label), daftar pustaka. Lampiran A-F
  (konfigurasi, cara membaca, penggabungan/pembuangan nama, kepercayaan label, label per artikel, status verifikasi) ditandai
  `.audit` dan disembunyikan di mode naskah. Tombol: Pratinjau naskah, Tampilan lengkap, Panduan kerangka, Cetak naskah, Cetak lengkap. Tampilan ketiga (`data-view="panduan"`, bagian `.guide`, menyembunyikan yang lain) berisi panduan kerangka dokumen: peta bab dengan status (salin/tulis ulang/tulis sendiri), pertanyaan pemandu per bab dengan contoh yang dihitung dari data proyek, alur kerja, catatan format ITB (dengan peringatan untuk diverifikasi ke template TMI), daftar periksa, dan F. contoh naskah statis (`exampleHtml`, kasus Predict-then-Optimize: judul-abstrak, Bab I-V, daftar pustaka; Bagian 8 temuan dan celah sengaja dilewati karena milik tahap SLR). `exampleHtml` adalah teks TETAP yang dibuat dari proyek contoh per 5 Nov 2026 (angka, tabel, dan 17 referensi diambil dari data itu, bukan diketik); bila korpus contoh berubah, perbarui manual. `ui_report_check.js` mencocokkan jumlah artikel per keluarga di F dengan laporan hanya jika korpusnya sama. Konteks panduan dipilih lewat `meta.guide_context` (`itb-tmi` bawaan, atau `umum`) di form Ikhtisar; kalimat khas kuliah/ITB (slide, arahan dosen, hardcopy, catatan format juknis ITB) hanya tampil pada `itb-tmi`, sedangkan F sengaja bebas kata TMI/ITB. Kalimat soal filosofi di pertanyaan pemandu bersyarat (hanya "tidak ada artikel yang menyatakan" bila memang semuanya tidak dinyatakan). `.refnote` di mode naskah/lengkap menegaskan bahwa laporan adalah acuan, bukan naskah final.
- Jangan "mencuci" tebakan AI: banner DRAFT (tampil di KEDUA mode) menyebut artikel yang belum diverifikasi, pemetaan teknik yang belum
  disetujui atau masih draf, dan keluarga teknik tanpa definisi. Verifikasi = kotak "Sudah saya cek" di detail artikel
  (`owner_verified`, `owner_verified_at` pada artikel; ikut ekspor/impor proyek). Daftar pustaka membawa catatan bahwa nama jurnal,
  volume, dan halaman belum diekstrak (hanya judul, penulis, tahun, DOI); pelengkapan dari DOI (Crossref) belum dibuat.
- Tema terang/gelap mengikuti sistem;  `@media print` memaksa terang, membuka semua lipatan, dan membedakan
  batang proporsi dengan tingkat abu-abu.
- Keamanan: semua teks dari PDF/AI di-escape; DOI hanya jadi tautan bila cocok pola DOI ketat; data JSON ditanam di
  `<script type=\"application/json\" id=\"slr-data\">` dengan `< > & U+2028 U+2029` di-escape agar tidak bisa menutup elemen.
- Laporan adalah potret data saat dibuat; buat ulang bila data berubah. Draf pemetaan yang belum disetujui TIDAK dipakai
  (dicatat di laporan).
- Belum ada tes browser otomatis di repo; pengujian dilakukan dengan jsdom (termasuk muatan berbahaya di judul/penulis/DOI/teknik/topik)
  dan render PDF (WeasyPrint) untuk memeriksa tata letak cetak. Tampilan di browser sungguhan belum diverifikasi visual.

### 4.8 Arah Riset (langkah 0, khusus TMI ITB)

Untuk orang yang belum punya topik. Pengguna memilih dari kategori yang diturunkan dari tesis TMI terdahulu; hasilnya topik umum, RQ
(penelitian dan untuk SLR), query ScienceDirect/Scopus, serta kriteria inklusi/eksklusi. Hasilnya disalin manual ke Ikhtisar
(sengaja tidak mengisi otomatis; tools pencarian jurnal tetap di luar app ini).

- **Tanpa AI saat runtime, tanpa biaya token.** AI hanya dipakai SEKALI di luar app (ekstraksi facet per tesis dari judul + keyword,
  daftar kategori tertutup), hasilnya dibekukan di `arah_riset_data/thesis_facets.json`. `vocab_en.json` (ditulis tangan) memuat label dan
  istilah pencarian bahasa Inggris per kategori; urutan istilah = prioritas saat query dipangkas.
- **Layer**: kk, masalah, sektor, kelompok_metode, metode, pendekatan. Opsi tiap layer dihitung dari tesis yang cocok dengan pilihan layer
  LAIN. "Belum tahu" melewati layer (tidak masuk query). `Buat hasil` butuh minimal masalah, sektor, metode, atau kelompok metode.
- **Query**: blok Boolean (masalah, sektor, metode, kata kunci tambahan), sinonim digabung OR. `build_query` memangkas istilah
  (dari blok terpanjang) sampai jumlah operator <= `max_ops`: 8 untuk ScienceDirect (batas per kolom; angka ini dari ingatan, VERIFIKASI
  ke situs bila perlu), 20 untuk Scopus. Kutip selalu lurus, tanpa backslash.
- **Celah**: hanya pasangan masalah x sektor yang belum pernah muncul di jurusan, diurutkan menurut perkiraan jumlah jika acak.
  Celah metode sengaja TIDAK disarankan (sering tidak masuk akal, mis. adopsi teknologi x metaheuristik). "Belum ada di jurusan"
  bukan bukti novelty global.
- **Route** (semua `@auth_guard`): `GET /api/arah-riset/meta`, `POST /api/arah-riset/options|examples|generate`. Bila data hilang,
  `ARAH_RISET = None` dan route menjawab 503; sisa app tetap jalan.
- **State browser** di kunci SENDIRI `slr_arah_riset_v1` (pilihan, layer aktif, kata kunci tambahan). Tidak ikut Ekspor/Impor proyek dan
  tidak terhapus oleh "Hapus semua artikel". Jangan digabung ke `litreview_studio_project_v1`.
- **Memperbarui data**: jalankan ulang pipeline ekstraksi (di luar repo ini) dan timpa `thesis_facets.json`. Total tesis di halaman dibaca
  dari data, jadi angkanya ikut berubah. Kategori tertutup (masalah, sektor, kelompok metode) didefinisikan di skrip ekstraksi; bila
  daftar itu diubah, `vocab_en.json` harus ikut diubah supaya setiap kategori punya istilah query.
- Tes: `python tests/test_arah_riset.py` (tanpa jaringan).

### 4.9 Diagram taksonomi dan navigasi hash

Tab **Diagram Taksonomi** (id `design-diagram`) memvisualkan pohon dari `POST /api/design-taxonomy` (hasil yang SAMA dengan tab Taksonomi
Desain Riset: tanpa AI, tanpa biaya token). Kode di `app.js`, blok "Diagram taksonomi desain riset" (awalan `dg`/`DG`).

- Dua bentuk: pohon horizontal (kolom per kedalaman, cabang bisa dibuka/ditutup) dan sunburst (lebar busur = jumlah daun yang tampil).
  Klik simpul = detail (definisi + artikel, nomor rujukan sama dengan tab Desain Riset); klik dua kali atau tombol +/- = buka/tutup.
  Simpul tanpa artikel (jumlah 0 dan tanpa turunan ber-artikel) TIDAK digambar; cabang kosong tetap tampak di tab Taksonomi Desain Riset.
  Cabang kedalaman >= 3 ciut secara bawaan; teknik per keluarga dibatasi 15, sisanya diringkas "+ N teknik lain".
- **Nomor jurnal (opsional)**: tombol "№ Nomor jurnal" (`#dg-refs`, state `DG.refs`, tersimpan di localStorage `slr-dg-refs`) menampilkan nomor rujukan
  (`designRefs`, sama dengan tab Desain Riset) di tiap simpul, sebagai baris abu-abu di bawah nama (pohon) atau di bawah label busur (sunburst,
  maks 2 baris; selengkapnya di tooltip dan panel detail). Pemformat: `dgRefs(n)`; 3 nomor berurutan atau lebih diringkas jadi rentang (`1–3`).
  Akar tidak diberi nomor. Berlaku juga untuk unduhan SVG/PNG. Ukuran simpul/busur dihitung ulang lewat `dgMeasure` dan `_sl`.
- SVG memakai **warna literal** (`DG_BRANCH`, `DG_PAL`), bukan variabel CSS, supaya unduhan SVG/PNG berdiri sendiri. Dua tema: `dark` (layar,
  palet terminal workspace) dan `light` (unduhan, kotak "Latar terang"). Selaraskan manual bila tema workspace berubah.
- Font diagram monospace dan lebar simpul DIPERKIRAKAN dari jumlah karakter (`dgW`, konstanta 7.3 px/karakter untuk 12 px); ganti font
  = sesuaikan konstanta itu (dan `7.2` di sunburst), kalau tidak teks meluap dari kotaknya.
- PNG dibuat dari SVG lewat canvas (maks 8000 px sisi terpanjang, skala <= 2). Font IBM Plex Mono tidak ikut tertanam di unduhan: bila tidak
  terpasang di komputer pembuka, jatuh ke monospace lain.
- **Navigasi hash**: `navigate()` menulis `#<id>` ke URL (`history.replaceState`), dan saat load/`hashchange` halaman dibuka dari hash. Berlaku untuk
  semua tab, mis. `/app#design-diagram` atau `/app#arah-riset`. Tanpa hash, tampilan pertama tetap Ikhtisar.
- **Landing (`/`)** bertema terminal sama dengan workspace dan harus menceritakan seluruh alur (bukan hanya desain riset dan diagram). Bagian utamanya
  adalah **Tur hasil**: carousel 8 slide (ekstraksi dan keputusan, PRISMA, sintesis, peta topik, co-occurrence, system map, diagram taksonomi, ekspor HTML).
  - **Ilustrasi** adalah 8 SVG inline statis berisi data contoh generik (7 digambar baru, sunburst dipakai ulang). Warna mengikuti aplikasi: palet jaringan
    (`NET_PAL`), warna peran system map (`SM_ROLE`), pohon peta topik (`topicTreeSvg`), dan aturan `dgBuild` untuk sunburst. Ilustrasi **TIDAK dihasilkan dari
    kode saat runtime** dan tidak ada generatornya di repo: bila tampilan fitur berubah, gambar ulang manual (edit SVG di `landing.html`) dan perbarui teks slide dan
    legenda warna di slide diagram. Setiap SVG punya `aria-label` yang menjelaskan isinya.
  - **Carousel**: `#tour` > `.tour-track` > N `.slide` (satu `article` per slide) dan N `.tour-dot` di `.tour-nav`. Penggeserannya scroll-snap native CSS (bisa digeser
    tanpa JS); skrip inline kecil di akhir `landing.html` hanya menambah tombol, titik, penghitung, dan keyboard (panah, Home, End), dan menghormati `prefers-reduced-motion`.
    Menambah slide: tambah `article.slide`, tambah `.tour-dot`, ubah teks `1 / N`, dan ubah angka 8 di `tests/test_routes.py`.
  - **Akurasi klaim**: setiap pernyataan di landing harus benar terhadap aplikasi. Contoh yang dijaga: statistik "0 token" hanya untuk co-occurrence, system map, dan diagram
    (sintesis dan peta topik memakai token); co-occurrence bukan VOSviewer; panah system map bukan bukti kausal; ekspor HTML hanya-baca. Angka pada ilustrasi adalah contoh.
  - Tes: `tests/test_routes.py` (8 slide dan 8 titik, tautan navigasi, 8 SVG, tanpa Jinja tersisa) dan `node tests/landing_tour_smoke.js` (logika carousel). Tampilan sungguhan
    (tata letak, responsif, gestur geser di layar sentuh) hanya bisa diperiksa di browser.

## 5. Model data

### 5.1 Record artikel (hasil `/api/analyze`, disimpan di `state.articles`)

`id` (= `hash[:16]`), `hash` (SHA-256 isi PDF), `filename`, `uploaded_at`, `pages`, `text_chars`, `title`, `authors[]`,
`year`, `doi`, `abstract`, `objective`, `research_questions[]`, `methods`, `context`, `variables[]`, `findings[]`,
`limitations[]`, `future_research[]`, `topic_tags[]`, `concepts[{name,description,parent_concepts[]}]`,
`relationships[{source,target,relation,evidence}]`, `evidence_quotes[{claim,quote,page}]`,
`screening_suggestion{decision,reason}`, `screening_decision` (`pending|include|exclude`), `eligibility_decision`
(`pending|include|exclude`), `source_name`, `search_query`, `search_date`, `analysis_version`,
`extraction_status`, `pdf_stored`, `json_stored`.
Tambahan v2 (`analysis_version` 2): `research_design{codebook_version, <field>{value, basis, evidence,
evidence_verified[, items[{code, basis, evidence, evidence_verified}] untuk field multi-nilai]}, techniques[], warnings[]}`, `evidence_quotes[].verified`, `evidence_quality{quotes_total,
quotes_verified}`, `text_chars_original` (termasuk daftar pustaka), `text_chars_body` (isi artikel tanpa daftar pustaka; dasar menghitung bagian
yang dilewati), `text_truncated`, `references_removed`.
Tambahan v7: `references[]` (daftar pustaka terurai oleh kode, bukan AI; tiap entri `{r: teks mentah ≤240 karakter, d: DOI huruf kecil, y: tahun (boleh berakhiran a/b), a: nama belakang penulis pertama, t: judul (tebakan ≤140 karakter)}`, maks 400 entri) dan `doi_detected` (DOI artikel itu sendiri dari halaman 1-2 PDF; lebih tepercaya daripada `doi` dari AI).

Aturan keputusan (frontend, `handleDecisionChange`): mengubah screening menjadi selain `include` mereset
`eligibility_decision` ke `pending`; **setiap** perubahan keputusan mengosongkan `state.synthesis`.

### 5.2 State proyek (browser)

`localStorage["litreview_studio_project_v1"]` = `{articles[], identifiedTotal, duplicateCount, synthesis, meta{research_question,
source_name, search_date, search_query, inclusion, exclusion, guide_context}, usage{calls,prompt_tokens,cache_hit_tokens,
completion_tokens,cost_usd,cost_idr,usd_to_idr}, designUi{topic,scope}, norm{draft,approved}}`.

> **Jangan mengganti nama kunci `litreview_studio_project_v1`.** Itu kunci warisan; menggantinya membuat proyek
> yang sudah tersimpan di browser pengguna tampak hilang. `localStorage` terikat ke origin, jadi
> `localhost:5000` ≠ `127.0.0.1:5000` ≠ alamat lain tempat aplikasi dibuka.

`identifiedTotal` dan `duplicateCount` menggerakkan angka PRISMA. Duplikat yang dilewati di pre-check browser
tetap menambah keduanya, supaya hitungan PRISMA konsisten.

### 5.3 Hasil sintesis (`state.synthesis`)

`research_question_refinement`, `subquestions[]`, `executive_synthesis`, `main_themes[]` (tiap tema: `name`, `description`, `synthesis`, `confidence`, `article_ids`, dan dari sintesis mendalam `deep_synthesis`, `key_findings[{finding, article_ids}]`, `methodological_patterns`, `evidence_strength`, `open_questions[]`; opsional `coverage_notes[{article_id, note}]` dari cek cakupan), `agreements[]`,
`contradictions[]`, `research_gaps[]`, `limitations_of_corpus[]`, `review_notes[]`, dan `taxonomy{hierarchical, faceted, flat,
polyhierarchy, matrix}`. Metadata tambahan dari server: `taxonomy_status` (`ok`|`partial`|`fallback`|`failed`), `taxonomy_note|taxonomy_error`,
`included_article_count`, `generated_at`, `model`, `evidence_catalog`. Semua `article_ids` merujuk `record.id`. Field `system_map` **tidak lagi dibuat** (System Map dibangun kode, 4.2a); ekspor lama yang masih memuatnya
aman: UI mengabaikannya.

### 5.4 Ekspor/impor proyek

Ekspor = `{format:'slr-protocol-project', version:1, exported_at, ...state}`, diunduh sebagai
`slr-protocol-project-YYYY-MM-DD.json`. Impor hanya memvalidasi `articles` adalah array (penanda `format` tidak
dicek, jadi ekspor lama `litreview-studio-project` tetap bisa diimpor) dan **menimpa seluruh state**. PDF tidak
ikut diekspor. Ekspor HTML (4.2b) tidak bisa diimpor; datanya bisa diunduh ulang sebagai JSON dari dalam berkas HTML itu.

## 6. Lapisan provider AI (`llm_json`)

Semua panggilan AI melewati `llm_json(prompt, max_output_tokens, usage, progress, label)`:

- **Payload per provider.**
  - DeepSeek (`IS_API`): `POST chat/completions` dengan `Authorization: Bearer`, `response_format: json_object`,
    `thinking: {"type":"disabled"}` (V4 menyalakan thinking secara default, boros token), `temperature: 0`,
    `max_tokens = max_output_tokens × LLM_OUTPUT_SCALE`, dan `stream_options.include_usage` bila streaming.
  - Ollama: `/api/chat` dengan `format: "json"`, `think: false`, `keep_alive`, `options{num_predict,num_ctx}`.
- **Streaming**: bila `progress` diberikan, jawaban dibaca bertahap (`read_llm_stream`: SSE untuk DeepSeek,
  NDJSON untuk Ollama), progres live diperbarui ±tiap 0,6 detik, lalu dirakit menjadi dict berbentuk sama dengan
  respons non-streaming sehingga sisa kode tidak peduli. Tanpa `progress` (mis. `/api/test-ai`) respons utuh.
- **Retry satu kali** (maks 2 percobaan): bila konten kosong, JSON rusak, atau output terpotong
  (`finish_reason=length`). Percobaan kedua memakai pesan perbaikan JSON dan plafon +700 token. Token dari
  percobaan gagal **tetap dihitung dan ditagih**.
- `extract_json()` toleran terhadap pagar markdown dan teks di sekitar objek.
- **`salvage=True`**: JSON yang terpotong diselamatkan **secara lokal** (`repair_truncated_json`, tanpa panggilan ulang); hasilnya membawa kunci `_salvaged`
  (jumlah karakter ekor yang dibuang) yang harus dibuang pemanggil (`pop`). Dipakai batch, reduce, final, cek cakupan, per tema, dan taksonomi. Ingat: bagian
  yang terpotong **hilang**, jadi urutan key pada skema prompt penting (yang paling penting, mis. `gaps`/`research_gaps`, ditaruh di depan).
- Error HTTP DeepSeek dipetakan ke pesan Indonesia (401 key salah, 402 saldo habis, 429 rate limit, 5xx).
- Timeout socket 600 detik per panggilan.
- **Mode terkelola:** `llm_json` tidak berubah. `DEEPSEEK_URL` menunjuk ke proxy dan `Authorization: Bearer` berisi `USER_API_KEY`
  (bukan key DeepSeek). Proxy mengganti key, memaksa `stream_options.include_usage` pada streaming, dan meneruskan respons
  apa adanya. Galat dari proxy memakai bentuk `{"error":{"message":...}}` seperti DeepSeek. Arti kode di mode ini: 401 = key
  pengguna tidak valid/tidak dikenal, 403 = akun dinonaktifkan, 429 = kuota harian akun habis, 402 = saldo DeepSeek admin habis.

Menambah provider baru: tambahkan nilai di `LLM_PROVIDER`, blok config (MODEL, AI_URL, AI_CONFIGURED,
CONFIG_ERROR, PROVIDER_LABEL), cabang payload/headers di `llm_json`, parser di `read_llm_stream`, dan cabang di
`add_usage`. Cari semua `IS_API` / `LLM_PROVIDER` untuk titik sentuhnya.

## 7. Biaya dan token

`add_usage(usage, raw)` menambah `calls`, `prompt_tokens`, `cache_hit_tokens`, `completion_tokens`. Untuk DeepSeek
biaya dihitung per panggilan: `(hit×harga_hit + miss×harga_miss + output×harga_output) / 1e6 × faktor`, dengan
`faktor = DEEPSEEK_PEAK_MULTIPLIER` bila `deepseek_is_peak()` (Senin–Jumat, 01:00–04:00 dan 06:00–10:00 UTC), selain itu 1.
Karena dihitung per panggilan, total campuran peak/off-peak tetap benar. `cost_idr = cost_usd × USD_TO_IDR`.
Ollama: biaya 0 ("lokal").

Fakta yang sudah diverifikasi terhadap dashboard DeepSeek: jumlah token dan jumlah request cocok persis dengan
hitungan app; dashboard memotong (bukan membulatkan) biaya ke dua desimal sehingga untuk perbandingan gunakan
token/request atau tinggi grafik. Tarif dan jadwal peak bersumber dari dokumentasi/aggregator publik dan **bisa
berubah**; hari libur nasional China (off-peak) tidak dimodelkan, sehingga estimasi bisa sedikit tinggi pada hari itu.

Mode terkelola punya dua penghitung dari blok `usage` yang sama: popup token di app (per browser/laptop, bisa di-reset) dan tabel
`token_logs` di Supabase (per akun, dicatat proxy, tidak bisa diubah dari klien). Terverifikasi pada uji nyata: 10 jurnal menghasilkan
10 baris `token_logs`, dan tiap panggilan sintesis (termasuk percobaan ulang) cocok persis dengan baris log proses di app. Biaya rupiah
hanya ada di popup (dihitung klien); `token_logs` menyimpan token, bukan biaya.

Contoh nyata sintesis 69 artikel (`deepseek-flash`): ±20 panggilan, ±193 ribu token input dan ±32 ribu output, **< Rp1.000** (9 batch + 2 final + 1 cek cakupan + 8 tema + taksonomi).
Biaya rendah itu wajar karena model murah; yang menjadi ukuran kualitas adalah tidak adanya potongan output, bukan angka rupiah.

Pola biaya: output mendominasi (≈ dua pertiga biaya), cache hit jarang karena dokumen berbeda, sintesis memproses
ulang **semua** artikel INCLUDE setiap kali dijalankan (tidak inkremental). Retry menggandakan biaya panggilan itu.

## 8. Frontend (`static/app.js`)

Satu IIFE, tanpa modul. Pola umum: `state` global + `saveState()` + `renderAll()` (render ulang tab yang relevan).
Helper `$`/`$$`, `esc()` (escape HTML, **wajib** untuk semua data AI yang masuk `innerHTML`), `list()`.

| Area | Fungsi kunci |
|---|---|
| State & penyimpanan | `loadState`, `saveState`, `DEFAULT_STATE`, `STORE_KEY` |
| Navigasi | `navigate(target)`, tombol `data-target`, 12 tab: "Arah Riset" (id `arah-riset`, berdiri sendiri di atas kedua grup tanpa label, lencana TMI, bukan bagian alur proyek) dan 10 tab dalam DUA grup sidebar. TAKSONOMI (tugas desain riset): overview "Ikhtisar", articles "Artikel", design "Taksonomi Desain Riset", design-diagram "Diagram Taksonomi". SLR LANJUTAN: prisma, synthesis, extraction-matrix "Matriks Ekstraksi", taxonomy "Peta Topik", literature-map "Peta Literatur", system-map. Id `cooccurrence` diganti `literature-map` (19 Nov 2026), tautan lama `#cooccurrence` tetap bekerja lewat `NAV_ALIAS`; id lain TIDAK diganti (hanya label tampil); urutan tombol tidak memengaruhi logika `navigate`. `renderDesignSteps()` menggambar panel LANGKAH di atas Desain Riset (status dibaca dari state, tidak disimpan) |
| Upload | `handleUpload`: validasi → pre-check duplikat (`sha256Hex` via `crypto.subtle`) → FormData + `job_id` → polling → merge artikel |
| Progres | `PANELS`, `renderProcessProgress`, `startProgressPolling(kind, jobId)` (interval 500 ms) |
| Sintesis | `handleSynthesis` (menolak bila belum ada artikel INCLUDE/INCLUDE) |
| Token & tarif | `renderUsage`, popup (`renderUsagePopover`, `periodBlockHtml`, `donateBlockHtml`), `refreshHealthInfo` tiap 60 dtk |
| Visualisasi | `renderTaxonomy` (hierarchical = `topicTreeSvg`, poly = `polyDiagram`, faceted, flat, matrix), `renderCooccurrence` (`ccBuild`: `topic_tags`+`concepts`, istilah dinormalisasi `ccCanon`), `renderSystemMap` (`smBuild`: dari `relationships` per artikel, **bukan** dari `synthesis.system_map`). Ketiganya memakai mesin jaringan bersama `netLayout`/`netView` (lihat 4.2a) |
| Backup | `exportProject` (JSON), `importProject` (`Ctrl/Cmd+Shift+O`), `downloadNetPng`/`svgToPng` (semua ekspor gambar = PNG; tidak ada unduhan SVG), cetak PRISMA. Tombol **Ekspor proyek** membuka menu `#export-menu` (JSON atau HTML) |
| Jaringan | `netLayout` (force-directed + tumbukan kotak, per komponen terhubung), `netView` (SVG + hover/klik/seret), `netCommunities` (klaster), `netBBox`; dipakai Co-occurrence, System Map, dan poly-hierarchy (4.2a) |
| Ekspor HTML / mode viewer | `exportProjectHtml` (klien), `VIEWER`, `viewerApi`, `initViewer` (mode hanya-baca, 4.2b) |

Hal yang perlu diingat:
- **Batas upload dibaca dari `/api/health`** (`serverLimits`), bukan hardcode; teks di UI ikut menyesuaikan. Termasuk handler drag-and-drop pada dropzone: ia memotong ke `serverLimits.maxFiles` dan memberi toast bila ada file yang tidak ikut (dulu memotong hardcode ke 8, sehingga seret-lepas hanya mengambil 8 PDF walau batas server 20).
- **Pre-check duplikat** memakai SHA-256 isi file, identik dengan hash server (`hashlib.sha256`), dibandingkan
  dengan `state.articles[].hash`. Jika `crypto.subtle` tidak tersedia (konteks non-HTTPS selain localhost), langkah
  ini dilewati dan server tetap dedupe setelah panggilan AI.
- Popup token: tombol reset dua langkah (klik ulang dalam 4 detik), status peak/off-peak dari `healthInfo.pricing`,
  jadwal peak dikonversi ke zona waktu browser.
- Log progres: `is-live` untuk baris yang sedang diperbarui; bar hanya mengikuti `percent` dari server.
- `.progress-line.is-working` (garis putus-putus) aktif hanya saat `indeterminate` (menunggu respons pertama AI).
- **Setiap kontrol baru harus dipikirkan untuk mode viewer** (ekspor HTML hanya-baca, 4.2b). Bila ia menulis `state`, memanggil API, atau butuh server:
  sembunyikan lewat daftar `body.is-viewer ...` di `style.css` dan/atau blokir di `initViewer` (`block([...], selector)`). Bila tab hanya-baca
  membutuhkan hasil API baru, tanam jawabannya di `build_project_html` dan layani lewat `viewerApi`; tanpa itu tab akan menampilkan galat di ekspor.
- Disclaimer "SLR Lanjutan · Under development" (`.wip-bar`) **sudah dihapus** dari semua tab beserta CSS-nya. Jangan menambahkannya lagi tanpa diminta.
- Tombol keluar-masuk antar tab memakai atribut `data-go` (mis. `data-go="overview"`); di mode viewer yang menuju `overview` disembunyikan.

### Tema (`static/style.css`)

Tema terminal: variabel `:root` (`--bg --panel --line --dim --text --bright --ok --bad --warn --info --mono`),
sudut persegi, font IBM Plex Mono, warna terbalik untuk state aktif. Warna di SVG yang dibuat JavaScript
(taxonomy, co-occurrence, system map) di-hardcode di `app.js` dan harus diselaraskan manual bila tema diubah.
Ada stylesheet cetak (`@media print`) untuk PRISMA.

## 9. Deployment: distribusi terkelola (9.1) dan batasan bila di-host (9.2)

### 9.1 Distribusi saat ini: aplikasi lokal + Supabase

Aplikasi berjalan di laptop pengguna. Yang ada di cloud hanya Supabase (akun, catatan token, proxy AI).

```
Landing statis publik ──► tautan Python 3.12, Git, perintah git clone
Laptop pengguna
  slr-protocol.bat ─► git pull ─► .env minimal ─► venv + pip ─► buka browser ─► python app.py
  Flask lokal (127.0.0.1:5000)
    ├─ USER_API_KEY kosong ─► redirect /signup ─► RPC register_user ─► tulis key ke .env
    └─ USER_API_KEY terisi ─► llm_json ─► Edge Function llm-proxy ─► DeepSeek (key admin)
                                              └─► insert token_logs (service role)
```

**Aktivasi.** Mode terkelola aktif bila `SUPABASE_URL` dan `SUPABASE_ANON_KEY` terisi dan `USER_AUTH` bukan `off`. Efeknya
(`user_auth.prepare_env`): `LLM_PROVIDER=deepseek`, `DEEPSEEK_URL` bawaan ke proxy, `DEEPSEEK_API_KEY` diambil dari `USER_API_KEY`,
`HOST` bawaan `127.0.0.1`, dan semua nilai terisi di `.env.example` menjadi bawaan (prioritas di bagian 3).

**Urutan di `app.py` (jangan dibalik):** `load_dotenv(.env)` → `user_auth.prepare_env(BASE_DIR)` → konstanta provider dibaca →
`user_auth.init(app, ENV_FILE, on_new_key=_apply_user_key)`. `prepare_env` harus sebelum konstanta provider karena nilai dibaca saat import.

**`user_auth.py`.**
- `before_request` `_gate`: bila mode aktif dan `USER_API_KEY` kosong, semua jalur dialihkan ke `/signup` (HTML) atau dijawab 401 JSON
  (`/api/*`), kecuali awalan `/signup`, `/static/`, `/api/health`.
- `/signup` (GET/POST): memanggil RPC `register_user(p_username)` lewat `urllib` ke `<SUPABASE_URL>/rest/v1/rpc/register_user`
  (header `apikey`; `Authorization: Bearer` hanya bila anon key berawalan `eyJ`, yaitu JWT gaya lama). Galat SQL (`USERNAME_INVALID`,
  `USERNAME_TAKEN`) dipetakan ke pesan Indonesia di `ERRORS`.
- Sukses: key ditulis ke `.env` lewat `write_env_value` (ganti hanya baris `USER_API_KEY=`, tulis ke `.env.tmp` lalu `os.replace`),
  `os.environ` diperbarui, dan `_apply_user_key` mengubah `DEEPSEEK_API_KEY` serta `AI_CONFIGURED` tanpa restart. Bila `.env` tidak bisa
  ditulis, key ditampilkan sekali di layar agar ditempel manual.

**Skema Supabase (`supabase/schema.sql`, idempotent).**
- `users(id, username, api_key_hash, is_active, daily_token_limit, created_at)`; username unik tanpa membedakan huruf besar/kecil;
  `daily_token_limit` null = tanpa batas (bawaan). Key asli tidak disimpan, hanya SHA-256.
- `token_logs(id, user_id, model_name, prompt_tokens, cache_hit_tokens, completion_tokens, total_tokens, created_at)`.
- RLS aktif di semua tabel **tanpa policy**, dan hak `anon`/`authenticated` dicabut. Satu-satunya fungsi terbuka untuk anon:
  `register_user(p_username)` (SECURITY DEFINER; mengembalikan `slr_` + 48 heksadesimal, sekali saja). `check_user(p_key_hash)`
  hanya untuk `service_role`; menghitung status `ok`/`disabled`/`quota` dengan hari berdasarkan zona `Asia/Jakarta`.
- View `usage_per_user` (security invoker) untuk pemantauan. Blok hak akses harus tetap paling akhir di berkas.

**Edge Function `llm-proxy`.** Alur: ambil `Bearer` → wajib berawalan `slr_` → hash → `check_user` → 401/403/429 bila tidak lolos →
teruskan body (dengan `include_usage` dipaksa untuk stream) ke `DEEPSEEK_URL` memakai secret `DEEPSEEK_API_KEY` → alirkan balik respons
(`body.tee()`, satu cabang ke klien) → di cabang lain `EdgeRuntime.waitUntil(recordUsage)` membaca salinan, mengambil blok `usage` dari
**2 event SSE terakhir** (hemat CPU), lalu insert ke `token_logs` dengan **3 percobaan** (jeda 400 ms × n). Kegagalan mencatat hanya
di-log (`insert token_logs gagal (percobaan n/3)`) dan **tidak** menggagalkan jawaban ke pengguna. Respons error dari DeepSeek
diteruskan tanpa dicatat. Secret: `DEEPSEEK_API_KEY` (wajib), `DEEPSEEK_URL` (opsional). Deploy lewat dashboard (tab Code) atau
`supabase functions deploy llm-proxy --no-verify-jwt`; **Verify JWT harus mati** karena autentikasi memakai key `slr_`, bukan JWT Supabase.
Isi proxy **tidak ikut `git pull`**: setiap perubahan `index.ts` perlu deploy ulang manual, lalu cek Verify JWT masih mati.

**Pemasangan awal (admin).** (1) jalankan `schema.sql`; (2) buat/deploy `llm-proxy`, matikan Verify JWT, isi secret; (3) isi `SUPABASE_URL` dan
`SUPABASE_ANON_KEY` (berlabel anon/publishable, **bukan** secret/service_role) di `.env.example`, commit, push. Uji berurutan:
`curl -X POST <url>/functions/v1/llm-proxy -H "Authorization: Bearer asal" -d "{}"` harus 401 dengan pesan "API key tidak valid"
(bukan `Invalid JWT`); `curl <url>/rest/v1/users?select=* -H "apikey: <anon>"` harus `permission denied` (jangan menuruti saran
`GRANT` pada pesan itu); clone bersih → `slr-protocol.bat` → daftar → `/api/test-ai` → satu baris baru di `token_logs`.

**Operasi harian.** Pantau lewat view `usage_per_user`. Blokir dengan `users.is_active=false`. Batas per akun lewat `users.daily_token_limit`.
Key hilang tidak bisa dipulihkan (hash): ubah `username` akun lama, lalu pengguna mendaftar ulang.

**Pembaruan ke pengguna.** `git push` ke repo; pengguna menerimanya saat menjalankan `slr-protocol.bat` berikutnya (aplikasi yang sedang
terbuka tidak ikut berubah). Mengganti nama `.bat` yang sedang berjalan membuat jalankan pertama pengguna lama tertutup di tengah (Windows membaca `.bat`
baris demi baris); setelah itu normal.

**Batas Supabase free plan yang dipakai** (dari dokumentasi Supabase saat dokumen ini ditulis; cek lagi sebelum bergantung padanya): waktu
dinding Edge Function 150 detik, waktu CPU 2 detik per request, kuota invokasi bulanan, dan proyek free bisa di-pause bila lama tidak aktif.
Teramati pada uji nyata: panggilan LLM terlama ±18 detik, CPU maksimum 105 ms, 5xx 0%.

### 9.2 Bila di-host di server (belum ditentukan)

Bagian ini untuk kasus aplikasi dijalankan di server, bukan di laptop pengguna. Repo tidak membawa konfigurasi platform apa pun.
Hal-hal berikut adalah sifat kode saat ini dan harus dipenuhi oleh lingkungan tujuan:

- **Satu proses/worker.** Progres analisis dan sintesis disimpan di memori proses (`Progress`). Dengan banyak worker,
  polling progres bisa mendarat di proses lain dan melihat job kosong. Konkurensi (request analisis panjang + polling)
  harus datang dari thread, bukan dari proses tambahan.
- **Request panjang.** Analisis dan sintesis berjalan dalam satu request HTTP yang bisa berlangsung beberapa menit.
  Server dan proxy harus mengizinkan batas waktu sekitar 10 menit, atau pekerjaan diubah menjadi job di background
  (bagian 11 poin 1).
- **Runtime Python dengan dependensi native.** PyMuPDF adalah wheel native dan proses berjalan lama; lingkungan yang
  hanya menyediakan runtime JavaScript/edge atau fungsi serverless berumur pendek tidak cocok tanpa mengubah arsitektur.
  Versi Python tidak dipin; bila PyMuPDF belum punya wheel untuk versi Python terbaru, pin versi di lingkungan build.
- **Memori dan disk.** PDF diproses di memori: batasi `MAX_FILES_PER_BATCH` dan `MAX_FILE_MB` sesuai RAM. Bila disk
  bersifat sementara, biarkan `KEEP_SERVER_PDFS=false` dan `KEEP_SERVER_JSON=false` (bawaan); aplikasi tidak membaca
  kembali salinan itu.
- **Health check.** `/api/health` dilindungi Basic Auth bila `APP_PASSWORD` diisi, jadi pemeriksa kesehatan yang tidak
  mengirim kredensial akan menerima 401. (Gerbang mode terkelola membiarkan `/api/health` terbuka.)
- **Rahasia dan akses.** `DEEPSEEK_API_KEY` (mode mandiri) dan `APP_PASSWORD` hanya lewat environment atau secret manager, jangan
  pernah di-commit. `APP_PASSWORD` wajib bila aplikasi dapat dijangkau orang lain (tanpa itu siapa pun memakai saldo API),
  dan HTTPS wajib karena Basic Auth, `crypto.subtle`, dan Clipboard API bergantung padanya. Mode terkelola dirancang untuk
  aplikasi di localhost; menaruhnya di server publik butuh peninjauan ulang (gerbang `/signup` hanya memeriksa keberadaan `USER_API_KEY` di `.env` server, bukan per pengunjung).

## 10. Verifikasi dan pengujian

Uji UI (opsional, butuh `npm i jsdom` dan server berjalan): `node tests/ui_smoke.js http://127.0.0.1:5055 <ekspor-proyek.json|-> static/app.js` memuat halaman asli di jsdom, mengklik semua tab, dan melaporkan galat JS serta isi panel langkah. `node tests/ui_report_check.js http://127.0.0.1:5055 <ekspor-proyek.json> static/app.js` menguji end-to-end: verifikasi artikel lewat UI, pembuatan laporan, mode naskah/audit, tombol cetak, banner draf (49-53 pengecekan pada data nyata, ekspektasinya dihitung dari state proyek, bukan diasumsikan).

Tes rute dan Arah Riset (tanpa jaringan): `python tests/test_arah_riset.py` dan `python tests/test_routes.py`. `test_routes.py` mengatur
`USER_AUTH=off` sebelum mengimpor `app` supaya gerbang signup tidak mengalihkan halaman. Pengecekan sidebar memeriksa tautan **logo**
(`<a href="/" class="brand" aria-label="SLR Protocol beranda">`); teks "Beranda" memang sudah dihapus dari sidebar, dan logo menjadi jalan pulang ke `/`.
**Jalankan tiap tes di proses terpisah**: tes mengimpor `app` dengan konfigurasi env berbeda (mis. `test_user_auth.py` menguji mode terkelola dan menghapus
`USER_AUTH`), jadi satu proses untuk beberapa tes menghasilkan kegagalan palsu (pernah teramati: `test_user_auth` gagal 3 pengecekan hanya karena `USER_AUTH=off` terbawa).
`test_research_design.py` dan `test_arah_riset.py` tidak mengatur `USER_AUTH` sendiri: bila gagal dengan `KeyError` pada JSON respons
(respons 401/pengalihan, bukan data), jalankan dengan `USER_AUTH=off` di lingkungan.
Tes mode terkelola (tanpa jaringan, `_rpc` ditiru): `python tests/test_user_auth.py` (22 pengecekan: pengalihan ke `/signup`, 401 untuk `/api/*`,
pendaftaran berhasil/gagal, penulisan `.env` tanpa merusak baris lain, key aktif tanpa restart, fallback tampil key, `HOST` bawaan,
lapisan `.env.example`). Edge Function dan SQL **belum punya tes otomatis**; ujinya manual (bagian 9.1). Skrip jsdom memuat `/app` (bukan `/`, yang kini landing).

Tes SLR lanjutan dan ekspor HTML (tanpa jaringan, tanpa API key; masing-masing mengatur `USER_AUTH=off` sendiri):
- `python tests/test_synthesis_pipeline.py` (14 pengecekan): `/api/synthesize` dengan `llm_json` ditiru pada 37 artikel. Memeriksa ID asli tidak bocor ke prompt, `research_gaps`/limitasi terisi, cek cakupan menempatkan artikel yang terlewat dan menambah tema baru, tiap tema punya sintesis mendalam, `article_ids` kembali ke ID asli (ID rekaan dibuang), alias di teks naratif diganti penulis-tahun, dan cek cakupan dilewati bila semua sudah terkutip.
- `python tests/test_synthesis_pdf.py` (18 pengecekan): `build_pdf` menghasilkan PDF yang benar (bagian utama, escape HTML, diakritik, nomor halaman, bookmark, label kembar a/b, ID asing tidak bocor, input kosong → `ValueError`, dokumen panjang multi-halaman) dan rute `/api/synthesis-pdf` (200 PDF + header unduhan, 400 untuk kosong/bukan JSON).
- `python tests/test_json_repair.py` (64 pengecekan): `repair_truncated_json` pada banyak titik potong, `run_taxonomy` (status `partial`/`failed`), rute `/api/taxonomy`.
- `python tests/test_export_html.py [proyek.json [keluar.html]]` (20 pengecekan): rute `/api/export-html`, HTML rapi (tepat dua elemen `<script>`, tanpa tag Jinja,
  tanpa sumber eksternal yang dimuat otomatis, CSP terpasang), data tertanam sama dengan proyek, setiap `<script>` lolos `node --check`, teks artikel yang
  berisi `</script>` tidak lolos sebagai kode. Tanpa argumen memakai proyek mini sintetis.
- `node tests/viewer_smoke.js laporan.html` (24 pengecekan): menjalankan berkas hasil ekspor di DOM tiruan (`tests/dom_shim.js`), berpindah ke semua tab,
  memeriksa isi render, kontrol grafik (co-occurrence, system map, nomor jurnal), dan bahwa tidak ada `fetch` atau penulisan `localStorage` proyek.
- `node tests/live_export_smoke.js template-atau-ekspor.html proyek.json` (14 pengecekan): di aplikasi biasa, menu Ekspor proyek, payload ke
  `/api/export-html` (artikel, sintesis, `design.article_ids` = cakupan desain), nama berkas unduhan, ekspor JSON tetap jalan, kegagalan server jadi toast.
- `node tests/landing_tour_smoke.js` (15 pengecekan): logika carousel landing (tombol, titik, keyboard, batas awal/akhir, `prefers-reduced-motion`) dengan DOM tiruan kecil; membaca `templates/landing.html`.
- `dom_shim.js` membangun DOM tiruan dari markup berkas itu sendiri. Ia **bukan browser**: tata letak, CSS, dan klik sungguhan tetap perlu dicoba manual
  (lihat daftar periksa di bawah). Alur penuh yang pernah dijalankan: `live_export_smoke` → simpan payload → `POST /api/export-html` → `viewer_smoke`.

Daftar periksa manual sebelum merilis perubahan UI SLR lanjutan: buka ekspor HTML di browser (file://), klik semua tab, coba kontrol Co-occurrence dan
System Map, seret satu simpul, unduh PNG, dan pastikan tidak ada galat di konsol.

Tes otomatis tanpa jaringan dan tanpa API key: `python tests/test_research_design.py` (158 pengecekan: normalisasi
kutipan, pembuangan referensi, pemotongan teks, validasi codebook, taksonomi desain, hierarki). Bagian yang butuh PDF
memakai `data/pdfs` atau `SLR_PDF_DIR`. `tests/fixtures_research_design.json` berisi label buatan tangan (gold standard
mini, bukan keluaran AI), dua entri sengaja salah untuk menguji pertahanan. Belum ada tes browser otomatis di repo.
Pemeriksaan lain yang dipakai selama pengembangan:

```bash
python -m pyflakes app.py        # harus bersih
python -m py_compile app.py
node --check static/app.js
```

Smoke test manual: jalankan app, buka `/api/test-ai` (harus `"ok": true` dengan angka token), unggah 1–2 PDF kecil,
tetapkan INCLUDE/INCLUDE, jalankan sintesis, lalu cocokkan token dan jumlah request di popup dengan dashboard
penyedia. Untuk pengujian otomatis tanpa biaya: buat server tiruan yang meniru SSE DeepSeek
(`data: {...choices[0].delta.content...}`, chunk `usage` terakhir, `data: [DONE]`) dan NDJSON Ollama, arahkan
`DEEPSEEK_URL`/`OLLAMA_URL` ke sana, lalu panggil `/api/analyze` dan `/api/synthesize` sambil polling progres;
periksa persen monoton, baris `live`, dan log retry (sisipkan satu respons terpotong dengan `finish_reason=length`).

## 11. Keterbatasan yang diketahui dan arah pengembangan

Urut kira-kira berdasarkan dampak:

1. **Request panjang sinkron.** `/api/analyze` dan `/api/synthesize` berjalan dalam satu request HTTP. Pada
   server atau proxy dengan batas waktu request, batch besar bisa terputus. Perbaikan yang direncanakan: jalankan
   pekerjaan di background thread/antrian, kembalikan `job_id` segera, dan biarkan frontend polling sampai selesai
   (kerangka `Progress`/`job_id` sudah ada). Sampai itu dibuat, hasil yang sudah dibayar bisa hilang bila koneksi putus.
   Pada mode terkelola, batas waktu Edge Function (150 detik di free plan) berlaku **per panggilan LLM**, bukan per request
   `/api/analyze`, karena tiap PDF adalah satu panggilan; panggilan terlama yang teramati ±18 detik.
2. **Progres di memori, satu proses.** Hilang saat restart; tidak bekerja dengan banyak worker. Perlu penyimpanan
   bersama (mis. Redis) bila di-scale.
3. **Akun hanya untuk pencatatan dan pemblokiran.** Mode terkelola punya akun per pengguna di Supabase, tetapi aplikasi lokalnya tidak
   memisahkan data antarpengguna: siapa pun yang memegang laptop itu memakai `USER_API_KEY` di `.env`-nya. Mode mandiri memakai satu password
   bersama (Basic Auth). Proyek ada di browser masing-masing. Belum ada audit trail.
4. **Sintesis tidak inkremental** dan ekstraksi **tidak di-cache**: PDF yang sama dengan pengaturan sama tetap
   dipanggil ulang bila lolos pre-check (mis. browser lain). Ide: cache ekstraksi berkunci hash + konteks review +
   model + `MAX_TEXT_CHARS`.
5. **Tidak ada OCR.** PDF scan ditolak dengan pesan jelas.
6. **Bawaan `HOST=0.0.0.0` di mode mandiri** saat `python app.py`: dapat diakses dari perangkat lain di jaringan yang sama. Isi
   `HOST=127.0.0.1` bila hanya dipakai di komputer ini, dan/atau `APP_PASSWORD`. Mode terkelola sudah bawaan `127.0.0.1`.
7. **Auth sederhana** (Basic Auth, tanpa rate limit/lockout). Wajib HTTPS bila diakses lewat jaringan publik.
8. **Tes otomatis hanya mencakup logika murni dan alur backend dengan LLM tiruan**; belum ada CI dan belum ada
   tes browser di repo. Kualitas label AI sendiri (akurasi klasifikasi) belum diukur: perlu audit sampel manual.
9. Tarif/jadwal peak DeepSeek di-hardcode sebagai bawaan dan bisa kedaluwarsa; libur China tidak dimodelkan.
10. Warna SVG visualisasi di-hardcode di JavaScript.
11. **Label research onion banyak yang `inferred`** (philosophy kini hanya muncul bila dinyatakan penulis). Philosophy dan approach jarang dinyatakan penulis; tampilkan apa
    adanya, jangan disajikan sebagai fakta. Kebenaran label `stated` hanya dijamin bahwa kutipannya ada di teks,
    bukan bahwa kutipan itu benar-benar mendukung label.
12. **Teknik digabung berdasarkan string yang sama** (huruf besar/kecil dan tanda baca diabaikan). Sinonim ("LSTM" vs
    "Long Short-Term Memory") belum digabung: butuh langkah normalisasi konsep dengan persetujuan manusia.
13. **Taksonomi topik tetap usulan AI**, bukan hasil hitung. Cakupan diukur, tetapi kebenaran pengelompokan tidak.
14. Aturan recall self-reference hanya untuk `case_study`; label eksplisit lain yang terlewat AI tetap terlewat.
15. **Kualitas usulan normalisasi AI belum terukur pada korpus nyata** (uji memakai LLM tiruan dan pemetaan buatan tangan). Setelah persetujuan, kebenaran pengelompokan sepenuhnya tanggung jawab pengguna. Jumlah artikel pada item hasil pisah (×) tidak diketahui di editor, tetapi pohon menghitungnya ulang dari data artikel.
16. Pemotongan teks tetap bisa menghilangkan bagian tengah (hasil/diskusi) pada artikel yang sangat panjang.
17. **Proxy meneruskan body apa adanya.** Pengguna terdaftar yang memodifikasi klien dapat mengirim prompt, model, dan `max_tokens` bebas
    lewat proxy memakai saldo admin. Pencatatan dan pemblokiran akun adalah mitigasinya. Belum ada daftar model yang diizinkan atau plafon `max_tokens` di proxy.
18. **Pendaftaran terbuka tanpa kode undangan dan tanpa pembatasan laju.** Disengaja agar bisa dipakai umum. Akibatnya akun sampah dan
    pemakaian tak wajar mungkin terjadi; `daily_token_limit` bawaan kosong (tanpa batas). Penanganannya manual: pantau `usage_per_user`, blokir `is_active=false`.
19. **Key pengguna tidak dapat dipulihkan** (hanya hash disimpan). Ganti laptop atau `.env` hilang berarti akun baru dengan nama lain; admin mengganti nama akun lama.
20. **Pencatatan token bisa kurang bila semua 3 percobaan insert gagal** (hanya muncul di log fungsi). Dasar: satu baris hilang teramati pada
    uji awal sebelum ada percobaan ulang; sesudahnya tidak teramati lagi pada uji kecil.
21. **Proxy dan skema Supabase tidak ikut `git pull`** dan belum punya tes otomatis maupun versi/migrasi. Perubahan perlu deploy manual.
22. **Ketergantungan Supabase free plan.** Proyek bisa di-pause saat lama tidak aktif (aplikasi pengguna gagal daftar/memanggil AI sampai diaktifkan lagi); saldo DeepSeek admin dipakai bersama semua pengguna.
23. **`.env.example` langsung berlaku ke semua pengguna** begitu mereka menjalankan `slr-protocol.bat` lagi; tidak ada tahap uji bertahap. Aplikasi yang sedang terbuka tidak ikut berubah sampai dimulai ulang.
24. **Co-occurrence bukan VOSviewer.** Garis berarti dua istilah muncul bersama dalam artikel yang sama, bukan hubungan sebab-akibat. Istilah berasal dari
    `topic_tags` dan `concepts` hasil ekstraksi AI, jadi mutunya mengikuti mutu ekstraksi. Penggabungan istilah (`ccCanon`) heuristik: bisa terlalu longgar
    atau terlalu ketat. Klaster memakai label propagation (bukan modularity VOSviewer), jadi pembagiannya bisa berbeda. Istilah yang muncul di >=60% artikel
    disembunyikan secara default (hanya bila artikel >= 4). Batas tampilan: 45 istilah dan 140 hubungan terkuat.
25. **Panah System Map = klaim artikel**, bukan bukti kausal. Datanya `relationships` hasil ekstraksi AI per artikel; entitas digabung `ccCanon`. Peran simpul
    (asal/perantara/tujuan) murni dari arah panah. Tata letak deterministik tetapi bukan yang paling rapi; tiap kelompok terhubung ditata sendiri lalu disusun berbaris.
26. **Peta topik tetap usulan AI.** Bila JSON-nya terpotong, bagian ekor dibuang dan status menjadi `partial` (cek cakupan). Konsep irisan di tab Poly-hierarchical
    dihitung kode (bukan klaim AI) dari artikel yang sama di dua cabang. `taxonomyChecks` memakai kata kunci pada nama kategori, jadi bisa salah menandai atau
    melewatkan; pencocokan baris matrix dengan kategori lewat nama.
27. **Ekspor HTML adalah potret hanya-baca.** Ekspor ulang bila data berubah. Font Inter/Poppins tidak ikut, tab Arah Riset TMI tidak ikut, avatar kredit dibuang.
    Berkas memuat seluruh data ekstraksi (seperti JSON): perhatikan hak cipta dan privasi sebelum dibagikan. Ukurannya naik mengikuti data (±610 KB untuk 20 artikel).
    Diuji dengan DOM tiruan, bukan browser sungguhan.

## 12. Panduan perubahan cepat

| Ingin… | Ubah di… |
|---|---|
| Menambah/mengubah field ekstraksi artikel | `article_prompt` (skema), pembentukan `record` di `analyze_pdfs`, `compact_article`, lalu `renderArticleDetail` di `app.js` |
| Mengubah perilaku sintesis | `batch_synthesis_prompt`, `reduce_summaries_prompt`, `final_synthesis_prompt` (1/2), `gaps_synthesis_prompt` (2/2), `coverage_prompt`, `theme_deep_prompt`, `taxonomy_only_prompt`; plafon token di endpoint `synthesize`; bentuk keluaran dipakai `renderSynthesis`/`renderTaxonomy`/`renderSystemMap` dan `synthesis_pdf.build_html`. Jaga urutan key skema (bagian penting di depan) |
| Mengubah isi atau tampilan PDF Review Synthesis | `synthesis_pdf.py` (`build_html` untuk isi, `CSS` untuk tampilan, `build_pdf` untuk header/footer/bookmark); tombol dan unduhan di `downloadSynthesisPdf` (`app.js`), tombol `#download-synthesis-pdf` di `index.html`; jalankan `tests/test_synthesis_pdf.py` |
| Mengubah label rujukan penulis-tahun | `_alias_label` (`app.py`, teks hasil sintesis) dan `_label` (`synthesis_pdf.py`, daftar rujukan PDF); jaga keduanya sama |
| Menambah/mengubah nilai research onion | `RESEARCH_ONION` (+ `METHOD_GROUPS`, naikkan `CODEBOOK_VERSION`); prompt, validasi, dan taksonomi mengikuti otomatis |
| Mengubah batas | `.env` (lihat tabel bagian 3); bawaan ada di blok "Batas bawaan" `app.py`. Untuk semua pengguna mode terkelola: ubah di `.env.example` (atau bawaan di kode), lalu push |
| Mengubah tarif/jadwal peak | `.env` (`DEEPSEEK_PRICE_*`, `DEEPSEEK_PEAK_MULTIPLIER`); jadwal di `deepseek_is_peak` dan `deepseek_pricing_info` |
| Mengubah kategori/istilah query Arah Riset | `arah_riset_data/vocab_en.json` (istilah, urutan = prioritas), `arah_riset.py` (`RQ_TEMPLATE`, kriteria, `max_ops`) |
| Mengubah tampilan atau isi landing | `templates/landing.html` + `static/landing.css` (terpisah dari workspace; `:root`-nya salinan dari `style.css`). Ilustrasi tur = SVG inline di `landing.html` (digambar manual); carousel = `#tour` + skrip inline di akhir berkas; jaga angka 8 slide di `tests/test_routes.py` |
| Menambah tab/halaman | `index.html` (tombol `data-target` + `section.page-section`), `navigate`/`renderAll` di `app.js` |
| Mengubah tema | variabel `:root` di `style.css` + warna SVG di `app.js` |
| Menambah kredensial/rahasia | `.env` mandiri, atau secret Supabase untuk proxy; jangan pernah commit nilainya dan jangan taruh di `.env.example` |
| Mengubah tabel, fungsi, atau view Supabase | `supabase/schema.sql` lalu jalankan di SQL Editor (jaga blok hak akses tetap paling akhir) |
| Mengubah perilaku proxy (batas, model, pencatatan) | `supabase/functions/llm-proxy/index.ts` lalu deploy ulang manual; cek Verify JWT masih mati |
| Mengubah halaman pendaftaran | `templates/signup.html` (CSS inline, tema sama dengan landing); pesan galat di `ERRORS` dalam `user_auth.py` |
| Mengganti nama atau isi peluncur Windows | `slr-protocol.bat` (CRLF; hindari tanda `)` pada teks `echo` di dalam blok `( ... )`; panggil `git` dengan `call`) lalu perbarui teks `slr-protocol.bat` di landing, `signup.html`, README |
| Mengubah apa yang disembunyikan atau dikunci di ekspor HTML | daftar `body.is-viewer ...` di `style.css`, `initViewer` (`block`, kunci formulir) di `app.js`; data server yang dibutuhkan tab hanya-baca di `build_project_html` + `viewerApi` |
| Mengubah menu atau isi ekspor proyek | `#export-menu` di `index.html`, `exportProject`, `exportProjectHtml`, rute `/api/export-html`, `build_project_html` |
| Mengubah penggabungan istilah, klaster, atau peran simpul jaringan | `ccCanon`, `ccBuild`, `netCommunities`, `smBuild`, `SM_ROLE` |
| Mengubah tata letak atau tampilan grafik jaringan | `netLayout`/`netView`; parameter per grafik ada di `renderCooccurrence`, `renderSystemMap`, `polyDiagram` |
| Mengubah poly-hierarchy turunan atau pemeriksaan "Perlu dicek" | `derivePolyhierarchy`, `taxonomyChecks`, `TX_HOW` (kata kunci cara-riset) |
| Mengubah penanganan JSON AI yang terpotong | `repair_truncated_json`, parameter `salvage` pada `llm_json`, `run_taxonomy` |

## 13. Konvensi untuk kontributor

- Pertahankan gaya satu-berkas; komentar singkat, jelaskan **mengapa**, bukan apa.
- Semua teks yang tampil ke pengguna dalam bahasa Indonesia, nada ringkas dan jelas.
- Semua data dari AI atau PDF yang masuk `innerHTML` harus melewati `esc()`.
- Jangan menyimpan rahasia di repo; `.env` ada di `.gitignore`. Rotasi key bila pernah ter-commit. `.env.example` publik dan menjadi bawaan
  semua pengguna terkelola: tidak boleh berisi `DEEPSEEK_API_KEY`, `service_role`/secret key Supabase, atau password apa pun.
  Cek `git ls-files .env` kosong sebelum push.
- Berkas `.bat` harus CRLF (`.gitattributes` menanganinya) dan hanya berisi ASCII.
- Perubahan di `.env.example`, `slr-protocol.bat`, dan kode langsung sampai ke semua pengguna saat mereka menjalankan peluncur; uji di clone bersih sebelum push.
- Jalankan pemeriksaan di bagian 10 sebelum commit. Hindari mengubah kunci `localStorage` dan skema record artikel
  tanpa jalur migrasi (data pengguna ada di browser mereka dan di file ekspor).
- Perubahan fitur yang terlihat pengguna: perbarui **README.md** (cara pakai, pemecahan masalah, keterbatasan) dan **CLAUDE.md** (alur, fungsi kunci, keterbatasan,
  panduan perubahan) di commit yang sama. Pertimbangkan juga dampaknya pada mode viewer ekspor HTML (bagian 4.2b).