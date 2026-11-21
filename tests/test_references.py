"""Tes pembacaan daftar pustaka (untuk citation graph):  python tests/test_references.py
Memakai daftar pustaka rekaan bergaya Elsevier (author-year, baris terpotong, DOI terpotong, kepala halaman menyelip),
gaya bernomor [1], dan nama organisasi sebagai penulis."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["USER_AUTH"] = "off"
import app  # noqa: E402

ok = fail = 0


def check(msg, cond):
    global ok, fail
    if cond:
        ok += 1
    else:
        fail += 1
        print("GAGAL:", msg)


ELSEVIER = """Isi artikel sebelum dapus. [PAGE 1]
Pendahuluan yang cukup panjang supaya heading References berada setelah 35% teks dokumen ini. """ * 30 + """
References
Alpha, A.B., Beta, C., 2021. A study of widget routing under demand uncertainty. J. Fake Oper. Res. 12 (3), 45–67.
https://doi.org/10.1016/j.fake.2021.
100045
Gamma, D., Delta, E.F., Epsilon, G., Zeta, H.,
2019. Learning to rank gadgets with pairwise losses. Transp. Res. Part Z
Emerging Technol. 99 104717.
[PAGE 22]
Y. Fiktif et al.
Transportation Research Part Z 206 (2026) 103411
22
Van der Berg, K., 2020. Hierarchical control of gadget fleets. In: Proceedings of the Fake Conference, pp. 1–8.
Food and Agriculture Organization of the United Nations, 2022. State of food security and nutrition in the world.
Eta, I., Theta, J., 2018. Smart “predict, then optimize”. Manage. Sci. 68 (1) 9–26. https://doi.org/
10.1287/mnsc.2020.3922
Iota, K., 2017a. Alpha and omega of inventory. Fiktif Press.
Iota, K., 2017b. Alpha and omega of inventory, part two. Fiktif Press.
"""
pages = [(n, "Y. Fiktif et al.\nTransportation Research Part Z 206 (2026) 103411\nisi\n" + str(n)) for n in (20, 21, 22, 23)]

body, tail = app.split_references(ELSEVIER)
check("split_references memisahkan isi dan dapus", body.endswith("heading References berada setelah 35% teks dokumen ini.") and tail.lstrip().startswith("Alpha"))
check("strip_references tetap kompatibel", app.strip_references(ELSEVIER) == (body, True))
check("tanpa heading: dapus kosong", app.split_references("tanpa dapus sama sekali") == ("tanpa dapus sama sekali", ""))

refs = app.parse_references(tail, pages)
by_author = {r["a"]: r for r in refs}
check("7 entri terbaca (kepala halaman tidak jadi entri)", len(refs) == 7)
check("entri bergaya Elsevier: tahun, penulis pertama, judul", by_author["Alpha"]["y"] == "2021" and by_author["Alpha"]["t"].startswith("A study of widget routing"))
check("DOI yang terpotong di akhir baris tersambung kembali", by_author["Alpha"]["d"] == "10.1016/j.fake.2021.100045")
check("author wrap antar baris tidak memecah entri", by_author["Gamma"]["t"].startswith("Learning to rank gadgets") and by_author["Gamma"]["y"] == "2019")
check("kepala halaman berulang tidak menempel di entri", "Fiktif et al" not in by_author["Gamma"]["r"] and "103411" not in by_author["Gamma"]["r"])
check("nama dengan partikel (Van der Berg)", any(r["a"].startswith("Van der Berg") for r in refs))
check("penulis organisasi dipisah sebagai entri sendiri", any(r["a"].startswith("Food and Agriculture") and r["y"] == "2022" for r in refs))
check("DOI yang terpotong setelah 'doi.org/' tersambung", by_author["Eta"]["d"] == "10.1287/mnsc.2020.3922")
check("judul dengan tanda kutip sebagian (Elsevier) tidak terpotong salah", by_author["Eta"]["t"].startswith("Smart") and "optimize" in by_author["Eta"]["t"])
check("sufiks tahun a/b dipertahankan", sorted(r["y"] for r in refs if r["a"] == "Iota") == ["2017a", "2017b"])
check("teks mentah dipotong sesuai batas", all(len(r["r"]) <= app.REF_RAW_CHARS for r in refs))

NUMBERED = "References\n" + "\n".join(f"[{i}] A. Writer, B. Coauthor, \"Title number {i} of a fictional paper,\" Fake J., vol. {i}, pp. 1-9, 20{10+i}." for i in range(1, 8))
nb = app.parse_references(app.split_references("x" * 400 + "\n" + NUMBERED)[1])
check("gaya bernomor [n]: 7 entri", len(nb) == 7)
check("gaya IEEE: nama belakang diambil dari 'A. Writer'", nb[0]["a"] == "Writer" and nb[0]["t"].startswith("Title number 1"))

check("detect_article_doi dari halaman pertama", app.detect_article_doi([(1, "Judul\nhttps://doi.org/10.1016/j.trb.2026.103411\nReceived 1 Jan")]) == "10.1016/j.trb.2026.103411")
check("detect_article_doi: tidak ada DOI -> kosong", app.detect_article_doi([(1, "tanpa doi")]) == "")
check("parse_references: teks kosong aman", app.parse_references("") == [] and app.parse_references(None) == [])
check("ANALYSIS_VERSION >= 7", app.ANALYSIS_VERSION >= 7)

print(f"\n{ok} lulus, {fail} gagal")
sys.exit(1 if fail else 0)
