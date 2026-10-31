output "wilson_vm_templates" {
  description = "The instance template each VM is created from. Their names change on every change."
  value       = { for vm, template in google_compute_instance_template.wilson : vm => template.name }
}

output "wilson_vm_service_accounts" {
  description = "The email each VM runs as."
  value       = { for vm, account in google_service_account.wilson_vm : vm => account.email }
}
