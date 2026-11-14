"""Tes ekspor proyek sebagai HTML mandiri (tanpa jaringan, tanpa API key):  python tests/test_export_html.py [proyek.json]
Memeriksa: rute /api/export-html, kerapian HTML (script seimbang, tanpa sumber luar, tanpa tag Jinja tersisa),
data tertanam sama dengan data proyek, dan (bila node tersedia) setiap <script> inline lolos pemeriksaan sintaks."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["USER_AUTH"] = "off"
import app as A  # noqa: E402

ok = fail = 0


def check(cond, msg):
    global ok, fail
    if cond:
        ok += 1
    else:
        fail += 1
        print("GAGAL:", msg)


def design_ids(state):
    scope = (state.get("designUi") or {}).get("scope", "notexcluded")
    out = []
    for a in state["articles"]:
        if a.get("extraction_status") == "failed":
            continue
        inc = a.get("screening_decision") == "include" and a.get("eligibility_decision") == "include"
        ex = a.get("screening_decision") == "exclude" or a.get("eligibility_decision") == "exclude"
        if scope == "all" or (scope == "included" and inc) or (scope not in ("all", "included") and not ex):
            out.append(a["id"])
    return out


sample = sys.argv[1] if len(sys.argv) > 1 else None
if sample:
    state = json.loads(Path(sample).read_text(encoding="utf-8"))
else:  # proyek mini sintetis: dua artikel, satu mengandung teks yang mencoba menutup <script>
    state = {"articles": [
        {"id": "a1", "title": "Judul </script><script>alert(1)</script> & 'uji'", "year": "2025", "extraction_status": "ok",
         "screening_decision": "include", "eligibility_decision": "include", "topic_tags": ["x", "y"], "relationships": []},
        {"id": "a2", "title": "Artikel dua", "year": "2024", "extraction_status": "ok", "screening_decision": "include", "eligibility_decision": "include"}],
        "meta": {"research_question": "RQ uji"}, "designUi": {"topic": "Topik uji", "scope": "notexcluded"}, "norm": {"draft": None, "approved": None}}

c = A.app.test_client()
r = c.post("/api/export-html", json={"state": state, "design": {"article_ids": design_ids(state), "topic": (state.get("designUi") or {}).get("topic", "")}})
check(r.status_code == 200 and r.mimetype == "text/html", f"rute mengembalikan HTML (status {r.status_code})")
html = r.get_data(as_text=True)
check(len(html) > 200_000, f"berkas memuat aplikasi + data ({len(html):,} karakter)")

# kerapian
check("{{" not in html and "{%" not in html, "tidak ada tag Jinja tersisa")
from html.parser import HTMLParser


class _Count(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = 0
        self.styles = 0

    def handle_starttag(self, tag, attrs):
        self.scripts += tag == "script"
        self.styles += tag == "style"


_c = _Count()
_c.feed(html)
check(_c.scripts == 2 and html.count("</script>") == 2, f"tepat dua elemen <script> (data + aplikasi), tidak ada penutupan dini: {_c.scripts}")
markup = re.sub(r"<script>.*?</script>", "", html, flags=re.S)   # periksa markup di luar kode
check("Content-Security-Policy" in html and "connect-src 'none'" in html, "CSP terpasang (tanpa jaringan)")
check("fonts.googleapis" not in html and "@import" not in html, "tanpa font web / @import")
ext = [u for u in re.findall(r'(?:src|href)="(https?://[^"]+)"', markup) if "doi.org" not in u and "github.com" not in u and "youtube.com" not in u]
check(not ext, f"tanpa sumber eksternal yang dimuat otomatis: {ext[:3]}")
check(not re.search(r'<(?:script|link|img)[^>]+(?:src|href)="/static', markup), "tidak ada rujukan /static di markup")
check("latte0nim.jpg" not in html and "feinstehaar.jpg" not in html, "avatar kredit tidak ikut (hemat ukuran)")

# data tertanam
m = re.search(r"window\.__SLR_VIEWER__=(\{.*?\});</script>", html, re.S)
check(bool(m), "payload __SLR_VIEWER__ ditemukan")
payload = json.loads(m.group(1)) if m else {}
check(payload.get("state", {}).get("articles") == state["articles"], "artikel tertanam sama dengan data proyek")
check(bool(payload.get("codebook", {}).get("fields")), "codebook tertanam")
ids = design_ids(state)
check((payload.get("design") is None) == (not ids), "pohon desain riset tertanam sesuai cakupan")
if payload.get("design"):
    check(payload["design"].get("n_with_design", 0) >= 0 and "tree" in payload["design"], "pohon desain riset memuat tree")
check("<script>alert(1)" not in html, "teks artikel yang berisi <script> tidak lolos sebagai kode")

# sintaks setiap script inline
node = shutil.which("node")
if node:
    scripts = re.findall(r"<script>(.*?)</script>", html, re.S)
    check(len(scripts) == 2, f"dua script inline (data + aplikasi), ditemukan {len(scripts)}")
    for i, code in enumerate(scripts):
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
            f.write(code)
        res = subprocess.run([node, "--check", f.name], capture_output=True, text=True)
        os.unlink(f.name)
        check(res.returncode == 0, f"script inline {i} lolos node --check: {res.stderr[:200]}")

# permintaan tidak valid
check(c.post("/api/export-html", json={"state": {}}).status_code == 400, "state tanpa artikel ditolak (400)")
check(c.post("/api/export-html", json={}).status_code == 400, "badan kosong ditolak (400)")

if len(sys.argv) > 2:
    Path(sys.argv[2]).write_text(html, encoding="utf-8")
    print("HTML ditulis ke", sys.argv[2])
print(f"{ok} lulus, {fail} gagal")
sys.exit(1 if fail else 0)
