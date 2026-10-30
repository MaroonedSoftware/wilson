#!/usr/bin/env bash
# Create, start, list and delete the VMs Wilson runs card stages on (README.md).
#
# A VM's name is its Wilson host name, and picks its token, so the pool is fixed: wilson-1 to
# wilson-6. Each VM runs the worker at boot and needs nothing done to it by hand. One idle for an hour
# powers itself off and keeps its disk, until `up` starts it again.
#
# Usage:
#   wilson_vm.sh up N       create wilson-N, or start it if stopped
#   wilson_vm.sh down N     delete wilson-N and its disk; Wilson clones its projects again on the next
#   wilson_vm.sh ls         list Wilson VMs
#
# AGENT_VM_PROJECT overrides the project (toku-agents); WILSON_VM_ZONES the zones `up` tries, in order.
set -euo pipefail

project="${AGENT_VM_PROJECT:-toku-agents}"
zones="${WILSON_VM_ZONES:-us-central1-a us-central1-b us-central1-c us-central1-f}"

usage() {
  sed -n '/^# Usage:/,/^#$/p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

die() {
  echo "wilson_vm: $*" >&2
  exit 1
}

vm_name() {
  local n="${1:-}"
  [[ "$n" =~ ^[1-6]$ ]] || die "N must be 1 to 6, not '${n}'"
  echo "wilson-${n}"
}

# The VM's zone and status, or nothing when it does not exist. A VM stays in the zone it was made in.
find_vm() {
  gcloud compute instances list --project="$project" --filter="name=$1" --format='value(zone.basename(),status)'
}

cmd_up() {
  local name zone status template
  name="$(vm_name "${1:-}")"
  read -r zone status < <(find_vm "$name") || true
  if [[ -n "${zone:-}" ]]; then
    [[ "$status" == TERMINATED ]] || die "${name} is already ${status}"
    gcloud compute instances start "$name" --project="$project" --zone="$zone" --format='value(name)' >/dev/null
    echo "${name} started in ${zone}. Its worker connects by itself."
    return
  fi

  template="$(gcloud compute instance-templates list --project="$project" \
    --filter='name~^wilson-' --sort-by=~creationTimestamp --limit=1 --format='value(name)')"
  [[ -n "$template" ]] || die "no wilson-* instance template in ${project} (infra/vms/main.tf)"

  for zone in $zones; do
    if gcloud compute instances create "$name" --project="$project" --zone="$zone" \
      --source-instance-template="$template" --format='value(name)' >/dev/null 2>&1; then
      echo "${name} created in ${zone}. Its worker connects by itself."
      return
    fi
    echo "${zone} could not take ${name}; trying the next zone" >&2
  done
  die "no zone could take ${name}: ${zones}"
}

cmd_down() {
  local name zone status
  name="$(vm_name "${1:-}")"
  read -r zone status < <(find_vm "$name") || true
  [[ -n "${zone:-}" ]] || die "${name} does not exist"
  gcloud compute instances delete "$name" --project="$project" --zone="$zone" --quiet
}

cmd_ls() {
  gcloud compute instances list --project="$project" --filter='name~^wilson-[0-9]+$' --sort-by=name \
    --format='table(name,zone.basename(),status)'
}

command -v gcloud >/dev/null || die "gcloud is not installed"

case "${1:-}" in
  up) cmd_up "${2:-}" ;;
  down) cmd_down "${2:-}" ;;
  ls) cmd_ls ;;
  *) usage ;;
esac
