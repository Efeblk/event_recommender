resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = "${local.prefix}-runtime"
  display_name = "Bi Plan staging runtime"
  depends_on   = [google_project_service.required]
}

resource "google_service_account" "deploy" {
  project      = var.project_id
  account_id   = "${local.prefix}-deploy"
  display_name = "Bi Plan staging GitHub deployment"
  depends_on   = [google_project_service.required]
}

resource "google_project_iam_member" "runtime_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = google_service_account.runtime.member
}

resource "google_storage_bucket_iam_member" "runtime_objects" {
  for_each = toset(["roles/storage.objectViewer", "roles/storage.objectCreator"])
  bucket   = google_storage_bucket.collection.name
  role     = each.value
  member   = google_service_account.runtime.member
}

resource "google_secret_manager_secret_iam_member" "runtime_secret" {
  for_each  = google_secret_manager_secret.application
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.runtime.member
}

resource "google_artifact_registry_repository_iam_member" "deploy_images" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = google_service_account.deploy.member
}

resource "google_project_iam_member" "deploy_run" {
  for_each = toset(["roles/run.developer", "roles/run.invoker"])
  project  = var.project_id
  role     = each.value
  member   = google_service_account.deploy.member
}

# gcloud --no-allow-unauthenticated needs service IAM access to remove an existing
# allUsers invoker grant. Keep that permission separate from run.developer;
# run.admin would additionally grant unrelated Cloud Run administration rights.
resource "google_project_iam_custom_role" "private_service_policy" {
  project     = var.project_id
  role_id     = "biplanStagingServicePolicy"
  title       = "Bi Plan staging service IAM"
  description = "Read and update Cloud Run service invocation policy in the dedicated staging project"
  permissions = ["run.services.getIamPolicy", "run.services.setIamPolicy"]
}

resource "google_project_iam_member" "deploy_service_policy" {
  project = var.project_id
  role    = google_project_iam_custom_role.private_service_policy.name
  member  = google_service_account.deploy.member
}

resource "google_service_account_iam_member" "deploy_runtime_identity" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.deploy.member
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "biplan-github-staging"
  display_name              = "Bi Plan GitHub staging"
  depends_on                = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"
  display_name                       = "Protected staging deployment"
  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
  }
  attribute_condition = join(" && ", [
    "assertion.repository_id == ${jsonencode(var.github_repository_id)}",
    "assertion.repository_owner_id == ${jsonencode(var.github_repository_owner_id)}",
    "assertion.repository == ${jsonencode(var.github_repository)}",
    "assertion.sub == ${jsonencode("repo:${var.github_repository}:environment:${local.github_environment}")}",
    "assertion.ref == ${jsonencode(local.github_ref)}",
    "assertion.ref_type == 'branch'",
    "assertion.workflow_ref == ${jsonencode("${var.github_repository}/.github/workflows/gcp-staging.yml@${local.github_ref}")}",
  ])
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}

resource "google_service_account_iam_member" "github_deployment" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/${var.github_repository_id}"
}
