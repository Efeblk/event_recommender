resource "google_service_account" "collector" {
  project      = var.project_id
  account_id   = "${local.prefix}-collector"
  display_name = "Bi Plan staging HTTP collector"
  depends_on   = [google_project_service.required]
}

# There is no service to attach a service-level binding to until the deployment
# workflow creates it. Project scope is confined to the dedicated staging project.
# The collector has no direct database, object storage, secret, or deployment role.
resource "google_project_iam_member" "collector_invoker" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = google_service_account.collector.member
}

# Separate pools prevent an otherwise valid collector workflow token acquiring
# the deployment identity through a shared repository attribute principal.
resource "google_iam_workload_identity_pool" "collector" {
  project                   = var.project_id
  workload_identity_pool_id = "biplan-collector-staging"
  display_name              = "Bi Plan staging collector"
  depends_on                = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "collector" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.collector.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"
  display_name                       = "Protected collector workflow"
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
    "assertion.workflow_ref == ${jsonencode("${var.github_repository}/.github/workflows/gcp-collector.yml@${local.github_ref}")}",
  ])
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}

resource "google_service_account_iam_member" "github_collector" {
  service_account_id = google_service_account.collector.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.collector.name}/attribute.repository_id/${var.github_repository_id}"
}
