terraform {
  required_version = "~> 1.16"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.0"
    }
  }

  # toku-agents' state bucket, under a prefix of its own: this root shares the bucket with TGA's
  # infra/agents and none of its state.
  backend "gcs" {
    bucket = "toku-agents-tfstate"
    prefix = "wilson-vms"
  }
}

# Applied by a person from their own Application Default Credentials
# (`gcloud auth application-default login`).
provider "google" {
  project = var.project_id
  region  = var.region
}
