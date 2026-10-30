output "wilson_vm_template" {
  description = "The instance template the VMs are created from. Its name changes on every change."
  value       = google_compute_instance_template.wilson.name
}

output "wilson_vm_service_account" {
  description = "The email the VMs run as."
  value       = google_service_account.wilson_vm.email
}
