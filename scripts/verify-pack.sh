#!/usr/bin/env bash
# Publish gate (run before any `npm publish`):
#   1. the build must exit 0,
#   2. the would-be tarball must contain dist/cli.js and NO tests/.env/*.sqlite/config/src,
#   3. the globally-installed binary must actually run (`cardwright --version`).
# This is the committed, repeatable form of the eng-review VERIFY GATE (no CI needed).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> npm run build (must exit 0)"
npm run build

echo "==> npm pack --dry-run (tarball contents must be clean)"
npm pack --dry-run --json | node -e '
  let data = "";
  process.stdin.on("data", (c) => (data += c));
  process.stdin.on("end", () => {
    const files = JSON.parse(data)[0].files.map((f) => f.path);
    const bad = files.filter((p) =>
      /\.test\.js$/.test(p) ||
      /(^|\/)\.env/.test(p) ||
      /\.sqlite/.test(p) ||
      /cardwright\.config\.json$/.test(p) ||
      /^src\//.test(p));
    if (bad.length) {
      console.error("FAIL — these must not ship:\n  " + bad.join("\n  "));
      process.exit(1);
    }
    if (!files.includes("dist/cli.js")) {
      console.error("FAIL — dist/cli.js missing from tarball");
      process.exit(1);
    }
    console.error("ok — " + files.length + " files; dist/cli.js present; no tests/.env/sqlite/config/src");
  });
'

echo "==> pack + global-install + binary smoke"
TARBALL="$(npm pack --silent)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$ROOT/$TARBALL"' EXIT
npm install -g --prefix "$TMP" "$ROOT/$TARBALL" >/dev/null 2>&1
VER="$("$TMP/bin/cardwright" --version)"
EXPECTED="$(node -p "require('$ROOT/package.json').version")"
echo "    cardwright --version -> $VER (expected $EXPECTED)"
[ "$VER" = "$EXPECTED" ] || { echo "FAIL — version mismatch (bin did not run or drifted)"; exit 1; }
"$TMP/bin/cardwright" --help >/dev/null || { echo "FAIL — --help did not run"; exit 1; }

echo "==> VERIFY-PACK OK"
