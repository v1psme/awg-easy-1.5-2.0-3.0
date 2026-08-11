#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="${REPO_OWNER:-krolchonok}"
REPO_NAME="${REPO_NAME:-amnezia-wg-easy}"
ASSET_NAME="${ASSET_NAME:-amnezia-wg-easy-deploy.zip}"
DOWNLOAD_URL="${DOWNLOAD_URL:-https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download/${ASSET_NAME}}"
WORKDIR="${WORKDIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
TIMESTAMP="$(date -u +%Y%m%d%H%M%S)"
BACKUP_ENV="${WORKDIR}/.env.backup.${TIMESTAMP}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

backup_env() {
  if [ -f "${WORKDIR}/.env" ]; then
    cp "${WORKDIR}/.env" "${BACKUP_ENV}"
    echo "Backed up current .env to ${BACKUP_ENV}"
  fi
}

run_compose_update() {
  echo "Pulling latest container image"
  (cd "${WORKDIR}" && docker compose pull)

  echo "Starting updated container"
  (cd "${WORKDIR}" && docker compose up -d --remove-orphans)

  echo "Update completed."
  if [ -f "${WORKDIR}/.env_example" ]; then
    echo "If needed, compare ${WORKDIR}/.env with ${WORKDIR}/.env_example."
  fi
}

update_from_repo() {
  require_cmd git

  echo "Updating git repository"
  (cd "${WORKDIR}" && git fetch origin master && git pull --ff-only origin master)

  run_compose_update
}

update_from_release_bundle() {
  require_cmd curl
  require_cmd unzip

  tmpdir="$(mktemp -d)"
  cleanup() {
    rm -rf "${tmpdir}"
  }
  trap cleanup EXIT

  echo "Downloading latest deploy bundle from ${DOWNLOAD_URL}"
  curl -fsSL "${DOWNLOAD_URL}" -o "${tmpdir}/${ASSET_NAME}"

  echo "Extracting bundle"
  unzip -q "${tmpdir}/${ASSET_NAME}" -d "${tmpdir}/bundle"

  bundle_root="$(find "${tmpdir}/bundle" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [ -z "${bundle_root}" ]; then
    echo "Failed to find extracted bundle directory" >&2
    exit 1
  fi

  install -m 0644 "${bundle_root}/docker-compose.yml" "${WORKDIR}/docker-compose.yml"
  install -m 0644 "${bundle_root}/.env_example" "${WORKDIR}/.env_example"
  install -m 0644 "${bundle_root}/README.md" "${WORKDIR}/README.md"
  install -m 0644 "${bundle_root}/ENV_VARIABLES.md" "${WORKDIR}/ENV_VARIABLES.md"
  install -m 0755 "${bundle_root}/update_container.sh" "${WORKDIR}/update_container.sh"

  if [ ! -f "${WORKDIR}/.env" ] && [ -f "${bundle_root}/.env" ]; then
    install -m 0644 "${bundle_root}/.env" "${WORKDIR}/.env"
    echo "Created .env from bundle template"
  fi

  run_compose_update
}

require_cmd docker

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin is required" >&2
  exit 1
fi

backup_env

if [ -d "${WORKDIR}/.git" ]; then
  update_from_repo
else
  update_from_release_bundle
fi
