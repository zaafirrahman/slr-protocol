"""Tes gerbang signup + penulisan .env (tanpa jaringan):  python tests/test_user_auth.py"""
import os
import sys
import tempfile
import urllib.error
import io
from pathlib import Path

os.environ["SUPABASE_URL"] = "https://example.supabase.co"
os.environ["SUPABASE_ANON_KEY"] = "sb_publishable_test"
os.environ["USER_API_KEY"] = ""
os.environ.pop("USER_AUTH", None)
os.environ.pop("DEEPSEEK_URL", None)
os.environ.pop("HOST", None)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app as app_module  # noqa: E402
import user_auth  # noqa: E402

ok = fail = 0


def check(cond, msg):
    global ok, fail
    if cond:
        ok += 1
    else:
        fail += 1
        print("GAGAL:", msg)


tmp = Path(tempfile.mkdtemp()) / ".env"
tmp.write_text("# komentar\nDEEPSEEK_MODEL=deepseek-flash\n# USER_API_KEY=\nUSER_API_KEY=\nPORT=5000\n", encoding="utf-8")
user_auth._state["env_file"] = tmp

check(user_auth.enabled(), "mode terkelola aktif")
check(app_module.DEEPSEEK_URL == "https://example.supabase.co/functions/v1/llm-proxy", "AI diarahkan ke proxy")
check(app_module.LLM_PROVIDER == "deepseek", "provider dipaksa deepseek")
check(os.environ.get("HOST") == "127.0.0.1", "HOST default hanya localhost")

c = app_module.app.test_client()
r = c.get("/app")
check(r.status_code == 302 and r.headers["Location"].endswith("/signup"), "halaman dialihkan ke /signup")
r = c.get("/api/analysis-progress")
check(r.status_code == 401, "API ditolak 401 sebelum daftar")
check(c.get("/signup").status_code == 200, "/signup terbuka")
check(c.get("/static/landing.css").status_code == 200, "static tetap terbuka")

# pendaftaran gagal: kode salah
def bad(name, payload):
    raise urllib.error.HTTPError("u", 400, "bad", {}, io.BytesIO(b'{"message":"USERNAME_TAKEN"}'))
user_auth._rpc = bad
r = c.post("/signup", data={"username": "budi"})
check(r.status_code == 400 and "sudah dipakai" in r.get_data(as_text=True), "nama terpakai ditampilkan")
check("USER_API_KEY=\n" in tmp.read_text(encoding="utf-8"), ".env tidak berubah saat gagal")

# pendaftaran sukses
user_auth._rpc = lambda name, payload: "slr_" + "a" * 48
r = c.post("/signup", data={"username": "budi"})
env = tmp.read_text(encoding="utf-8")
check(r.status_code == 302 and r.headers["Location"].endswith("/app"), "sukses -> /app")
check("USER_API_KEY=slr_" + "a" * 48 in env, "key tertulis di .env")
check(env.count("USER_API_KEY=") == 2 and "# USER_API_KEY=" in env, "baris komentar & baris lain utuh")
check("PORT=5000" in env and "DEEPSEEK_MODEL=deepseek-flash" in env, "pengaturan lain tidak hilang")
check(app_module.DEEPSEEK_API_KEY == "slr_" + "a" * 48 and app_module.AI_CONFIGURED, "key aktif tanpa restart")
check(c.get("/app").status_code == 200, "setelah daftar /app terbuka")
check(c.get("/signup").status_code == 302, "/signup mengalihkan bila sudah terdaftar")

# .env tak bisa ditulis -> key ditampilkan
os.environ["USER_API_KEY"] = ""
def boom(*a, **k):
    raise PermissionError("ro")
user_auth.write_env_value = boom
r = c.post("/signup", data={"username": "ani"})
check(r.status_code == 200 and "USER_API_KEY=slr_" in r.get_data(as_text=True), "fallback tampilkan key")

# .env.example menjadi nilai bawaan di mode terkelola; .env pengguna tetap menang
d = Path(tempfile.mkdtemp())
(d / ".env.example").write_text(
    "SUPABASE_URL=https://example.supabase.co\nSUPABASE_ANON_KEY=k\nVAR_BARU=dari-example\nVAR_PUNYA_USER=dari-example\nVAR_KOSONG=\n",
    encoding="utf-8",
)
for k in ("VAR_BARU", "VAR_KOSONG", "VAR_PUNYA_USER"):
    os.environ.pop(k, None)
os.environ["VAR_PUNYA_USER"] = "dari-env-user"
user_auth.prepare_env(d)
check(os.environ.get("VAR_BARU") == "dari-example", "variabel baru di .env.example terbaca")
check(os.environ.get("VAR_PUNYA_USER") == "dari-env-user", ".env pengguna mengalahkan .env.example")
check("VAR_KOSONG" not in os.environ, "nilai kosong tidak dipaksakan")
os.environ["USER_AUTH"] = "off"
os.environ.pop("VAR_BARU", None)
user_auth.prepare_env(d)
check("VAR_BARU" not in os.environ, "USER_AUTH=off: .env.example diabaikan")
os.environ.pop("USER_AUTH", None)

print(f"{ok} lolos, {fail} gagal")
sys.exit(1 if fail else 0)
