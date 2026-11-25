"""PDF Review Synthesis yang rapi (A4), dirakit di server dengan PyMuPDF Story. Tanpa dependensi baru.

Isi: judul + metadata, sintesis eksekutif, tema utama (sintesis mendalam, temuan kunci, pola metode, kekuatan bukti),
konsistensi, kontradiksi, research gaps, limitasi, catatan verifikasi, daftar artikel rujukan.
Semua teks di-escape; PDF punya bookmark (outline), header, dan nomor halaman.
"""
import html
import io
import re
from datetime import datetime

import pymupdf

ACCENT = "#b3236b"
INK = "#1d2330"
MUTED = "#5b6475"
RULE = "#d9dce3"
SOFT = "#f4f5f8"

CSS = f"""
body {{ font-family: sans-serif; color: {INK}; font-size: 9.6pt; line-height: 1.42; }}
p {{ margin: 0 0 5pt 0; text-align: left; }}
h1 {{ font-size: 25pt; line-height: 1.12; margin: 0 0 6pt 0; color: {INK}; }}
h2 {{ font-size: 14.5pt; color: {INK}; margin: 18pt 0 3pt 0; padding: 0 0 3pt 0; border-bottom: 1.4pt solid {ACCENT}; }}
h3 {{ font-size: 11.2pt; color: {INK}; margin: 11pt 0 2pt 0; }}
h4 {{ font-size: 9.6pt; color: {ACCENT}; margin: 7pt 0 1pt 0; }}
.eyebrow {{ font-size: 8pt; color: {ACCENT}; font-weight: bold; margin: 0 0 6pt 0; }}
.sub {{ color: {MUTED}; font-size: 9.2pt; margin: 0 0 10pt 0; }}
.meta td {{ padding: 4pt 8pt 4pt 0; vertical-align: top; font-size: 8.8pt; border-bottom: 0.6pt solid {RULE}; }}
.meta td.k {{ color: {MUTED}; width: 92pt; font-weight: bold; }}
.note {{ padding: 6pt 8pt; margin: 8pt 0 4pt 0; font-size: 8.6pt; color: {MUTED}; border-left: 2.5pt solid {ACCENT}; }}
.small {{ font-size: 8.2pt; color: {MUTED}; }}
.src {{ font-size: 7.9pt; color: {MUTED}; margin: 1pt 0 6pt 0; }}
.tag {{ font-size: 7.8pt; font-weight: bold; color: {ACCENT}; }}
.item {{ margin: 0 0 4pt 0; padding: 0 0 4pt 0; page-break-inside: avoid; }}
ul {{ margin: 1pt 0 5pt 0; padding-left: 14pt; }}
li {{ margin: 0 0 2.5pt 0; }}
.refs td {{ font-size: 8pt; padding: 3.5pt 6pt 3.5pt 0; vertical-align: top; border-bottom: 0.5pt solid {RULE}; line-height: 1.32; }}
.refs td.lab {{ width: 96pt; font-weight: bold; color: {INK}; }}
.theme {{ margin: 0 0 4pt 0; }}
"""


def _e(value):
    return html.escape(str(value if value is not None else ""), quote=False)


# Karakter yang tidak ada di font bawaan Story diganti agar tidak muncul kotak kosong.
_SUBS = {"≈": "~", "→": "->", "←": "<-", "≤": "<=", "≥": ">=", "−": "-", "–": "-", "—": " - ", "“": '"', "”": '"',
         "‘": "'", "’": "'", " ": " ", "​": "", "\ufeff": "", "×": "x", "∈": " in ", "∑": "sum", "≠": "!=", "±": "+/-"}


def _t(value):
    text = str(value if value is not None else "")
    for src, dst in _SUBS.items():
        text = text.replace(src, dst)
    return _e(text)


def _paras(value, cls=""):
    text = str(value or "").strip()
    if not text:
        return ""
    parts = [p.strip() for p in re.split(r"\n\s*\n|\n", text) if p.strip()]
    attr = f' class="{cls}"' if cls else ""
    return "".join(f"<p{attr}>{_t(p)}</p>" for p in parts)


