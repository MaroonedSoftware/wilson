#!/usr/bin/env bash
# A Wilson VM's toolchain, run as root during the image build (wilson.pkr.hcl). Everything here is for
# any project: what one project needs beyond it, it declares and installs in its own setup command.
set -euo pipefail

: "${CLAUDE_CODE_VERSION:?}"
export DEBIAN_FRONTEND=noninteractive

mise_dir=/opt/mise

apt-get update
apt-get -y upgrade
apt-get install -y --no-install-recommends \
  build-essential ca-certificates curl git gnupg jq libssl-dev postgresql-client python3 tmux unzip zlib1g-dev \
  docker.io docker-compose-v2

# Node 22 for the system: the worker and the engine run on it, whatever a project's own version is.
# Corepack gives a project the yarn or pnpm its packageManager pins.
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
corepack enable

# mise holds every other runtime version, so a project picks its own with .tool-versions, mise.toml or
# .nvmrc. /opt rather than a home directory: the versions below are shared by everyone on the VM.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://mise.jdx.dev/gpg-key.pub -o /etc/apt/keyrings/mise-archive-keyring.asc
chmod a+r /etc/apt/keyrings/mise-archive-keyring.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/mise-archive-keyring.asc] https://mise.jdx.dev/deb stable main" \
  > /etc/apt/sources.list.d/mise.list
apt-get update
apt-get install -y mise

mkdir -p /etc/mise
cat > /etc/mise/config.toml <<'EOF'
[settings]
idiomatic_version_file_enable_tools = ["node", "python"]
EOF

# Common versions, so most projects' first install downloads no runtime. A project asking for another
# gets it from mise at setup.
MISE_DATA_DIR="$mise_dir" mise install node@20 node@24 python@3.13 go@latest

# The version the engine probes passed on, and it stays there: the updater would move a VM off it
# with nothing in this repository showing the change.
npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Logs and metrics into Cloud Logging and Monitoring, so a VM can be looked at after it is gone.
curl -fsSL https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh -o /tmp/add-ops-agent-repo.sh
bash /tmp/add-ops-agent-repo.sh --also-install
rm /tmp/add-ops-agent-repo.sh

# /etc/environment rather than profile.d, because PAM reads it for every SSH session, including
# non-interactive ones, and a systemd unit can name it as an EnvironmentFile.
sed -i "s|^PATH=\"|PATH=\"${mise_dir}/shims:|" /etc/environment
grep -q "^PATH=\"${mise_dir}/shims:" /etc/environment || echo "PATH=\"${mise_dir}/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\"" >> /etc/environment
cat >> /etc/environment <<EOF
MISE_DATA_DIR=${mise_dir}
COREPACK_ENABLE_DOWNLOAD_PROMPT=0
DISABLE_AUTOUPDATER=1
EOF

# Dev servers and test runners watch many files.
echo 'fs.inotify.max_user_watches=524288' > /etc/sysctl.d/60-wilson-inotify.conf

# Everyone on a VM installs into the shared versions, whatever their uid turns out to be.
chmod -R a+rwX "$mise_dir"

apt-get clean
rm -rf /var/lib/apt/lists/*

# Fail the build rather than publish an image that does not do what it says. Run the way a session
# would see it, so this also proves the shims fall through to the system's Node outside any project.
PATH="${mise_dir}/shims:${PATH}" MISE_DATA_DIR="$mise_dir" bash -euo pipefail -c '
  cd /
  [[ "$(node --version)" == v22.* ]]
  [[ "$(claude --version | cut -d" " -f1)" == "'"$CLAUDE_CODE_VERSION"'" ]]
  docker --version
  docker compose version
  git --version
  mise ls --installed
'
