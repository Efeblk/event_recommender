mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number          = "123456789012"
      project_id      = "biplan-staging-efeblk"
      billing_account = "ABCDEF-123456-ABCDEF"
    }
  }
}

variables {
  project_id                          = "biplan-staging-efeblk"
  dedicated_billing_project_confirmed = true
}

run "postgres_is_disabled_by_default" {
  command = plan

  assert {
    condition     = length(google_sql_database_instance.catalog) == 0
    error_message = "Cloud SQL must not be created without explicit opt-in."
  }

  assert {
    condition     = length(google_service_account.preparation) == 0
    error_message = "The preparation identity must not be created without explicit opt-in."
  }

  assert {
    condition     = length(google_storage_bucket_iam_member.preparation_sources) == 0
    error_message = "Source artifact access must remain disabled without PostgreSQL opt-in."
  }

  assert {
    condition     = length(google_secret_manager_secret.postgres_password) == 0
    error_message = "Database secret containers must not be created without explicit opt-in."
  }

  assert {
    condition     = !contains(keys(google_project_service.required), "sqladmin.googleapis.com")
    error_message = "The SQL Admin API must remain disabled in the default infrastructure plan."
  }
}

run "enabled_postgres_requires_approval_reference" {
  command = plan

  variables {
    postgres_staging_enabled = true
  }

  expect_failures = [var.postgres_activation_authorization_reference]
}

run "approved_postgres_matches_bounded_staging_plan" {
  command = plan

  variables {
    postgres_staging_enabled                    = true
    postgres_activation_authorization_reference = "user-approval:2026-09-30-thread"
  }

  assert {
    condition     = contains(keys(google_project_service.required), "sqladmin.googleapis.com")
    error_message = "The SQL Admin API must be enabled with the PostgreSQL resources."
  }

  assert {
    condition = (
      google_sql_database_instance.catalog[0].database_version == "POSTGRES_17" &&
      google_sql_database_instance.catalog[0].settings[0].edition == "ENTERPRISE" &&
      google_sql_database_instance.catalog[0].settings[0].tier == "db-f1-micro" &&
      google_sql_database_instance.catalog[0].settings[0].availability_type == "ZONAL"
    )
    error_message = "Cloud SQL must use the reviewed Enterprise PostgreSQL 17 single-zone micro configuration."
  }

  assert {
    condition = (
      google_sql_database_instance.catalog[0].settings[0].disk_type == "PD_SSD" &&
      google_sql_database_instance.catalog[0].settings[0].disk_size == 10 &&
      google_sql_database_instance.catalog[0].settings[0].disk_autoresize == false &&
      google_sql_database_instance.catalog[0].settings[0].disk_autoresize_limit == 10
    )
    error_message = "Cloud SQL storage must stay at the reviewed 10 GiB SSD cap with automatic growth disabled."
  }

  assert {
    condition = (
      google_sql_database_instance.catalog[0].settings[0].backup_configuration[0].enabled == true &&
      google_sql_database_instance.catalog[0].settings[0].backup_configuration[0].point_in_time_recovery_enabled == false &&
      google_sql_database_instance.catalog[0].settings[0].backup_configuration[0].backup_retention_settings[0].retained_backups == 7
    )
    error_message = "Cloud SQL must retain seven backups with PITR disabled."
  }

  assert {
    condition = (
      google_sql_database_instance.catalog[0].deletion_protection == true &&
      google_sql_database_instance.catalog[0].settings[0].deletion_protection_enabled == true &&
      google_sql_database_instance.catalog[0].settings[0].ip_configuration[0].ipv4_enabled == true &&
      length(google_sql_database_instance.catalog[0].settings[0].ip_configuration[0].authorized_networks) == 0
    )
    error_message = "Cloud SQL must use protected connector-compatible public transport with no authorized networks."
  }

  assert {
    condition = (
      length(google_service_account.preparation) == 1 &&
      google_service_account.preparation[0].account_id == "biplan-staging-preparation" &&
      length(google_project_iam_member.runtime_cloud_sql_client) == 1 &&
      length(google_project_iam_member.preparation_cloud_sql_client) == 1
    )
    error_message = "Only the existing runtime identity and the dedicated preparation identity may receive Cloud SQL Client."
  }

  assert {
    condition = (
      length(google_secret_manager_secret.postgres_password) == 2 &&
      length(google_secret_manager_secret_iam_member.postgres_password_accessor) == 2
    )
    error_message = "The plan must create exactly two empty secret containers with per-secret access."
  }

  assert {
    condition = (
      length(google_storage_bucket_iam_member.preparation_sources) == 1 &&
      google_storage_bucket_iam_member.preparation_sources[0].role == "roles/storage.objectViewer" &&
      endswith(google_storage_bucket_iam_member.preparation_sources[0].condition[0].expression, "/objects/staging/preparation/sources/')")
    )
    error_message = "Preparation must only read source artifacts under the dedicated prefix."
  }
}
