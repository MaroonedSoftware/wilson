# No defaults, as in TGA's roots. The values are in terraform.tfvars.

variable "project_id" {
  type        = string
  description = "The GCP project the VMs run in."
}

variable "region" {
  type        = string
  description = "GCP region the VMs run in. The org allows US locations only."

  validation {
    condition     = startswith(var.region, "us-")
    error_message = "region must be a US region: gcp.resourceLocations refuses anything else."
  }
}

variable "subnetwork" {
  type        = string
  description = "The existing subnet the VMs join."
}

variable "network_tag" {
  type        = string
  description = "The tag the network's firewall admits IAP SSH to."
}

variable "wilson_url" {
  type        = string
  description = "Wilson's address as a VM reaches it over the tailnet, e.g. http://tower:13101."

  validation {
    condition     = can(regex("^https?://", var.wilson_url))
    error_message = "wilson_url must be an http or https URL."
  }
}

variable "wilson_operators" {
  type        = set(string)
  description = "IAM members who may sign in to the VMs, e.g. user:someone@toku.com. Nobody else can."
}
