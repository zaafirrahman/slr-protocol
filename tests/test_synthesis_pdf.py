"""Tes PDF Review Synthesis (tanpa jaringan, tanpa AI):  python tests/test_synthesis_pdf.py"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["USER_AUTH"] = "off"
import pymupdf  # noqa: E402
import synthesis_pdf as P  # noqa: E402
import app as A  # noqa: E402

ok = fail = 0
def check(c, m):
    global ok, fail
    if c: ok += 1
    else: fail += 1; print("GAGAL:", m)

arts = [{"id": f"id{i}", "title": f"Judul <b>{i}</b> & tes", "year": "2024", "authors": ["Alan Dávila de León", "B. Kedua"], "doi": f"10.1/x{i}"} for i in range(1, 4)]
arts[2]["authors"] = ["Alan Dávila de León"]; arts[2]["year"] = "2024"
syn = {"executive_synthesis": "Paragraf satu ≈ 5% → naik.\n\nParagraf dua <script>x</script>.",
       "generated_at": "2026-11-25T04:04:11+00:00", "model": "m", "included_article_count": 3,
       "evidence_catalog": [{"id": a["id"]} for a in arts],
       "main_themes": [{"name": "Tema <A>", "confidence": "tinggi", "synthesis": "s", "deep_synthesis": "d1\n\nd2",
                        "article_ids": ["id1", "id2", "id9"], "key_findings": [{"finding": "f", "article_ids": ["id1"]}],
                        "open_questions": ["q"], "methodological_patterns": "mp", "evidence_strength": "es"}],
       "agreements": [{"claim": "c", "interpretation": "i", "article_ids": ["id1"]}],
       "contradictions": [], "research_gaps": [{"gap": "g", "evidence": "e", "suggested_next_step": "n", "article_ids": ["id1", "id2"]}],
       "limitations_of_corpus": ["l"], "review_notes": ["r"]}
pdf = P.build_pdf(syn, arts, {"research_question": "RQ?", "source_name": "Scopus", "search_date": "2026-11-23"})
check(pdf[:5] == b"%PDF-", "keluaran adalah PDF")
doc = pymupdf.open(stream=pdf, filetype="pdf")
text = "".join(p.get_text() for p in doc)
check("Review Synthesis" in text and "Research gaps" in text and "Daftar artikel rujukan" in text, "bagian utama ada")
check("<script>" in text and "Tema <A>" in text, "HTML di-escape (tampil sebagai teks)")
check("Judul <b>1</b> & tes" in text, "judul artikel di-escape")
check("Dávila" in text, "diakritik Latin tampil")
check("Halaman 1 /" in text, "nomor halaman ada")
check(doc.get_toc(), "bookmark ada")
check("2024a" in text and "2024b" in text, "label kembar diberi akhiran a/b")
check("id9" not in text, "ID tak dikenal tidak bocor ke PDF")
for bad in (None, {}, {"executive_synthesis": ""}, "x"):
    try: P.build_pdf(bad, arts); check(False, f"ValueError untuk {bad!r}")
    except ValueError: check(True, "")
big = dict(syn, main_themes=[dict(syn["main_themes"][0], name=f"Tema {i}", deep_synthesis="kalimat panjang " * 400) for i in range(12)])
check(pymupdf.open(stream=P.build_pdf(big, arts), filetype="pdf").page_count > 5, "dokumen panjang beberapa halaman")

c = A.app.test_client()
r = c.post("/api/synthesis-pdf", json={"synthesis": syn, "articles": arts, "meta": {}})
check(r.status_code == 200 and r.mimetype == "application/pdf" and r.data[:5] == b"%PDF-", "endpoint mengembalikan PDF")
check("attachment" in r.headers.get("Content-Disposition", "") and ".pdf" in r.headers.get("Content-Disposition", ""), "header unduhan")
r = c.post("/api/synthesis-pdf", json={"synthesis": {}})
check(r.status_code == 400 and "error" in r.get_json(), "sintesis kosong -> 400")
r = c.post("/api/synthesis-pdf", data="bukan json", content_type="text/plain")
check(r.status_code == 400, "body bukan JSON -> 400")

print(f"\n{ok} lulus, {fail} gagal")
sys.exit(1 if fail else 0)
