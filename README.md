# SLR Protocol — Systematic Literature Review dengan bantuan AI

Workspace web untuk systematic literature review (SLR). Kamu mengunggah PDF jurnal, AI mengekstrak data
terstruktur dari tiap artikel, kamu memutuskan INCLUDE/EXCLUDE secara manual, lalu AI menyintesis seluruh
artikel yang lolos menjadi tema, kontradiksi, research gap, taxonomy, jaringan istilah, dan system map.

- **Backend:** Python + Flask (satu berkas, `app.py`).
- **Frontend:** HTML/CSS/JavaScript biasa, tanpa framework dan tanpa build step.
- **AI:** dua mode. **Terkelola** (untuk dibagikan ke banyak orang): pengguna mendaftar sekali dan AI (DeepSeek) berjalan lewat
  proxy milik admin, jadi tidak perlu API key sendiri. **Mandiri**: pilih satu lewat `.env`, **Ollama lokal** (gratis) atau
  **DeepSeek API** dengan key sendiri (berbayar per token).
- **Akun dan token (mode terkelola):** Supabase menyimpan akun, API key per pengguna (dalam bentuk hash), dan catatan pemakaian token.
- **Penyimpanan proyek:** tidak ada database untuk proyek. Proyek disimpan di browser (`localStorage`) dan dicadangkan lewat Ekspor JSON.

> Dokumentasi teknis lengkap (arsitektur, alur data, API, konvensi) ada di [`CLAUDE.md`](CLAUDE.md).

## Fitur

- Unggah batch PDF berbasis teks, dengan cek duplikat di browser sebelum upload (hash SHA-256) supaya PDF yang sama
  tidak diproses, dan tidak ditagih, dua kali.
- Ekstraksi per artikel: judul, penulis, tahun, DOI, abstrak, tujuan, metode, konteks, variabel, temuan, keterbatasan,
  saran riset lanjutan, konsep, relasi, dan kutipan bukti. AI juga memberi rekomendasi screening, tetapi keputusan
  awal selalu `pending` sampai kamu menetapkannya.
- Dua tahap verifikasi manual: screening judul/abstrak dan full-text eligibility. Sintesis hanya memakai artikel
  yang **INCLUDE di kedua tahap**.
- PRISMA flow, review synthesis (tema, kesepakatan, kontradiksi, research gap), lima bentuk taxonomy
  (hierarchical, poly-hierarchical, faceted, flat, matrix), jaringan co-occurrence, dan system map (unduh SVG).
- **Desain riset (research onion):** tiap artikel diberi label metodologi, strategi, sumber data, dan time horizon
  (berikut basis dinyatakan/disimpulkan dan kutipan yang diverifikasi ke PDF), disusun menjadi taksonomi desain riset
  dan matriks metodologi × strategi. Nama dan keluarga teknik dinormalisasi lewat usulan AI yang kamu setujui; editor
  pemetaannya punya tab per metode (Kuantitatif, Kualitatif, Campuran) untuk memeriksa teknik menurut jenis artikelnya.
  Hasilnya bisa diekspor sebagai **laporan HTML** mandiri (bisa dicetak ke PDF).
- **Arah Riset (khusus TMI ITB):** untuk yang belum punya topik. Pilih kelompok keilmuan, jenis masalah, sektor, dan metode dari
  kategori yang diturunkan dari tesis TMI terdahulu; hasilnya topik umum, research question, query ScienceDirect/Scopus, dan
  kriteria inklusi/eksklusi. Tanpa AI dan tanpa biaya token. Hasilnya arah awal, bukan topik final.
- **Diagram taksonomi:** hasil taksonomi desain riset divisualkan sebagai pohon yang bisa dibuka/ditutup atau sunburst, dengan detail
  artikel per simpul dan unduhan SVG/PNG (opsional latar terang untuk dicetak). Tanpa AI dan tanpa biaya token.
