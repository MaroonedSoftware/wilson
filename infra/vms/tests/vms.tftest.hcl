# The VMs' separation from the shared agent pool, asserted without touching Google Cloud. The provider
# is mocked, so this needs no credential.

mock_provider "google" {
  mock_data "google_compute_subnetwork" {
    defaults = {
      self_link = "https://www.googleapis.com/compute/v1/projects/toku-agents/regions/us-central1/subnetworks/agents-us-central1"
    }
  }

  mock_resource "google_service_account" {
    defaults = {
      name = "projects/toku-agents/serviceAccounts/wilson-vm@toku-agents.iam.gserviceaccount.com"
    }
  }
}

variables {
  project_id       = "toku-agents"
  region           = "us-central1"
  subnetwork       = "agents-us-central1"
  network_tag      = "agent-vm"
  wilson_url       = "http://tower:13101"
  wilson_operators = ["user:operator@toku.com"]
}

run "each_vm_runs_as_its_own_account" {
  command = apply

  assert {
    condition     = length(google_service_account.wilson_vm) == 6 && length(distinct([for account in google_service_account.wilson_vm : account.email])) == 6
    error_message = "a stage can use its VM's account, so no two VMs may share one"
  }

  assert {
    condition     = alltrue([for vm, template in google_compute_instance_template.wilson : one(template.service_account).email == google_service_account.wilson_vm[vm].email])
    error_message = "a VM's template must run it as that VM's account"
  }

  assert {
    condition     = alltrue([for vm, template in google_compute_instance_template.wilson : startswith(template.name_prefix, "${vm}-")])
    error_message = "wilson_vm.sh finds a VM's template by this prefix"
  }

  assert {
    condition     = length(google_service_account_iam_member.wilson_operators_act_as_vm) == 6 && alltrue([for grant in google_service_account_iam_member.wilson_operators_act_as_vm : grant.member == "user:operator@toku.com"])
    error_message = "only wilson_operators may act as a VM's account, which is what stops anyone else signing in"
  }
}

run "a_vm_reads_its_own_token_and_no_other" {
  command = apply

  assert {
    condition     = !contains([for grant in google_project_iam_member.wilson_vm : grant.role], "roles/secretmanager.secretAccessor")
    error_message = "a project-wide grant would let any stage read every VM's token"
  }

  assert {
    condition     = length(google_secret_manager_secret_iam_member.wilson_vm) == 24
    error_message = "each of six VMs reads its own token and the three shared secrets"
  }

  assert {
    condition = alltrue([
      for key, grant in google_secret_manager_secret_iam_member.wilson_vm :
      grant.member == "serviceAccount:${google_service_account.wilson_vm[split("/", key)[0]].email}"
      && (!startswith(grant.secret_id, "wilson-worker-token-") || grant.secret_id == "wilson-worker-token-${split("/", key)[0]}")
    ])
    error_message = "a worker token may be read by its own VM's account only"
  }
}

run "vms_keep_their_disks_and_leave_no_way_in" {
  command = apply

  assert {
    condition     = alltrue([for template in google_compute_instance_template.wilson : length(one(template.scheduling).max_run_duration) == 0])
    error_message = "a VM keeps its clones between tasks, so nothing may delete it on a timer"
  }

  assert {
    condition     = alltrue([for template in google_compute_instance_template.wilson : length(one(template.network_interface).access_config) == 0])
    error_message = "the org refuses public addresses on VMs"
  }

  assert {
    condition     = alltrue([for template in google_compute_instance_template.wilson : template.tags == toset(["agent-vm"])])
    error_message = "a VM must carry the tag IAP SSH admits"
  }

  assert {
    condition     = alltrue([for template in google_compute_instance_template.wilson : template.metadata["wilson-url"] == "http://tower:13101"])
    error_message = "the worker reads Wilson's address from this metadata at boot"
  }
}

run "one_token_for_each_vm_and_three_shared_secrets" {
  command = plan

  assert {
    condition     = length(google_secret_manager_secret.wilson) == 9
    error_message = "six worker tokens and three shared secrets"
  }
}
