"""Tes rute halaman (tanpa jaringan, tanpa API key):  python tests/test_routes.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import app  # noqa: E402

ok = fail = 0


def check(cond, msg):
    global ok, fail
    if cond:
        ok += 1
    else:
        fail += 1
        print("GAGAL:", msg)


c = app.test_client()
r = c.get("/")
check(r.status_code == 200 and b"landing.css" in r.data and b'href="/app"' in r.data, "/ = landing dengan tombol ke /app")
check(b'id="overview"' not in r.data, "/ bukan workspace")
r = c.get("/app")
html = r.data.decode("utf-8")
check(r.status_code == 200 and 'id="overview"' in html, "/app = workspace")
check('class="page-section active-section"' not in html.replace('id="overview" class="page-section active-section"', ""), "hanya Ikhtisar yang aktif di awal")
for tab in ("arah-riset", "design-diagram", "overview", "articles", "design", "prisma", "synthesis", "taxonomy", "cooccurrence", "system-map"):
    check(f'data-target="{tab}"' in html and f'id="{tab}"' in html, f"tab {tab}: tombol dan section")
check('href="/"' in html and "Beranda" in html, "tautan Beranda di sidebar")
check(c.get("/static/landing.css").status_code == 200, "landing.css terlayani")
print(f"{ok} lolos, {fail} gagal")
sys.exit(1 if fail else 0)
