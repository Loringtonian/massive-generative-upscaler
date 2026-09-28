#!/bin/bash
# Deploy the site to Cloudflare Pages.
# Pages gets the page + zoom tiles; the JPEG and TIFF are served from R2 by functions/files/.
# Usage: CLOUDFLARE_API_TOKEN=... ./deploy.sh [branch]
#   branch defaults to "preview" (a private preview address); "main" = production.
#   PAGES_PROJECT overrides the project name from wrangler.toml.
set -euo pipefail
cd "$(dirname "$0")"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (never commit it)}"
PROJECT="${PAGES_PROJECT:-$(sed -n 's/^name *= *"\(.*\)"/\1/p' wrangler.toml)}"
OUT=$(mktemp -d "${TMPDIR:-/tmp}/site-deploy.XXXXXX")
rsync -a --exclude files/ dist/ "$OUT/"
npx -y wrangler@4 pages deploy "$OUT" --project-name "$PROJECT" --branch "${1:-preview}" --commit-dirty=true
echo "deployed from $OUT"
