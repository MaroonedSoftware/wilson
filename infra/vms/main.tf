# VMs Wilson runs card stages on, built from an image that holds no project (infra/vm-image). They
# sit in toku-agents' network, which TGA's infra/agents owns and this only looks up. README.md.

locals {
  # e2 rather than the agent VMs' n2: the same 32 GB, and n2-highmem-4 has run out in all four
  # us-central1 zones at once. scripts/wilson_vm.sh tries each zone in turn for the same reason.
  wilson_machine_type = "e2-highmem-4"

  wilson_vm_pool = toset(["wilson-1", "wilson-2", "wilson-3", "wilson-4", "wilson-5", "wilson-6"])

  # Empty shells: the values are added by hand, so they never reach Terraform state. A VM treats a
  # secret with no version as unset, which is what makes the last three optional.
  wilson_secrets = toset(concat(
    [for vm in local.wilson_vm_pool : "wilson-worker-token-${vm}"],
    ["wilson-claude-token", "wilson-github-packages-token", "wilson-tailscale-key"],
  ))

  wilson_vm_roles = toset([
    # Every secret in this project is one of the above, and only this account can read them.
    "roles/secretmanager.secretAccessor",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ])
}

# The agents network. Looked up, so nothing here can change it. TGA's Terraform never sees this root's
# resources, and this root's state is its own.
data "google_compute_subnetwork" "agents" {
  project = var.project_id
  name    = var.subnetwork
  region  = var.region
}

resource "google_project_service" "secretmanager" {
  project = var.project_id
  service = "secretmanager.googleapis.com"

  # TGA's roots share this project. Removing this root must not turn an API off under them.
  disable_on_destroy = false
}

# Not agent-vm: every agent session runs as that, and none should be able to read these secrets.
resource "google_service_account" "wilson_vm" {
  project      = var.project_id
  account_id   = "wilson-vm"
  display_name = "Wilson VM"
  description  = "Runs Wilson's VMs. Reads the worker's secrets and writes the VM's logs and metrics, nothing else."
}

resource "google_project_iam_member" "wilson_vm" {
  for_each = local.wilson_vm_roles

  project = var.project_id
  role    = each.value
  member  = google_service_account.wilson_vm.member
}

# The one thing that keeps a Wilson VM's tokens to its operators. TGA's agent users have sudo through
# OS Login on every VM in this project, but OS Login refuses a VM whose account you cannot act as.
resource "google_service_account_iam_member" "wilson_operators_act_as_vm" {
  for_each = var.wilson_operators

  service_account_id = google_service_account.wilson_vm.name
  role               = "roles/iam.serviceAccountUser"
  member             = each.value
}

resource "google_secret_manager_secret" "wilson" {
  for_each = local.wilson_secrets

  project   = var.project_id
  secret_id = each.value

  replication {
    auto {}
  }

  depends_on = [google_project_service.secretmanager]
}

resource "google_compute_instance_template" "wilson" {
  project      = var.project_id
  name_prefix  = "wilson-"
  description  = "Wilson VM: the wilson image, no public address, IAP SSH only, powered off when idle."
  machine_type = local.wilson_machine_type
  region       = var.region
  tags         = [var.network_tag]

  disk {
    source_image = "projects/${var.project_id}/global/images/family/wilson"
    # Every project's clone and dependencies stay here. Six of these, six 50 GB agent VMs and an image
    # build come to 780 GB of the region's 800 GB SSD quota.
    disk_size_gb = 75
    disk_type    = "pd-balanced"
    auto_delete  = true
    boot         = true
  }

  network_interface {
    subnetwork = data.google_compute_subnetwork.agents.self_link
  }

  service_account {
    email  = google_service_account.wilson_vm.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    enable-oslogin = "TRUE"
    # Read by the worker at boot; the image's wilson-worker-env sets WILSON_URL from it.
    wilson-url = var.wilson_url
  }

  # No max_run_duration: the disk is what saves the next stage a cold install, so a VM must outlive
  # the twelve hours an agent VM gets. The image powers one off after an idle hour instead.
  scheduling {
    provisioning_model  = "STANDARD"
    automatic_restart   = true
    on_host_maintenance = "MIGRATE"
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  lifecycle {
    create_before_destroy = true
  }
}
