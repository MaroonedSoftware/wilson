#!/usr/bin/env bash
# The Wilson worker as a boot service, run as root during the image build (wilson.pkr.hcl), after
# provision.sh. A VM needs nothing done to it by hand: it asks for its own secrets at boot, by its own
# name, and connects (README.md, "What a VM reads at boot").
set -euo pipefail

: "${WORKER_SOURCE:?}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Tailscale is how a VM with no route to the LAN reaches Wilson. Nothing joins a tailnet until the
# boot script finds a key, so the package alone connects to nothing.
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /etc/apt/keyrings/tailscale-archive-keyring.gpg
chmod a+r /etc/apt/keyrings/tailscale-archive-keyring.gpg
echo "deb [signed-by=/etc/apt/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu noble main" \
  > /etc/apt/sources.list.d/tailscale.list
apt-get update
apt-get install -y tailscale
apt-get clean
rm -rf /var/lib/apt/lists/*

# Its home is not under /home: the build's last step empties that, and the idle check names this one.
useradd --create-home --home-dir /var/lib/wilson --shell /bin/bash --groups docker wilson

# Where the host's projects go, unless it is told otherwise.
install -d -o wilson -g wilson /srv/wilson

# Installed here, on Linux, rather than copied from the builder's machine: @swc/core is native.
# Owned by root, so a stage cannot rewrite the program that carries out its commands.
mkdir -p /opt/wilson
tar -xf "$WORKER_SOURCE" -C /opt/wilson
rm "$WORKER_SOURCE"
cd /opt/wilson
pnpm install --frozen-lockfile --filter '@wilson/worker...'

cat > /usr/local/bin/wilson-worker-env <<'EOF'
#!/usr/bin/env bash
# Writes the worker's environment from what this VM is allowed to read, before each start
# (infra/vm-image/README.md). Never exits 1: the unit treats that as a refusal not worth retrying.
set -euo pipefail
trap 'exit 2' ERR

env_file=/run/wilson-worker.env
metadata=http://metadata.google.internal/computeMetadata/v1

meta() {
  curl -fsS --retry 5 --retry-connrefused -H 'Metadata-Flavor: Google' "${metadata}/$1"
}

project="$(meta project/project-id)"
name="$(meta instance/name)"
url="$(meta instance/attributes/wilson-url)"
access_token="$(meta instance/service-accounts/default/token | jq -r .access_token)"

# The latest version of a secret, or nothing when it does not exist. Any other failure is an error.
secret() {
  local body status
  body="$(mktemp)"
  status="$(curl -sS --retry 5 -o "$body" -w '%{http_code}' -H "Authorization: Bearer ${access_token}" \
    "https://secretmanager.googleapis.com/v1/projects/${project}/secrets/$1/versions/latest:access")"
  case "$status" in
    200) jq -r .payload.data "$body" | base64 -d ;;
    404) ;;
    *)
      echo "wilson-worker-env: reading secret $1 answered HTTP ${status}" >&2
      rm -f "$body"
      return 2
      ;;
  esac
  rm -f "$body"
}

worker_token="$(secret "wilson-worker-token-${name}")"
if [[ -z "$worker_token" ]]; then
  echo "wilson-worker-env: no secret wilson-worker-token-${name}" >&2
  exit 2
fi
claude_token="$(secret wilson-claude-token)"
packages_token="$(secret wilson-github-packages-token)"
tailscale_key="$(secret wilson-tailscale-key)"

if [[ -n "$tailscale_key" ]] && ! tailscale status >/dev/null 2>&1; then
  key_file="$(mktemp)"
  printf '%s' "$tailscale_key" > "$key_file"
  tailscale up --auth-key="file:${key_file}" --hostname="$name"
  rm -f "$key_file"
fi

umask 077
{
  echo "WILSON_URL=${url}"
  echo "WILSON_WORKER_TOKEN=${worker_token}"
  [[ -z "$claude_token" ]] || echo "CLAUDE_CODE_OAUTH_TOKEN=${claude_token}"
  # Read by a project's commands only when its host names it in commandEnv.
  [[ -z "$packages_token" ]] || echo "GITHUB_TOKEN=${packages_token}"
} > "$env_file"
EOF
chmod 0755 /usr/local/bin/wilson-worker-env

# Exit 1 is the worker saying retrying cannot help, so it is the one exit not restarted. The node
# command is what `pnpm start` runs, without needing Corepack to fetch pnpm at boot.
cat > /etc/systemd/system/wilson-worker.service <<'EOF'
[Unit]
Description=Wilson worker
After=network-online.target docker.service tailscaled.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
User=wilson
WorkingDirectory=/opt/wilson/apps/worker
EnvironmentFile=/etc/environment
# Optional, so a first start can read it after ExecStartPre has written it.
EnvironmentFile=-/run/wilson-worker.env
Environment=HOME=/var/lib/wilson
ExecStartPre=+/usr/local/bin/wilson-worker-env
ExecStart=/usr/bin/node --import @swc-node/register/esm-register ./src/main.ts
Restart=on-failure
RestartSec=30
RestartPreventExitStatus=1

[Install]
WantedBy=multi-user.target
EOF
systemctl enable wilson-worker.service

# Powers the VM off once it has done nothing for an hour, which costs a stage nothing: Wilson places
# work only on a connected worker, and the disk keeps every clone. Activity is a running engine, a
# transcript written, a terminal in use, or load. The first is what keeps a stage alive through a long
# quiet wait on a model. The marker is in /run, so a VM always gets its first hour after boot.
cat > /usr/local/bin/wilson-idle-shutdown <<'EOF'
#!/usr/bin/env bash
# Powers this VM off once nothing has happened for an hour (infra/vm-image/README.md).
set -uo pipefail

idle_minutes=60
busy_load=0.5
marker=/run/wilson-last-busy

if [[ ! -e "$marker" ]] || pgrep -u wilson -x claude >/dev/null || awk -v busy="$busy_load" '{ exit !($2 >= busy) }' /proc/loadavg; then
  touch "$marker"
fi

recent="$(find "$marker" /dev/pts/[0-9]* /var/lib/wilson/.claude/projects -mmin "-${idle_minutes}" -print -quit 2>/dev/null)"
if [[ -z "$recent" ]]; then
  echo "No activity for ${idle_minutes} minutes; powering off."
  systemctl poweroff
fi
EOF
chmod 0755 /usr/local/bin/wilson-idle-shutdown

cat > /etc/systemd/system/wilson-idle-shutdown.service <<'EOF'
[Unit]
Description=Power off a Wilson VM that has been idle for an hour

[Service]
Type=oneshot
ExecStart=/usr/local/bin/wilson-idle-shutdown
EOF

cat > /etc/systemd/system/wilson-idle-shutdown.timer <<'EOF'
[Unit]
Description=Check every five minutes whether this Wilson VM is idle

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF

# Enabled, not started: both first run when a VM boots from the image, never on the build VM.
systemctl enable wilson-idle-shutdown.timer

# Fail the build if the worker cannot even load. No token, so it stops at its own check with exit 2.
status=0
(cd /opt/wilson/apps/worker && env -u WILSON_URL -u WILSON_WORKER_TOKEN node --import @swc-node/register/esm-register ./src/main.ts) || status=$?
if [[ "$status" != 2 ]]; then
  echo "the worker exited ${status} rather than asking for its configuration" >&2
  exit 1
fi
