locals {
  prefix             = "biplan-staging"
  collection_bucket  = var.collection_bucket_name != "" ? var.collection_bucket_name : "${var.project_id}-biplan-staging-data"
  github_environment = "gcp-staging"
  github_ref         = "refs/heads/${var.github_allowed_branch}"
  secret_names = {
    sync_token       = "${local.prefix}-sync-token"
    typesafe_api_key = "${local.prefix}-typesafe-api-key"
    voyage_api_key   = "${local.prefix}-voyage-api-key"
  }
  services = toset(concat([
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "firestore.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
    "sts.googleapis.com",
  ], var.budget_billing_account != "" ? ["billingbudgets.googleapis.com"] : []))
}

# Read only: the project must already exist and belong to this application.
data "google_project" "selected" {
  project_id = var.project_id
  lifecycle {
    postcondition {
      condition     = try(length(self.billing_account) > 0, false)
      error_message = "The selected project must already have a billing account; this configuration never enables or links billing."
    }
    postcondition {
      condition     = var.budget_billing_account == "" || try(var.budget_billing_account == trimprefix(self.billing_account, "billingAccounts/"), false)
      error_message = "The optional budget account must match the project's existing billing account."
    }
  }
}

resource "google_project_service" "required" {
  for_each           = local.services
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_firestore_database" "catalog_control" {
  project                           = var.project_id
  name                              = "(default)"
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  database_edition                  = "STANDARD"
  concurrency_mode                  = "PESSIMISTIC"
  app_engine_integration_mode       = "DISABLED"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_DISABLED"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  deletion_policy                   = "ABANDON"
  depends_on                        = [google_project_service.required]

  lifecycle { prevent_destroy = true }
}

resource "google_storage_bucket" "collection" {
  project                     = var.project_id
  name                        = local.collection_bucket
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = { application = "biplan", environment = "staging" }
  soft_delete_policy { retention_duration_seconds = 604800 }
  depends_on = [google_project_service.required]

  # Never expire source objects: a source head can reference an old successful
  # page when later collection fails. Garbage collection needs reachability checks.
  lifecycle { prevent_destroy = true }
}

resource "google_artifact_registry_repository" "images" {
  project                = var.project_id
  location               = var.region
  repository_id          = local.prefix
  description            = "Bi Plan staging container images"
  format                 = "DOCKER"
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "keep-last-three"
    action = "KEEP"
    most_recent_versions { keep_count = 3 }
  }
  cleanup_policies {
    id     = "delete-untagged-after-seven-days"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s"
    }
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "application" {
  for_each  = local.secret_names
  project   = var.project_id
  secret_id = each.value
  replication {
    auto {}
  }
  labels     = { application = "biplan", environment = "staging" }
  depends_on = [google_project_service.required]
  lifecycle { prevent_destroy = true }
}

# Cloud Run services/revisions are intentionally owned by the deployment workflow.
# No Cloud Run service, secret version, service account key, or public IAM binding
# is created by this Terraform configuration.