- **Progres live** untuk analisis dan sintesis: persen berdasarkan langkah yang benar-benar selesai, log per
  panggilan AI (token, durasi, biaya), serta catatan retry bila jawaban terpotong.
- **Popup pemakaian token** (klik chip token di pojok kanan atas): token, jumlah panggilan, estimasi biaya
  USD/Rupiah, status tarif **peak/off-peak** DeepSeek, dan tombol reset.
- Ekspor/impor proyek JSON (impor: `Ctrl/Cmd + Shift + O`), cetak PRISMA.

## Prasyarat

- Windows (peluncur `slr-protocol.bat`), atau OS apa pun dengan cara manual di bawah.
- Python 3.12 (3.10 atau lebih baru juga bisa) dan Git. Pemasang untuk keduanya ada di halaman panduan.
- Browser modern.
- **Mode terkelola:** tidak ada tambahan. Kamu tidak perlu API key.
- **Mode mandiri:** salah satu dari
  - Ollama terpasang dengan model, misalnya `ollama pull qwen3-vl:8b-instruct`; atau
  - API key DeepSeek dari https://platform.deepseek.com/api_keys (pastikan saldo terisi).

## Menjalankan

### Mode terkelola (pengguna biasa)

Aktif bila `SUPABASE_URL` dan `SUPABASE_ANON_KEY` terisi di `.env.example` (admin yang mengisinya).

**Sekali di awal**

1. Pasang Python 3.12 (centang "Add Python to PATH") dan Git.
2. Buka terminal lalu jalankan `git clone <URL_REPO>`.

**Setiap kali memakai**

1. Masuk ke folder hasil clone, klik dua kali `slr-protocol.bat`.
2. Skrip menarik pembaruan (`git pull`), menyiapkan lingkungan Python dan paket, menjalankan aplikasi, lalu membuka
   browser ke http://127.0.0.1:5000. Pertama kali butuh beberapa menit. Biarkan jendela hitamnya terbuka selama aplikasi dipakai.
3. **Pertama kali** kamu diarahkan ke `/signup`. Isi nama pengguna atau email, lalu API key pribadimu dibuat dan ditulis
   otomatis ke file `.env`. Setelah itu tidak perlu mendaftar lagi.

Catatan:

- Landing page ada di `/`, workspace di `/app`, uji koneksi AI di `/api/test-ai`.
- Di mode ini server hanya bisa dibuka dari komputer sendiri (`HOST=127.0.0.1` bawaan).
- File `.env`-mu hanya berisi `USER_API_KEY`. Jangan dibagikan. Pengaturan lain (model, batas, tarif) datang dari
  `.env.example` dan ikut diperbarui lewat `git pull`. Bila kamu menulis sendiri sebuah variabel di `.env`, nilaimu yang dipakai.
- Pembaruan kode berlaku saat `slr-protocol.bat` dijalankan lagi. Aplikasi yang dibiarkan terbuka berhari-hari tidak ikut berubah sampai dimulai ulang.
- Tips: klik kanan `slr-protocol.bat` → Send to → Desktop (create shortcut), lalu Properties → Change Icon dan pilih
  `static/slr.ico`. Jangan memindahkan folder aplikasinya setelah itu.

### Mode mandiri (tanpa Supabase, atau untuk pengembangan)

Berlaku bila `SUPABASE_URL` kosong, atau bila `.env`-mu berisi `USER_AUTH=off`. Di mode ini `.env.example` hanya contoh
dan tidak dibaca otomatis.

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # lalu edit .env
python app.py
```

Buka http://127.0.0.1:5000 (landing page); workspace ada di http://127.0.0.1:5000/app. Untuk menguji koneksi AI tanpa upload PDF, buka `/api/test-ai`.
Pill status di pojok kanan atas harus menampilkan "Model siap".

`slr-protocol.bat` juga bisa dipakai di mode ini, tetapi ia membuat `.env` minimal (hanya `USER_API_KEY=`). Tambahkan
pengaturan AI-mu ke file itu.

Di mode mandiri server dapat dibuka dari perangkat lain di jaringan yang sama (`HOST=0.0.0.0` bawaan). Isi `HOST=127.0.0.1`
di `.env` agar hanya komputer ini yang bisa membukanya, dan isi `APP_PASSWORD` bila orang lain dapat menjangkaunya,
karena tanpa itu siapa pun bisa memakai saldo API-mu.

### Memilih provider AI (mode mandiri)

Atur di `.env`, lalu restart aplikasi (`.env` hanya dibaca saat start):

```env
# DeepSeek API
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-xxxxxxxx

