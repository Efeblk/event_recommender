locals {
  postgres_secret_names = {
    runtime     = "biplan-staging-db-runtime-password"
    preparation = "biplan-staging-db-preparation-password"
  }
}

resource "google_sql_database_instance" "catalog" {
  count = var.postgres_staging_enabled ? 1 : 0

  project          = var.project_id
  name             = "biplan-staging-catalog-pg17"
  region           = var.region
  database_version = "POSTGRES_17"

  deletion_protection = true

  settings {
    tier              = "db-f1-micro"
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"

    disk_type       = "PD_SSD"
    disk_size       = 10
    disk_autoresize = false

    deletion_protection_enabled = true

    maintenance_window {
      day          = 7
      hour         = 3
      update_track = "stable"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = false

      backup_retention_settings {
        retained_backups = 7
        retention_unit   = "COUNT"
      }
    }

    ip_configuration {
      ipv4_enabled = true
    }
  }

  depends_on = [google_project_service.required["sqladmin.googleapis.com"]]

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = length(trimspace(var.postgres_activation_authorization_reference)) >= 8
      error_message = "Cloud SQL staging creation requires a recorded activation authorization reference."
    }
  }
}

resource "google_sql_database" "catalog" {
  count = var.postgres_staging_enabled ? 1 : 0

  project  = var.project_id
  name     = "biplan_catalog"
  instance = google_sql_database_instance.catalog[0].name

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_service_account" "preparation" {
  count = var.postgres_staging_enabled ? 1 : 0

  project      = var.project_id
  account_id   = "biplan-staging-preparation"
  display_name = "Bi' Plan staging preparation jobs"
  description  = "Dedicated identity for bounded Cloud SQL catalog preparation jobs."

  depends_on = [google_project_service.required["iam.googleapis.com"]]
}

resource "google_secret_manager_secret" "postgres_password" {
  for_each = var.postgres_staging_enabled ? local.postgres_secret_names : {}

  project   = var.project_id
  secret_id = each.value

  replication {
    auto {}
  }

  labels = {
    app         = "biplan"
    environment = "staging"
    purpose     = "postgres-${each.key}"
  }

  depends_on = [google_project_service.required["secretmanager.googleapis.com"]]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_project_iam_member" "runtime_cloud_sql_client" {
  count = var.postgres_staging_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = google_service_account.runtime.member
}

resource "google_project_iam_member" "preparation_cloud_sql_client" {
  count = var.postgres_staging_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = google_service_account.preparation[0].member
}

resource "google_secret_manager_secret_iam_member" "postgres_password_accessor" {
  for_each = var.postgres_staging_enabled ? local.postgres_secret_names : {}

  project   = var.project_id
  secret_id = google_secret_manager_secret.postgres_password[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member = (
    each.key == "runtime"
    ? google_service_account.runtime.member
    : google_service_account.preparation[0].member
  )
}

# Source ingestion reads an exact content-addressed object; it cannot enumerate
# the bucket, write artifacts, or read runtime checkpoints/application sources.
resource "google_storage_bucket_iam_member" "preparation_sources" {
  count = var.postgres_staging_enabled ? 1 : 0

  bucket = google_storage_bucket.collection.name
  role   = "roles/storage.objectViewer"
  member = google_service_account.preparation[0].member

  condition {
    title       = "preparation-source-artifacts-only"
    description = "Read immutable preparation envelopes by exact object name."
    expression  = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.collection.name}/objects/staging/preparation/sources/')"
  }
}
