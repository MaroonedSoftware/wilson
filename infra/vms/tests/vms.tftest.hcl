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
      name   = "projects/toku-agents/serviceAccounts/wilson-vm@toku-agents.iam.gserviceaccount.com"
      email  = "wilson-vm@toku-agents.iam.gserviceaccount.com"
      member = "serviceAccount:wilson-vm@toku-agents.iam.gserviceaccount.com"
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

run "vms_run_as_their_own_account" {
  command = apply

  assert {
    condition     = one(google_compute_instance_template.wilson.service_account).email == "wilson-vm@toku-agents.iam.gserviceaccount.com"
    error_message = "every agent session runs as agent-vm, so a Wilson VM's secrets must not be readable by it"
  }

  assert {
    condition     = [for grant in google_service_account_iam_member.wilson_operators_act_as_vm : grant.member] == ["user:operator@toku.com"]
    error_message = "only wilson_operators may act as wilson-vm, which is what stops anyone else signing in"
  }

  assert {
    condition     = alltrue([for grant in google_project_iam_member.wilson_vm : grant.member == "serviceAccount:wilson-vm@toku-agents.iam.gserviceaccount.com"])
    error_message = "the project roles here are for wilson-vm alone"
  }
}

run "vms_keep_their_disks_and_leave_no_way_in" {
  command = apply

  assert {
    condition     = length(one(google_compute_instance_template.wilson.scheduling).max_run_duration) == 0
    error_message = "a VM keeps its clones between tasks, so nothing may delete it on a timer"
  }

  assert {
    condition     = length(one(google_compute_instance_template.wilson.network_interface).access_config) == 0
    error_message = "the org refuses public addresses on VMs"
  }

  assert {
    condition     = google_compute_instance_template.wilson.tags == toset(["agent-vm"])
    error_message = "a VM must carry the tag IAP SSH admits"
  }

  assert {
    condition     = google_compute_instance_template.wilson.metadata["wilson-url"] == "http://tower:13101"
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