def _list(items, cls=""):
    items = [i for i in (items or []) if str(i).strip()]
    if not items:
        return ""
    attr = f' class="{cls}"' if cls else ""
    return f"<ul{attr}>" + "".join(f"<li>{_t(i)}</li>" for i in items) + "</ul>"


def _label(article):
    authors = article.get("authors") if isinstance(article.get("authors"), list) else []
    first = str(authors[0]).strip() if authors else ""
    surname = first.split()[-1].strip(",.") if first else ""
    year = str(article.get("year", "")).strip() or "n.d."
    if surname:
        return f"{surname}{' et al.' if len(authors) > 1 else ''} {year}"
    return f"{str(article.get('title', 'Artikel'))[:36].strip()} {year}"


def _build_labels(articles):
    """id -> label; label kembar diberi akhiran a, b, c supaya tiap rujukan unik."""
    labels = {a.get("id"): _label(a) for a in articles if a.get("id")}
    seen = {}
    for aid, lab in labels.items():
        seen.setdefault(lab, []).append(aid)
    for lab, ids in seen.items():
        if len(ids) > 1:
            for n, aid in enumerate(ids):
                labels[aid] = f"{lab}{chr(97 + n)}"
    return labels


def _sources(ids, labels):
    names = []
    for i in dict.fromkeys(ids or []):
        if i in labels:
            names.append(labels[i])
    if not names:
        return ""
    names.sort(key=str.lower)
    return f'<p class="src"><b>Sumber ({len(names)}):</b> {_t("; ".join(names))}</p>'