# atau Ollama lokal (default bila LLM_PROVIDER tidak diisi)
LLM_PROVIDER=ollama
OLLAMA_MODEL=qwen3-vl:8b-instruct
```

Semua variabel (model, tarif, batas, saklar penyimpanan) dijelaskan di [`.env.example`](.env.example).
Nilai yang tertulis di `.env` selalu mengalahkan nilai bawaan. Di mode terkelola, provider selalu DeepSeek lewat proxy
dan pengaturan provider di atas diabaikan.

### Batas bawaan

| Batas | Ollama | DeepSeek |
|---|---|---|
| Teks yang dibaca per PDF | 18.000 karakter | 80.000 karakter (batas pengaman 200.000) |
| PDF per upload | 8 | 20 |
| Ukuran per PDF | 12 MB | 30 MB |
| Artikel per batch sintesis | 4 | 12 |

Model lokal 8B punya konteks sempit sehingga batasnya ketat. Dengan API, bagian akhir artikel (hasil,
limitasi, saran riset) ikut terbaca. Semua batas dapat diubah lewat `.env`.

## Biaya DeepSeek

Di mode terkelola, biaya ditanggung admin lewat key DeepSeek yang tersimpan di server (kamu tidak ditagih). Popup token di
aplikasi tetap menghitung pemakaian dari komputermu. Penjelasan di bawah berlaku untuk keduanya.

- Tarif dihitung per juta token: input (cache miss), input (cache hit), dan output. Bawaan di `.env.example`
  mengikuti tarif `deepseek-flash` **off-peak**; saat **peak** tarif dikali 2.
- **Peak:** Senin–Jumat 01:00–04:00 dan 06:00–10:00 UTC (= 08:00–11:00 dan 13:00–17:00 WIB). Di luar itu dan di
  akhir pekan: off-peak. Hari libur nasional China (kabarnya off-peak) tidak dimodelkan.
- Biaya output biasanya mendominasi, sedangkan cache hit jarang terjadi pada dokumen yang berbeda.
- Rupiah di popup hanyalah estimasi dari `USD_TO_IDR`. Dashboard DeepSeek menagih dalam USD dan menampilkan
  biaya dipotong ke dua desimal, jadi untuk membandingkan gunakan jumlah token dan jumlah request.
- Tarif bisa berubah. Cek https://api-docs.deepseek.com/quick_start/pricing dan sesuaikan `DEEPSEEK_PRICE_*`.

## Untuk admin: akun, proxy, dan pemantauan (mode terkelola)

Alur panggilan AI: aplikasi di laptop pengguna → Supabase Edge Function `llm-proxy` → DeepSeek. Proxy memeriksa API key
pengguna (`slr_...`), memastikan akunnya aktif dan belum melewati batas harian, meneruskan permintaan memakai key DeepSeek
milikmu (disimpan sebagai secret Supabase, tidak pernah sampai ke laptop pengguna), lalu mencatat token ke tabel `token_logs`.

Pasang sekali:

1. Supabase → SQL Editor: jalankan `supabase/schema.sql`.
2. Edge Functions: buat fungsi `llm-proxy` dari `supabase/functions/llm-proxy/index.ts`, **matikan Verify JWT**, lalu isi secret `DEEPSEEK_API_KEY`.
3. Isi `SUPABASE_URL` dan `SUPABASE_ANON_KEY` (kunci berlabel anon/publishable, bukan secret) di `.env.example`, lalu commit dan push.

Sehari-hari (Table Editor atau SQL Editor):

- **Pantau:** view `usage_per_user` (total token, token hari ini, terakhir dipakai per akun).
- **Blokir:** set `users.is_active = false`.
- **Batas harian:** isi `users.daily_token_limit` (kosong = tanpa batas, bawaan).
- **Pengguna ganti laptop atau `.env` hilang:** key tidak bisa ditampilkan ulang karena hanya hash yang disimpan. Ubah `username` akun lamanya (mis. `budi_lama`), lalu minta dia mendaftar lagi.

Yang dicatat: nama pengguna atau email, hash API key, dan per panggilan AI jumlah token, nama model, serta waktu. Isi PDF dan hasil
analisis tidak disimpan di Supabase. Teks artikel diteruskan ke DeepSeek dan tunduk pada kebijakan DeepSeek.

Detail arsitektur, keamanan, dan batasannya ada di [`CLAUDE.md`](CLAUDE.md) bagian 9.1.

## Cara menggunakan

0. (Opsional, bila belum punya topik) buka **Arah Riset**, pilih arah dari tesis terdahulu, lalu salin query ke pencarian jurnal.
1. Isi research question, sumber/database, tanggal dan query pencarian, serta kriteria inklusi/eksklusi.
2. Unggah PDF berbasis teks. PDF yang sudah ada di proyek dilewati otomatis.
3. Di tab **Artikel**, periksa hasil ekstraksi dan tetapkan keputusan screening, lalu keputusan full-text.
4. Buka **Review Synthesis** dan jalankan sintesis **sekali di akhir** (setiap sintesis memproses ulang semua
   artikel INCLUDE dan menambah biaya).
5. Periksa PRISMA, taxonomy, co-occurrence, dan system map.
6. (Opsional) Buka **Taksonomi Desain Riset** dan rapikan nama serta keluarga teknik; langkahnya ada di
   [Normalisasi teknik](#normalisasi-teknik-taksonomi-desain-riset) di bawah.
7. **Ekspor proyek** secara berkala. Mengubah keputusan artikel menghapus hasil sintesis lama, jadi sintesis
   perlu dijalankan ulang.

### Normalisasi teknik (Taksonomi Desain Riset)

Dipakai untuk menyatukan nama teknik yang bervariasi dan mengelompokkannya ke keluarga. AI hanya mengusulkan; pohon baru
berubah setelah kamu menyetujui.

1. Di tab **Taksonomi Desain Riset**, klik **Usulkan pengelompokan (AI)**. Bila pemetaan sudah ada dan muncul teknik baru,
   pakai **Perbarui untuk teknik baru**: keluarga lama dipertahankan dan hanya teknik yang belum terpetakan yang diusulkan.
   Untuk mengubah pemetaan yang sudah disetujui, klik **Edit pemetaan**.
2. Periksa draf di editor: ubah nama atau definisi keluarga, pindahkan teknik lewat dropdown keluarga di tiap barisnya,
   gabungkan varian nama, atau hapus bagian "Dibuang". Bagian **Dibuang** memuat nama yang dianggap AI bukan teknik
   (mis. solver, instrumen lab); yang dibuang tidak muncul di pohon, jadi periksa daftarnya.
3. Pakai **tab** di atas editor untuk memeriksa menurut jenis artikel: **Semua**, **Kuantitatif**, **Kualitatif**, **Campuran**.
   Tab hanya menyaring tampilan. Satu keluarga tetap satu keluarga, dan mengubah nama atau definisinya berlaku di semua tab.
   Satu teknik tampil di tab sesuai label metodologi artikel yang memakainya, sama seperti cabang pada pohon, jadi keluarga
   yang dipakai artikel dari beberapa jenis akan muncul di beberapa tab dengan teknik masing-masing.
4. Tiap keluarga menampilkan sebaran artikelnya ("Kuantitatif 2 · Kualitatif 1"), dan tiap teknik menampilkan label metode
   artikelnya. Tanda **⚠** muncul bila satu keluarga memuat teknik yang hanya dipakai artikel kuantitatif sekaligus teknik
   lain yang hanya dipakai artikel kualitatif. Itu petunjuk untuk dicek, bukan tanda salah: bila isinya memang satu keluarga
   yang wajar (mis. perkakas lean/Six Sigma), abaikan. Bila ada yang jelas keliru, pindahkan tekniknya atau pecah keluarga.
5. Memecah keluarga: **Tambah keluarga** (isi nama, pilih tab petunjuk), lalu pindahkan tekniknya satu per satu lewat dropdown
   keluarga. Tab petunjuk hanya menentukan di tab mana keluarga yang masih kosong tampil; setelah ada teknik, posisinya
   mengikuti artikel. Tidak ada pindah massal.
6. Klik **Setujui & terapkan ke pohon**. Pohon dan diagram langsung memakai pemetaan itu. **Hapus normalisasi** mengembalikan
   pohon ke daftar teknik datar.

Catatan:
- Cabang pada pohon selalu mengikuti label **metodologi artikel**, bukan keluarga: satu artikel hanya di satu cabang
  (Kuantitatif, Kualitatif, atau Campuran). Menaruh keluarga di tab tertentu tidak memindahkan artikelnya. Bila label
  artikelnya keliru, itu berasal dari ekstraksi dan perlu dianalisis ulang.
- Usulan AI bisa berbeda antar run, termasuk soal apa yang dibuang. Periksa draf sebelum menyetujui.

### Di mana datamu disimpan

- Proyek (artikel, keputusan, sintesis, penghitung token) ada di `localStorage` browser, **per alamat**:
  `localhost:5000` dan `127.0.0.1:5000` adalah dua penyimpanan berbeda. Membersihkan data browser
  menghapus proyek, maka klik **Ekspor proyek** sesudah setiap batch upload dan setelah sintesis.
- **Impor menimpa seluruh proyek** di browser, bukan menggabungkan.
- Salinan PDF/JSON di server bersifat opsional dan **mati secara bawaan**
  (`KEEP_SERVER_PDFS`, `KEEP_SERVER_JSON`); aplikasi tidak membacanya kembali.
- Mode terkelola: Supabase hanya menyimpan akun dan catatan token (lihat bagian admin di atas), bukan proyekmu.

## Aset gambar

Gambar yang dipakai antarmuka ada di `static/`: `slr.png` (logo dan favicon), `latte0nim.jpg` dan `feinstehaar.jpg` (avatar credit),
`qris.png` (QRIS pada popup token, kotaknya menyembunyikan diri bila gambar tidak ada), dan `slr.ico` (ikon untuk shortcut Windows).

## Pemecahan masalah

| Gejala | Penyebab umum |
|---|---|
| "API key belum dipasang" | Mode mandiri: `DEEPSEEK_API_KEY` kosong, atau lupa restart setelah mengubah `.env`. Mode terkelola: daftar dulu di `/signup` |
| HTTP 401 dari DeepSeek | API key salah/belum aktif |
| HTTP 402 dari DeepSeek | Saldo habis, top up di platform.deepseek.com (mode terkelola: saldo admin, kabari admin) |
| HTTP 429 | Terkena rate limit, tunggu lalu coba lagi. Di mode terkelola bisa juga berarti batas token harian akunmu habis (pesannya menyebut kuota) |
| Proyek tampak kosong | Alamat/port berbeda dari sebelumnya, atau data browser dibersihkan: impor file ekspor |
| Teks "tidak terbaca" pada PDF | PDF hasil scan tanpa lapisan teks; belum ada OCR, jalankan OCR dulu |
| Banyak "retry" di log | Output AI terpotong di batas token; naikkan `LLM_OUTPUT_SCALE` |
| Selalu dialihkan ke `/signup` | `USER_API_KEY` di `.env` masih kosong. Selesaikan pendaftaran di halaman itu |
| "Nama pengguna itu sudah dipakai" | Pilih nama lain. Bila itu akunmu yang lama (ganti laptop atau `.env` hilang), minta admin mengganti nama akun lama |
| "Tidak bisa terhubung ke server" saat daftar | Koneksi internet bermasalah, atau proyek Supabase sedang tidak aktif (kabari admin) |
| 401 "API key tidak dikenal" | `USER_API_KEY` di `.env` salah salin atau akunnya dihapus; hubungi admin |
| 403 "Akun kamu dinonaktifkan" | Akun diblokir admin |
| Jendela hitam `slr-protocol.bat` langsung tertutup | Jalankan lewat `cmd` (ketik `slr-protocol.bat` di folder aplikasi) supaya pesan errornya terbaca. Pembaruan `git pull` juga gagal bila kamu mengubah file kode |

## Keterbatasan dan integritas akademik

- Belum ada pencarian otomatis ke Scopus, Web of Science, PubMed, IEEE Xplore, atau Google Scholar. Catat sumber,
  tanggal, dan query secara manual.
- Belum ada OCR otomatis untuk PDF hasil scan.
- PRISMA dibangun dari file yang berhasil diproses dan keputusan manualmu; angka hasil database yang tidak
  kamu input tidak diketahui sistem.
- Screening satu reviewer dengan bantuan AI bukan pengganti penilaian kritis peneliti. Periksa semua keputusan,
  kutipan halaman, metodologi, dan temuan terhadap artikel aslinya.
- AI dapat salah mengekstrak, menyimpulkan hubungan yang tidak didukung, atau melewatkan konteks.
- Normalisasi teknik: pengelompokan dan daftar yang dibuang bisa berubah antar run, dan tanda ⚠ hanya membandingkan label
  metode artikel, bukan sifat tekniknya. Keduanya membantu pemeriksaan, bukan penilaian akhir.
- Dengan DeepSeek, teks artikel dikirim ke server pihak ketiga (di mode terkelola lewat proxy admin lebih dulu). Jangan
  unggah materi rahasia atau yang tidak boleh dibagikan.
- Ini prototype untuk penggunaan riset. Akun di mode terkelola hanya untuk pencatatan token dan pemblokiran, bukan
  pemisahan data antarpengguna. Tidak ada audit trail formal atau quality appraisal standar.

## Struktur repo

```
app.py                  backend Flask (API, prompt, provider AI, progres, biaya)
user_auth.py            mode terkelola: gerbang /signup, tulis USER_API_KEY ke .env, arahkan AI ke proxy
arah_riset.py           Arah Riset (langkah 0, khusus TMI ITB)
arah_riset_data/        data facet tesis dan kosakata query
templates/index.html    workspace (semua tab)
templates/landing.html  landing page di `/`
templates/signup.html   halaman pendaftaran (mode terkelola)
static/                 app.js, style.css, landing.css, gambar, slr.ico
supabase/schema.sql     tabel, RLS, dan fungsi (jalankan di SQL Editor Supabase)
supabase/functions/llm-proxy/index.ts   Edge Function proxy DeepSeek + pencatat token
slr-protocol.bat        peluncur Windows (pull, venv, pip, jalankan, buka browser)
requirements.txt        dependensi Python
.env.example            konfigurasi bersama: bawaan untuk semua pengguna di mode terkelola, contoh di mode mandiri
.gitattributes          memaksa akhir baris Windows (CRLF) untuk file .bat
tests/                  tes otomatis logika murni dan alur backend (tanpa jaringan)
CLAUDE.md               dokumentasi teknis end-to-end
```

## Referensi

- PRISMA 2020: https://www.prisma-statement.org/prisma-2020
- DeepSeek API: https://api-docs.deepseek.com
- Ollama: https://ollama.com