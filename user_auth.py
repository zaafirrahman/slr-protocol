"""Login mandiri + API key per pengguna (Supabase).

Mode terkelola aktif bila SUPABASE_URL dan SUPABASE_ANON_KEY terisi (dan USER_AUTH bukan "off").
Di mode ini:
  - AI selalu lewat proxy (Edge Function llm-proxy); key DeepSeek admin tidak ada di laptop pengguna.
  - Selama USER_API_KEY di .env kosong, semua halaman dialihkan ke /signup.
  - /signup mendaftar ke Supabase, lalu menulis USER_API_KEY ke .env lokal.
Tanpa SUPABASE_URL (atau USER_AUTH=off) modul ini tidak melakukan apa-apa.
"""
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

from dotenv import dotenv_values
from flask import redirect, render_template, request

# Nilai tidak rahasia yang ikut git pull lewat .env.example, sehingga pembaruan URL sampai ke semua pengguna.
SHARED_KEYS = ("SUPABASE_URL", "SUPABASE_ANON_KEY")
OPEN_PREFIXES = ("/signup", "/static/", "/api/health")

_state = {"env_file": None, "on_new_key": None}

ERRORS = {
    "USERNAME_INVALID": "Nama pengguna harus 3–60 karakter.",
    "USERNAME_TAKEN": "Nama pengguna itu sudah dipakai. Coba yang lain.",
}


def _cfg(name):
    return os.getenv(name, "").strip()


def enabled():
    if _cfg("USER_AUTH").lower() in ("off", "0", "false", "no"):
        return False
    return bool(_cfg("SUPABASE_URL") and _cfg("SUPABASE_ANON_KEY"))


def prepare_env(base_dir):
    """Panggil SEBELUM konstanta provider dibaca.

    Mode terkelola: semua nilai di .env.example menjadi nilai bawaan (ikut git pull), dan .env pengguna
    hanya perlu berisi USER_API_KEY. Baris yang ditulis pengguna sendiri di .env tetap menang.
    """
    example = dotenv_values(Path(base_dir) / ".env.example")
    for name in SHARED_KEYS:  # cukup untuk menentukan apakah mode terkelola aktif
        if example.get(name) and not os.getenv(name):
            os.environ[name] = example[name].strip()
    if not enabled():
        return  # mode lama / USER_AUTH=off: .env.example diabaikan, perilaku seperti sebelumnya
    for name, value in example.items():
        if value and name not in os.environ:
            os.environ[name] = value.strip()
    os.environ["LLM_PROVIDER"] = "deepseek"
    os.environ.setdefault("HOST", "127.0.0.1")  # hanya bisa dibuka dari laptop ini, bukan dari jaringan Wi-Fi
    if not _cfg("DEEPSEEK_URL"):
        os.environ["DEEPSEEK_URL"] = _cfg("SUPABASE_URL").rstrip("/") + "/functions/v1/llm-proxy"
    os.environ["DEEPSEEK_API_KEY"] = _cfg("USER_API_KEY")  # bearer ke proxy = key milik pengguna ini


def write_env_value(path, name, value):
    """Ubah/tambah satu baris NAME=value di .env tanpa menyentuh baris lain."""
    path = Path(path)
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    pattern = re.compile(rf"^\s*{re.escape(name)}\s*=")
    out, done = [], False
    for line in lines:
        if pattern.match(line):
            if not done:
                out.append(f"{name}={value}")
                done = True
        else:
            out.append(line)
    if not done:
        out.append(f"{name}={value}")
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text("\n".join(out) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _rpc(name, payload):
    anon = _cfg("SUPABASE_ANON_KEY")
    headers = {"apikey": anon, "Content-Type": "application/json"}
    if anon.startswith("eyJ"):  # key gaya lama berupa JWT; key "publishable" baru cukup lewat header apikey
        headers["Authorization"] = f"Bearer {anon}"
    req = urllib.request.Request(
        f"{_cfg('SUPABASE_URL').rstrip('/')}/rest/v1/rpc/{name}",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def register(username):
    """Kembalikan (key, pesan_error). Tepat salah satunya None."""
    try:
        key = _rpc("register_user", {"p_username": username})
    except urllib.error.HTTPError as exc:
        try:
            message = json.loads(exc.read().decode("utf-8")).get("message", "")
        except Exception:
            message = ""
        return None, ERRORS.get(message, f"Pendaftaran ditolak server (HTTP {exc.code}).")
    except (urllib.error.URLError, TimeoutError):
        return None, "Tidak bisa terhubung ke server. Cek koneksi internet lalu coba lagi."
    if not isinstance(key, str) or not key.startswith("slr_"):
        return None, "Respons server tidak dikenali. Hubungi admin."
    return key, None


def init(app, env_file, on_new_key=None):
    _state["env_file"] = Path(env_file)
    _state["on_new_key"] = on_new_key

    @app.before_request
    def _gate():
        if not enabled() or _cfg("USER_API_KEY"):
            return None
        path = request.path
        if path.startswith(OPEN_PREFIXES):
            return None
        if path.startswith("/api/"):
            return {"error": "Belum terdaftar. Buka halaman /signup dulu."}, 401
        return redirect("/signup")

    @app.get("/signup")
    def signup_form():
        if not enabled() or _cfg("USER_API_KEY"):
            return redirect("/app")
        return render_template("signup.html", error=None, username="", manual_key=None)

    @app.post("/signup")
    def signup_submit():
        if not enabled() or _cfg("USER_API_KEY"):
            return redirect("/app")
        username = (request.form.get("username") or "").strip()
        key, error = register(username)
        if error:
            return render_template("signup.html", error=error, username=username, manual_key=None), 400
        os.environ["USER_API_KEY"] = key
        os.environ["DEEPSEEK_API_KEY"] = key
        if _state["on_new_key"]:
            _state["on_new_key"](key)
        try:
            write_env_value(_state["env_file"], "USER_API_KEY", key)
        except OSError:
            # Akun sudah terbuat tapi .env tak bisa ditulis: tampilkan key supaya bisa ditempel manual.
            return render_template("signup.html", error=None, username=username, manual_key=key)
        return redirect("/app")