def _fmt_date(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone().strftime("%d %B %Y, %H:%M")
    except (ValueError, TypeError):
        return str(value or "-")


def build_html(synthesis, articles, meta):
    s = synthesis or {}
    meta = meta or {}
    arts = [a for a in (articles or []) if isinstance(a, dict)]
    labels = _build_labels(arts)
    cat_ids = [e.get("id") for e in s.get("evidence_catalog") or [] if isinstance(e, dict)]
    count = s.get("included_article_count") or len(cat_ids) or len(arts)
    out = []

    # --- Judul + metadata
    rq = meta.get("research_question") or ""
    rows = [("Research question", rq or s.get("research_question_refinement") or "-"),
            ("Artikel INCLUDE", f"{count} artikel (screening dan full-text eligibility)"),
            ("Dasar data", meta.get("source_name") or "-"),
            ("Tanggal pencarian", meta.get("search_date") or "-"),
            ("Dihasilkan", f"{_fmt_date(s.get('generated_at'))} · model {s.get('model') or '-'}")]
    out.append('<p class="eyebrow">SLR PROTOCOL · SYSTEMATIC LITERATURE REVIEW</p><h1>Review Synthesis</h1>'
               '<p class="sub">Sintesis lintas artikel dari studi yang disetujui manual pada dua tahap seleksi.</p>')
    out.append('<table class="meta">' + "".join(f'<tr><td class="k">{_t(k)}</td><td>{_t(v)}</td></tr>' for k, v in rows) + "</table>")
    out.append('<p class="note">Dokumen ini dihasilkan model bahasa dari data artikel yang sudah diekstraksi. Verifikasi setiap klaim '
               "ke artikel aslinya dan tulis ulang dengan kata sendiri sebelum dikutip dalam tesis atau publikasi. "
               "Rujukan dalam teks ditulis sebagai nama penulis pertama dan tahun; daftar lengkap ada di bagian akhir.</p>")

    # --- Sintesis eksekutif
    out.append("<h2>Sintesis eksekutif</h2>")
    out.append(_paras(s.get("executive_synthesis") or "Tidak ada ringkasan."))
    if s.get("research_question_refinement"):
        out.append(f'<h4>Penajaman research question</h4>{_paras(s["research_question_refinement"])}')
    if s.get("subquestions"):
        out.append("<h4>Subpertanyaan</h4>" + _list(s["subquestions"]))

    # --- Tema utama
    themes = [t for t in s.get("main_themes") or [] if isinstance(t, dict)]
    out.append(f"<h2>1. Tema utama ({len(themes)})</h2>")
    for i, t in enumerate(themes, start=1):
        conf = str(t.get("confidence") or "").strip()
        out.append(f'<div class="theme"><h3>{i}. {_t(t.get("name") or "Tema")}</h3>')
        bits = []
        n_art = len(dict.fromkeys(t.get("article_ids") or []))
        bits.append(f"{n_art} artikel")
        if conf:
            bits.append(f"keyakinan {conf}")
        out.append(f'<p class="tag">{_t(" · ".join(bits).upper())}</p>')
        if t.get("description"):
            out.append(f'<p class="small"><i>{_t(t["description"])}</i></p>')
        body = t.get("deep_synthesis") or t.get("synthesis")
        out.append(_paras(body))
        kfs = [k for k in t.get("key_findings") or [] if isinstance(k, dict) and k.get("finding")]
        if kfs:
            out.append("<h4>Temuan kunci</h4><ul>")
            for k in kfs:
                names = [labels[x] for x in dict.fromkeys(k.get("article_ids") or []) if x in labels]
                cite = f' <span class="small">({_t("; ".join(sorted(names, key=str.lower)))})</span>' if names else ""
                out.append(f"<li>{_t(k['finding'])}{cite}</li>")
            out.append("</ul>")
        if t.get("methodological_patterns"):
            out.append(f'<p><b>Pola metode.</b> {_t(t["methodological_patterns"])}</p>')
        if t.get("evidence_strength"):
            out.append(f'<p><b>Kekuatan bukti.</b> {_t(t["evidence_strength"])}</p>')
        if t.get("open_questions"):
            out.append("<h4>Pertanyaan terbuka</h4>" + _list(t["open_questions"]))
        out.append(_sources(t.get("article_ids"), labels) + "</div>")

    # --- Konsistensi
    agreements = [x for x in s.get("agreements") or [] if isinstance(x, dict)]
    out.append(f"<h2>2. Konsistensi temuan ({len(agreements)})</h2>")
    for x in agreements:
        out.append(f'<div class="item"><h3>{_t(x.get("claim") or "Temuan konsisten")}</h3>'
                   f'{_paras(x.get("interpretation") or x.get("notes"))}{_sources(x.get("article_ids"), labels)}</div>')
    if not agreements:
        out.append('<p class="small">Tidak ada pola konsisten yang dirangkum.</p>')

    # --- Kontradiksi
    contras = [x for x in s.get("contradictions") or [] if isinstance(x, dict)]
    out.append(f"<h2>3. Kontradiksi dan perbedaan temuan ({len(contras)})</h2>")
    for x in contras:
        out.append(f'<div class="item"><h3>{_t(x.get("issue") or "Perbedaan temuan")}</h3>'
                   f'{_paras(x.get("possible_explanation"))}{_sources(x.get("article_ids"), labels)}</div>')
    if not contras:
        out.append('<p class="small">Tidak ada kontradiksi yang dirangkum.</p>')

    # --- Research gaps
    gaps = [x for x in s.get("research_gaps") or [] if isinstance(x, dict)]
    out.append(f"<h2>4. Research gaps ({len(gaps)})</h2>")
    for i, x in enumerate(gaps, start=1):
        out.append(f'<div class="item"><h3><span class="tag">GAP {i:02d}</span> &nbsp;{_t(x.get("gap") or "Research gap")}</h3>'
                   f'{_paras(x.get("evidence"))}')
        if x.get("suggested_next_step"):
            out.append(f'<p><b>Arah penelitian.</b> {_t(x["suggested_next_step"])}</p>')
        out.append(_sources(x.get("article_ids"), labels) + "</div>")
    if not gaps:
        out.append('<p class="small">Tidak ada research gap yang dirangkum.</p>')

    # --- Limitasi + catatan
    out.append("<h2>5. Limitasi korpus</h2>" + (_list(s.get("limitations_of_corpus")) or '<p class="small">Tidak tersedia.</p>'))
    out.append("<h2>6. Catatan verifikasi</h2>" + (_list(s.get("review_notes")) or '<p class="small">Periksa kembali hasil ekstraksi pada artikel asli.</p>'))

    # --- Daftar artikel
    by_id = {a.get("id"): a for a in arts}
    ref_ids = [i for i in cat_ids if i in by_id] or [a.get("id") for a in arts if a.get("id")]
    ref_ids = sorted(dict.fromkeys(ref_ids), key=lambda i: labels.get(i, "").lower())
    out.append(f"<h2>Daftar artikel rujukan ({len(ref_ids)})</h2>")
    out.append('<table class="refs">')
    for i in ref_ids:
        a = by_id[i]
        authors = a.get("authors") if isinstance(a.get("authors"), list) else []
        shown = ", ".join(str(x) for x in authors[:4]) + (" et al." if len(authors) > 4 else "")
        doi = str(a.get("doi") or a.get("doi_detected") or "").strip()
        shown = shown.rstrip(". ")
        out.append(f'<tr><td class="lab">{_t(labels.get(i, ""))}</td><td>{_t(shown + ". " if shown else "")}'
                   f'{_t(a.get("year") or "n.d.")}. <i>{_t(a.get("title") or "Tanpa judul")}</i>.'
                   f'{(" DOI: " + _t(doi)) if doi else ""}</td></tr>')
    out.append("</table>")
    return "".join(out)


def build_pdf(synthesis, articles, meta=None):
    """Return bytes PDF. Raise ValueError bila tidak ada sintesis."""
    if not isinstance(synthesis, dict) or not (synthesis.get("executive_synthesis") or synthesis.get("main_themes")):
        raise ValueError("Belum ada hasil sintesis untuk dijadikan PDF.")
    body = build_html(synthesis, articles, meta)
    story = pymupdf.Story(html=f"<body>{body}</body>", user_css=CSS, em=10)
    mediabox = pymupdf.paper_rect("a4")
    where = mediabox + (56, 66, -56, -62)
    toc = []

    def rectfn(rect_num, filled):
        return mediabox, where, None

    def positionfn(position):
        if position.heading and (position.open_close & 1):
            title = (position.text or "").strip() or "Bagian"
            toc.append([min(position.heading, 3), title[:90], position.page_num])

    buf = io.BytesIO()
    writer = pymupdf.DocumentWriter(buf)
    story.write(writer, rectfn, positionfn)
    writer.close()

    doc = pymupdf.open(stream=buf.getvalue(), filetype="pdf")
    total = doc.page_count
    for number, page in enumerate(doc, start=1):
        w, h = page.rect.width, page.rect.height
        if number > 1:
            page.insert_text((56, 40), "Review Synthesis", fontname="helv", fontsize=8, color=(0.45, 0.45, 0.45))
            page.draw_line((56, 47), (w - 56, 47), color=(0.85, 0.86, 0.89), width=0.6)
        page.draw_line((56, h - 48), (w - 56, h - 48), color=(0.85, 0.86, 0.89), width=0.6)
        page.insert_text((56, h - 34), "SLR Protocol · hasil model bahasa, perlu verifikasi", fontname="helv", fontsize=7.5, color=(0.45, 0.45, 0.45))
        label = f"Halaman {number} / {total}"
        width = pymupdf.get_text_length(label, fontname="helv", fontsize=7.5)
        page.insert_text((w - 56 - width, h - 34), label, fontname="helv", fontsize=7.5, color=(0.45, 0.45, 0.45))
    # bookmark: level pertama harus 1 dan tidak boleh lompat lebih dari satu level
    cleaned, prev = [], 0
    for level, title, page_no in toc:
        level = min(level, prev + 1) if prev else 1
        cleaned.append([level, title, max(1, min(page_no, total))])
        prev = level
    if cleaned:
        doc.set_toc(cleaned)
    doc.set_metadata({"title": "Review Synthesis", "subject": "Systematic literature review", "creator": "SLR Protocol"})
    data = doc.tobytes(garbage=3, deflate=True)
    doc.close()
    return data
