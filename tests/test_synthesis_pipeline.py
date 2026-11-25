"""Tes alur sintesis (tanpa jaringan, LLM ditiru):  python tests/test_synthesis_pipeline.py
Memeriksa: alias ID pendek (ID asli tidak bocor ke prompt), research_gaps terisi, cek cakupan menempatkan
artikel yang terlewat, sintesis mendalam per tema, dan ID kembali ke ID asli."""
import json, os, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["USER_AUTH"] = "off"; os.environ["LLM_PROVIDER"] = "deepseek"; os.environ["DEEPSEEK_API_KEY"] = "x"
import app as A  # noqa: E402

ok = fail = 0
def check(c, m):
    global ok, fail
    if c: ok += 1
    else: fail += 1; print("GAGAL:", m)

N = 37
arts = [{"id": f"{i:016x}", "title": f"Judul {i}", "year": "2024", "abstract": "abs", "findings": [f"temuan {i}"],
         "future_research": [f"riset lanjutan {i}"], "limitations": [f"batas {i}"],
         "screening_decision": "include", "eligibility_decision": "include"} for i in range(1, N + 1)]
real_ids = {a["id"] for a in arts}
prompts, labels = [], []

def aliases(prompt):
    return list(dict.fromkeys(re.findall(r'"id": "(A\d+)"', prompt)))

def fake(prompt, max_output_tokens=0, usage=None, progress=None, label="", salvage=False):
    labels.append(label); prompts.append(prompt)
    ids = aliases(prompt)
    if label.startswith("Batch"):
        return {"batch_overview": "x", "gaps": [{"gap": "g", "evidence": "e", "article_ids": ids[:2]}],
                "themes": [{"name": "t", "synthesis": "s", "article_ids": ids[:2]}]}
    if "1/2" in label:   # tema hanya mengutip 10 artikel pertama
        return {"research_question_refinement": "rq", "subquestions": ["q"], "executive_synthesis": "es",
                "main_themes": [{"name": "Tema A", "description": "d", "synthesis": "s", "article_ids": ["A1", "A2", "A3", "A4", "A5"]},
                                {"name": "Tema B", "description": "d", "synthesis": "s", "article_ids": ["A6", "A7", "A8", "A9", "A10", "A999"]}]}
    if "2/2" in label:
        return {"research_gaps": [{"gap": "G", "evidence": "E", "article_ids": ["A1", "A2"], "suggested_next_step": "n"}],
                "agreements": [], "contradictions": [], "limitations_of_corpus": ["l"], "review_notes": ["r"]}
    if label.startswith("Cek cakupan"):
        missing = aliases(prompt.split("ARTIKEL YANG BELUM TERKUTIP:")[1])
        return {"assignments": [{"article_id": m, "theme": "tema a", "note": "n"} for m in missing[:10]],
                "new_themes": [{"name": "Tema Baru", "description": "d", "synthesis": "s", "article_ids": missing[10:]}]}
    if label.startswith("Tema"):
        return {"deep_synthesis": "p1\n\np2", "key_findings": [{"finding": "f", "article_ids": ids[:2]}],
                "methodological_patterns": "m", "evidence_strength": "e", "open_questions": ["o"]}
    return {}

A.llm_json = fake
A.run_taxonomy = lambda *a, **k: {"taxonomy": A.empty_taxonomy(), "taxonomy_status": "ok"}
A.AI_CONFIGURED = True
r = A.app.test_client().post("/api/synthesize", json={"articles": arts, "research_question": "rq", "inclusion": "i", "exclusion": "e"})
check(r.status_code == 200, f"status 200 (dapat {r.status_code} {r.get_data(as_text=True)[:200]})")
s = (r.get_json() or {}).get("synthesis", {})

check(not any(re.search(r"[0-9a-f]{16}", p) for p in prompts), "ID asli tidak muncul di prompt manapun")
check(s.get("research_gaps"), "research_gaps terisi")
check(s.get("limitations_of_corpus") and s.get("review_notes"), "limitations + review_notes terisi")
cited = set()
for sec in ("main_themes", "agreements", "contradictions", "research_gaps"):
    for x in s.get(sec, []):
        cited |= set(x.get("article_ids", []))
check(cited <= real_ids, "semua article_ids kembali ke ID asli yang valid")
check(real_ids <= cited, f"semua artikel terkutip setelah cek cakupan ({len(cited & real_ids)}/{N})")
check(any(l.startswith("Cek cakupan") for l in labels), "panggilan cek cakupan dipakai")
check(any(t["name"] == "Tema Baru" for t in s.get("main_themes", [])), "tema baru dari cakupan ditambahkan")
check(all(t.get("deep_synthesis") for t in s.get("main_themes", [])), "tiap tema punya sintesis mendalam")
check(all(set(k["article_ids"]) <= real_ids for t in s.get("main_themes", []) for k in t.get("key_findings", [])), "key_findings memakai ID asli")
check({e["id"] for e in s.get("evidence_catalog", [])} == real_ids, "evidence_catalog memakai ID asli")
check(not any("A999" in json.dumps(s) for _ in [0]), "ID rekaan dibuang")

# bila model sudah mengutip semuanya, cek cakupan dilewati
labels.clear()
def fake_full(prompt, **kw):
    out = fake(prompt, **kw)
    if "1/2" in kw.get("label", ""):
        out["main_themes"][0]["article_ids"] = [f"A{i}" for i in range(1, N + 1)]
    return out
A.llm_json = lambda prompt, **kw: fake_full(prompt, **kw)
A.app.test_client().post("/api/synthesize", json={"articles": arts})
check(not any(l.startswith("Cek cakupan") for l in labels), "cek cakupan dilewati bila semua sudah terkutip")

print(f"\n{ok} lulus, {fail} gagal")
sys.exit(1 if fail else 0)
