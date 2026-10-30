# The image a Wilson VM boots from: a toolchain general enough for any project, and no project in it.
# Project clones live on a VM's own disk, so nothing here has to know which projects exist.
#
# Built in toku-agents on the same terms as its agent VMs: no public address, SSH over IAP with OS
# Login, running as the agent-vm account. Build it with ./build.sh (README.md).
#
# The root step runs with HOME=/root: sudo -E would keep the builder's HOME, and the caches npm and
# mise write there would then be root-owned in the builder's own home directory.

packer {
  required_version = "~> 1.16"

  required_plugins {
    googlecompute = {
      source  = "github.com/hashicorp/googlecompute"
      version = "~> 1.2"
    }
  }
}

variable "project_id" {
  type    = string
  default = "toku-agents"
}

variable "zone" {
  type    = string
  default = "us-central1-a"
}

variable "subnetwork" {
  type    = string
  default = "agents-us-central1"
}

variable "service_account_email" {
  type    = string
  default = "agent-vm@toku-agents.iam.gserviceaccount.com"
}

variable "claude_code_version" {
  type        = string
  description = "npm version of @anthropic-ai/claude-code. build.sh passes CLAUDE_BINARY_VERSION, the version Wilson's engine probes last passed on."
}

locals {
  built_at = formatdate("YYYYMMDD-hhmmss", timestamp())
}

source "googlecompute" "wilson" {
  project_id              = var.project_id
  zone                    = var.zone
  source_image_family     = "ubuntu-2404-lts-amd64"
  source_image_project_id = ["ubuntu-os-cloud"]

  machine_type = "n2-highmem-4"
  disk_type    = "pd-ssd"

  # The image's own size, and so the smallest disk a VM can boot it on. No project is in it, so it
  # needs far less than a build holding a warm checkout. Build disks count against the region's SSD
  # quota alongside every running VM's.
  disk_size = 20

  # A family, so a template that asks for it always boots the newest build. Not `agent`: that family
  # belongs to the shared agent pool, and a build here must not change what those VMs boot.
  image_name              = "wilson-${local.built_at}"
  image_family            = "wilson"
  image_description       = "Wilson VM: Docker, Node 22, mise, and Claude Code ${var.claude_code_version}. Holds no project."
  image_storage_locations = ["us-central1"]

  # Creating the image can take longer than Packer's default 5 minutes; when it does, Packer gives up
  # and leaves the build disk behind while Google is still copying from it.
  state_timeout = "20m"

  # The org refuses public addresses on VMs and requires OS Login, so the build reaches its VM the
  # way a person would: through IAP, as an OS Login user. The tag is what the agents firewall admits.
  subnetwork       = var.subnetwork
  omit_external_ip = true
  use_internal_ip  = true
  use_iap          = true
  use_os_login     = true
  tags             = ["agent-vm"]

  # OS Login decides the user Packer signs in as; this only satisfies the communicator.
  ssh_username = "packer"

  service_account_email = var.service_account_email
  scopes                = ["https://www.googleapis.com/auth/cloud-platform"]
}

build {
  sources = ["source.googlecompute.wilson"]

  provisioner "shell" {
    script           = "${path.root}/provision.sh"
    execute_command  = "chmod +x {{ .Path }}; {{ .Vars }} sudo -E HOME=/root bash '{{ .Path }}'"
    environment_vars = ["CLAUDE_CODE_VERSION=${var.claude_code_version}"]
  }

  # The builder signs in as their own OS Login user, so the image would otherwise carry their home
  # directory. A user's home is made at their first sign-in on each VM; none should come with it.
  provisioner "shell" {
    inline = ["sudo rm -rf /home/*"]
  }
}
