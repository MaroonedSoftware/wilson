# VMs Wilson runs card stages on, built from an image that holds no project (infra/vm-image). They
# sit in toku-agents' network, which TGA's infra/agents owns and this only looks up. README.md.

locals {
  # e2 rather than the agent VMs' n2: the same 32 GB, and n2-highmem-4 has run out in all four
  # us-central1 zones at once. scripts/wilson_vm.sh tries each zone in turn for the same reason.
  wilson_machine_type = "e2-highmem-4"

  wilson_vm_pool = toset(["wilson-1", "wilson-2", "wilson-3", "wilson-4", "wilson-5", "wilson-6"])

  wilson_shared_secrets = toset(["wilson-claude-token", "wilson-github-packages-token", "wilson-tailscale-key"])

  # Empty shells: the values are added by hand, so they never reach Terraform state. A VM treats a
  # secret with no version as unset, which is what makes the shared ones optional.
  wilson_secrets = setunion([for vm in local.wilson_vm_pool : "wilson-worker-token-${vm}"], local.wilson_shared_secrets)

  # A stage can do whatever its VM's account can: it runs as a user in the docker group, so nothing on
  # the VM keeps it from the metadata server. Each VM therefore gets its own token and no other's, and
  # a stage cannot connect to Wilson as a different host.
  wilson_secret_grants = {
    for grant in concat(
      [for vm in local.wilson_vm_pool : { vm = vm, secret = "wilson-worker-token-${vm}" }],
      [for pair in setproduct(local.wilson_vm_pool, local.wilson_shared_secrets) : { vm = pair[0], secret = pair[1] }],
    ) : "${grant.vm}/${grant.secret}" => grant
  }

  wilson_vm_roles = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ])

  wilson_role_grants = {
    for pair in setproduct(local.wilson_vm_pool, local.wilson_vm_roles) : "${pair[0]}/${pair[1]}" => { vm = pair[0], role = pair[1] }
  }

  wilson_operator_grants = {
    for pair in setproduct(local.wilson_vm_pool, var.wilson_operators) : "${pair[0]}/${pair[1]}" => { vm = pair[0], member = pair[1] }
  }
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
  for_each = local.wilson_vm_pool

  project      = var.project_id
  account_id   = each.value
  display_name = "Wilson VM ${each.value}"
  description  = "Runs ${each.value}. Reads that VM's worker token and the shared secrets, and writes its logs and metrics, nothing else."
}

resource "google_project_iam_member" "wilson_vm" {
  for_each = local.wilson_role_grants

  project = var.project_id
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.wilson_vm[each.value.vm].email}"
}

# The one thing that keeps a Wilson VM's tokens to its operators. TGA's agent users have sudo through
# OS Login on every VM in this project, but OS Login refuses a VM whose account you cannot act as.
resource "google_service_account_iam_member" "wilson_operators_act_as_vm" {
  for_each = local.wilson_operator_grants

  service_account_id = google_service_account.wilson_vm[each.value.vm].name
  role               = "roles/iam.serviceAccountUser"
  member             = each.value.member
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

resource "google_secret_manager_secret_iam_member" "wilson_vm" {
  for_each = local.wilson_secret_grants

  project   = var.project_id
  secret_id = google_secret_manager_secret.wilson[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.wilson_vm[each.value.vm].email}"
}

# One each, because a VM's account is part of what it is. scripts/wilson_vm.sh picks by this prefix.
resource "google_compute_instance_template" "wilson" {
  for_each = local.wilson_vm_pool

  project      = var.project_id
  name_prefix  = "${each.value}-"
  description  = "${each.value}: the wilson image, no public address, IAP SSH only, powered off when idle."
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
    email  = google_service_account.wilson_vm[each.value].email
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
