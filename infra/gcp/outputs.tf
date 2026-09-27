output "github_environment_variables" {
  description = "Non-secret GitHub repository variables for the protected gcp-staging environment."
  value = {
    GCP_COLLECTOR_SERVICE_ACCOUNT            = google_service_account.collector.email
    GCP_COLLECTOR_WORKLOAD_IDENTITY_PROVIDER = google_iam_workload_identity_pool_provider.collector.name
    GCP_PROJECT_ID                           = var.project_id
    GCP_REGION                               = var.region
    GCP_CLOUD_RUN_SERVICE                    = local.prefix
    GCP_ARTIFACT_REGISTRY_REPOSITORY         = google_artifact_registry_repository.images.repository_id
    GCP_WORKLOAD_IDENTITY_PROVIDER           = google_iam_workload_identity_pool_provider.github.name
    GCP_DEPLOY_SERVICE_ACCOUNT               = google_service_account.deploy.email
    GCP_RUNTIME_SERVICE_ACCOUNT              = google_service_account.runtime.email
    GCP_COLLECTION_BUCKET                    = google_storage_bucket.collection.name
    GCP_FIRESTORE_DATABASE                   = google_firestore_database.catalog_control.name
    GCP_SYNC_TOKEN_SECRET                    = google_secret_manager_secret.application["sync_token"].secret_id
    GCP_TYPESAFE_API_KEY_SECRET              = google_secret_manager_secret.application["typesafe_api_key"].secret_id
    GCP_VOYAGE_API_KEY_SECRET                = google_secret_manager_secret.application["voyage_api_key"].secret_id
  }
}

output "trusted_github_ref" {
  value = local.github_ref
}

output "secret_names" {
  description = "Create secret versions through a protected channel after an authorized apply. Terraform never reads or stores their values."
  value       = local.secret_names
}

output "budget_alert_enabled" {
  value = var.budget_billing_account != ""
}
