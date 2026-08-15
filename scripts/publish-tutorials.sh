#!/usr/bin/env bash
# Publish the tutorials to a local serving directory.
#
# The repo is the source of truth; this only ever COPIES OUT. Nothing edits ~/www by hand, because a served
# copy that drifts from the repo is worse than no served copy — you end up reading a stale page and trusting
# it. Re-run after any tutorial change.
#
#   ./scripts/publish-tutorials.sh              -> ~/www
#   ./scripts/publish-tutorials.sh /some/dir    -> /some/dir
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$HOME/www}"
mkdir -p "$DEST/tutorials"
cp "$HERE"/docs/tutorials/*.html "$DEST/tutorials/"
cp "$HERE"/docs/tutorials/index.html "$DEST/tutorials/index.html" 2>/dev/null || true
# The landing page is generated, so it cannot fall out of step with what was actually copied.
"$HERE"/scripts/tutorial-index.sh "$DEST/tutorials" > "$DEST/tutorials/index.html"
echo "published to $DEST/tutorials"
echo
echo "serve it with either:"
echo "  python3 -m http.server 8080 --directory $DEST     # then http://127.0.0.1:8080/tutorials/"
echo "  cd $DEST && npx --yes serve -l 8080"
