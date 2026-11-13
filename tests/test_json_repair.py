"""Tes penyelamat JSON terpotong + taksonomi parsial (tanpa jaringan, tanpa API key):  python tests/test_json_repair.py"""
import json
import os
import sys
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


full = {"taxonomy": {"hierarchical": {"levels": [{"level": 1, "principle": "peran"}], "root": {"id": "root", "name": "PTO"},
        "nodes": [{"id": "h1", "name": "Prediksi", "description": "x", "parent_id": "root", "article_ids": ["a1", "a2"]},
                  {"id": "h2", "name": "Optimasi", "description": "y, dengan koma", "parent_id": "root", "article_ids": ["a3"]}]},
        "flat": [{"name": "k1", "description": "d", "article_ids": ["a1"]}]}}
text = json.dumps(full, ensure_ascii=False)

# 1. JSON utuh tidak berubah
obj, dropped = A.repair_truncated_json(text)
check(obj == full and dropped == 0, "JSON utuh tetap utuh")

# 2. dipotong di berbagai titik: selalu menghasilkan objek valid, dan hierarki yang sudah utuh tidak hilang
survived = 0
for cut in range(60, len(text) - 1, 7):
    try:
        obj, dropped = A.repair_truncated_json(text[:cut])
    except ValueError:
        continue
    check(isinstance(obj, dict), f"hasil dict pada potongan {cut}")
    survived += 1
check(survived > 20, f"sebagian besar potongan terselamatkan ({survived})")

# 3. pola kegagalan nyata: berhenti tepat setelah '}' simpul, array/objek induk belum ditutup
trunc = text[: text.index('{"id": "h2"') - 2] + "}"       # 'nodes' array, 'hierarchical' dan 'taxonomy' terbuka
obj, dropped = A.repair_truncated_json(trunc)
nodes = obj["taxonomy"]["hierarchical"]["nodes"]
check(len(nodes) == 1 and nodes[0]["id"] == "h1", "simpul utuh terakhir tetap ada")
try:
    A.extract_json(trunc)
    check(False, "extract_json lama memang gagal pada pola ini")
except json.JSONDecodeError:
    check(True, "extract_json lama gagal (itu sebabnya perlu penyelamat)")

# 4. terpotong di tengah string / setelah kunci tanpa nilai
for tail in ('{"a": [1, 2, {"b": "teks yang terpo', '{"a": {"k": 1, "z":', '{"a": [1, 2,', '{"a": "x", "b": [{"c": 1}, {"d"'):
    obj, _ = A.repair_truncated_json(tail)
    check(isinstance(obj, dict) and "a" in obj, f"terselamatkan: {tail[-20:]!r}")

# 5. bukan JSON sama sekali
try:
    A.repair_truncated_json("maaf, saya tidak bisa")
    check(False, "teks biasa harus ditolak")
except ValueError:
    check(True, "teks biasa ditolak")

# 6. run_taxonomy: respons terpotong -> status partial dengan hierarki yang bisa dipakai
orig = A.llm_json
try:
    def fake(prompt, **kw):
        obj, dropped = A.repair_truncated_json(trunc)
        obj["_salvaged"] = dropped
        return obj
    A.llm_json = fake
    compact = [{"id": i, "title": i, "year": 2024} for i in ("a1", "a2", "a3")]
    res = A.run_taxonomy(compact, [], [], "rq", A.new_usage())
    check(res["taxonomy_status"] == "partial" and res["taxonomy_note"], "status partial + catatan")
    check(res["taxonomy_coverage"]["covered"] == 2, "cakupan dihitung dari bagian yang selamat")

    def boom(prompt, **kw):
        raise RuntimeError("model mati")
    A.llm_json = boom
    res = A.run_taxonomy(compact, [], [], "rq", A.new_usage())
    check(res["taxonomy_status"] == "failed" and "model mati" in res["taxonomy_error"], "gagal total tetap rapi")
finally:
    A.llm_json = orig

# 7. rute /api/taxonomy menolak data kosong
c = A.app.test_client()
r = c.post("/api/taxonomy", json={"articles": []})
check(r.status_code in (400, 503), "rute /api/taxonomy menolak tanpa artikel INCLUDE")

print(f"{ok} lulus, {fail} gagal")
sys.exit(1 if fail else 0)