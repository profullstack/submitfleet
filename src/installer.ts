// The curl installer served at /install.sh.

export const INSTALL_SH = `#!/bin/sh
# SubmitFleet CLI installer: curl -fsSL https://submitfleet.com/install.sh | sh
set -eu
if ! command -v node >/dev/null 2>&1; then
  echo "submitfleet needs Node.js 22.5 or newer: https://nodejs.org/" >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then
  echo "submitfleet needs Node.js 22.5 or newer (found $(node -v))" >&2
  exit 1
fi
# npm first: its global bin works out of the box. pnpm only when npm is missing or fails
# (pnpm add -g aborts unless its global bin directory was set up beforehand).
if command -v npm >/dev/null 2>&1 && npm install -g @profullstack/submitfleet; then
  bin_dir="$(npm prefix -g)/bin"
elif command -v pnpm >/dev/null 2>&1 && pnpm add -g @profullstack/submitfleet; then
  bin_dir="$(pnpm bin -g)"
else
  echo "submitfleet: install failed (tried npm and pnpm)" >&2
  exit 1
fi
if command -v submitfleet >/dev/null 2>&1; then
  submitfleet doctor || true
  echo "Installed. Try: submitfleet coverage report"
else
  echo "Installed to $bin_dir, which is not on your PATH. Add it, then run: submitfleet doctor"
fi
`;
