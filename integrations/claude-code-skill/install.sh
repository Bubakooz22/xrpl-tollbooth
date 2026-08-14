#!/usr/bin/env bash
# integrations/claude-code-skill/install.sh
#
# Symlinks this skill directory into ~/.claude/skills/xrpl-tollbooth
# so Claude Code auto-discovers it. Because it's a symlink into the repo,
# `git pull` on the repo updates the installed skill in place.
#
# Idempotent: safe to run repeatedly.

set -euo pipefail

SKILL_SRC="$(cd "$(dirname "$0")" && pwd)"
SKILL_DEST_DIR="${HOME}/.claude/skills"
SKILL_DEST="${SKILL_DEST_DIR}/xrpl-tollbooth"

mkdir -p "${SKILL_DEST_DIR}"

if [[ -L "${SKILL_DEST}" ]]; then
  echo "[install] existing symlink at ${SKILL_DEST} \u2014 replacing"
  rm "${SKILL_DEST}"
elif [[ -e "${SKILL_DEST}" ]]; then
  echo "[install] ERROR: ${SKILL_DEST} exists and is not a symlink. Aborting."
  echo "         Move or delete it manually, then re-run."
  exit 1
fi

ln -s "${SKILL_SRC}" "${SKILL_DEST}"
echo "[install] linked ${SKILL_DEST} -> ${SKILL_SRC}"

# Sanity checks against the source directory.
missing=0
for f in SKILL.md helpers/tollbooth.mjs helpers/list-endpoints.mjs references/reason-codes.md references/example-prompts.md; do
  if [[ ! -f "${SKILL_SRC}/${f}" ]]; then
    echo "[install] MISSING: ${f}"
    missing=1
  fi
done

if [[ $missing -eq 1 ]]; then
  echo "[install] one or more skill files are missing \u2014 fix and re-run"
  exit 2
fi

echo ""
echo "[install] skill installed successfully."
echo "[install] required env vars (typically in xrpl-tollbooth/.env):"
echo "            TOLLBOOTH_URL      (default http://127.0.0.1:8787)"
echo "            TOLLBOOTH_API_KEY  (Bearer key for verify-poc + auth-ping)"
echo "            XRPL_SEED          (payer seed for x402 endpoints)"
echo ""
echo "[install] sanity check: node ${SKILL_SRC}/helpers/list-endpoints.mjs"
