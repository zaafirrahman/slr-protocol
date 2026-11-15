"""Tes rute halaman (tanpa jaringan, tanpa API key):  python tests/test_routes.py"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["USER_AUTH"] = "off"  # tes rute tidak lewat gerbang signup
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
land = r.data.decode("utf-8")
check(land.count('class="slide"') == 8 and land.count('class="tour-dot"') == 8, "landing: 8 slide tur dan 8 titik navigasi")
check(all(f'id="{i}"' in land for i in ("tur", "fitur", "alur", "faq", "tour")) and all(f'href="#{i}"' in land for i in ("tur", "fitur", "alur", "faq")), "landing: tautan navigasi punya tujuan")
check(land.count("<svg") == 8 and "{{" not in land, "landing: 8 ilustrasi SVG inline, tidak ada tag Jinja tersisa")
check(all(k in land for k in ("Co-occurrence", "System Map", "PRISMA", "Peta Topik", "HTML interaktif")), "landing: SLR lanjutan dan ekspor HTML disebut")
r = c.get("/app")
html = r.data.decode("utf-8")
check(r.status_code == 200 and 'id="overview"' in html, "/app = workspace")
check('class="page-section active-section"' not in html.replace('id="overview" class="page-section active-section"', ""), "hanya Ikhtisar yang aktif di awal")
for tab in ("arah-riset", "design-diagram", "overview", "articles", "design", "prisma", "synthesis", "taxonomy", "cooccurrence", "system-map"):
    check(f'data-target="{tab}"' in html and f'id="{tab}"' in html, f"tab {tab}: tombol dan section")
check('<a href="/" class="brand"' in html and 'aria-label="SLR Protocol beranda"' in html, "logo SLR di sidebar menaut ke beranda (/); teks 'Beranda' memang sudah dihapus")
check(c.get("/static/landing.css").status_code == 200, "landing.css terlayani")
print(f"{ok} lolos, {fail} gagal")
sys.exit(1 if fail else 0)