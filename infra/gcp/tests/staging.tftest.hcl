mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number          = "123456789012"
      project_id      = "biplan-offline-test"
      billing_account = "ABCDEF-123456-ABCDEF"
    }
  }
}

variables {
  project_id                          = "biplan-offline-test"
  dedicated_billing_project_confirmed = true
}

run "private_staging_plan" {
  command = plan

  assert {
    condition     = google_firestore_database.catalog_control.name == "(default)" && google_firestore_database.catalog_control.type == "FIRESTORE_NATIVE" && google_firestore_database.catalog_control.location_id == var.region
    error_message = "The native default database must share the application's region."
  }
  assert {
    condition     = google_storage_bucket.collection.public_access_prevention == "enforced" && google_storage_bucket.collection.uniform_bucket_level_access && !google_storage_bucket.collection.force_destroy && length(google_storage_bucket.collection.lifecycle_rule) == 0
    error_message = "The catalog bucket must stay private and must not expire referenced source objects."
  }
  assert {
    condition     = length(google_secret_manager_secret.application) == 3 && length(google_secret_manager_secret_iam_member.runtime_secret) == 3
    error_message = "Only the three named application secrets and scoped runtime access should be prepared."
  }
  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "1107941471") && strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "108200358") && strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "environment:gcp-staging") && strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "gcp-staging.yml@refs/heads/master")
    error_message = "Deployment trust must bind immutable repository identities, protected environment, workflow, and exact branch."
  }
  assert {
    condition     = google_iam_workload_identity_pool.github.workload_identity_pool_id != google_iam_workload_identity_pool.collector.workload_identity_pool_id && strcontains(google_iam_workload_identity_pool_provider.collector.attribute_condition, "gcp-collector.yml@refs/heads/master") && google_project_iam_member.collector_invoker.role == "roles/run.invoker"
    error_message = "The collector must have separate workflow trust and invocation-only cloud permissions."
  }
  assert {
    condition     = length(google_billing_budget.staging) == 0
    error_message = "A billing budget must remain optional without an explicit account."
  }
}

run "unconfirmed_project_rejected" {
  command = plan
  variables { dedicated_billing_project_confirmed = false }
  expect_failures = [var.dedicated_billing_project_confirmed]
}

run "optional_budget_and_reviewed_branch" {
  command = plan
  variables {
    budget_billing_account = "ABCDEF-123456-ABCDEF"
    github_allowed_branch  = "t3code/gcp-migration"
  }
  assert {
    condition     = length(google_billing_budget.staging) == 1 && google_billing_budget.staging[0].amount[0].specified_amount[0].units == "5"
    error_message = "An explicitly selected account should produce the five-dollar alert configuration."
  }
  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "refs/heads/t3code/gcp-migration") && !strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "refs/heads/master")
    error_message = "A reviewed branch override must replace, not broaden, branch trust."
  }
}

run "wrong_billing_account_rejected" {
  command = plan
  variables { budget_billing_account = "AAAAAA-BBBBBB-CCCCCC" }
  expect_failures = [data.google_project.selected]
}
