"""Check tracked export files, without reading the operator's runtime data."""
import os
from pathlib import Path
import re
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
files = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
if not any(files):
    sys.exit("No tracked files: stage the intended export before checking.")
forbidden = {"auth.json", "settings.json", "codex-pool.json", ".env", ".DS_Store"}
private_terms = [term.casefold() for term in os.environ.get("PRIVACY_FORBIDDEN_TERMS", "").split(",") if term]
errors = []
for name in filter(None, files):
    path = root / name
    if path.is_symlink():
        errors.append(f"{name}: symlink is not allowed in the export")
        continue
    if path.name in forbidden or any(p in {"node_modules", "__pycache__", ".pi", ".local"} for p in path.parts) or path.suffix in {".jsonl", ".db", ".sqlite", ".log", ".pyc"}:
        errors.append(f"{name}: runtime/private artifact")
    data = path.read_text(encoding="utf-8")
    if any(term in data.casefold() for term in private_terms):
        errors.append(f"{name}: private identifier found (value redacted)")
    for match in re.finditer(r"/(?:Users|home)/([^/\\s'\"\\x60]+)", data):
        if match.group(1) not in {"x", "user", "test", "example", "<user>", "alice"}:
            errors.append(f"{name}: non-example home directory")
    if re.search(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", data) and "/tests/" not in "/" + name:
        errors.append(f"{name}: private-key marker")
if errors:
    sys.exit("\n".join(errors))
print(f"Privacy structure/identifier check passed: {sum(bool(f) for f in files)} tracked files")
