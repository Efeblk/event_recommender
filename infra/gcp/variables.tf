variable "project_id" {
  description = "Existing, billing-linked project dedicated to Bi Plan staging. No project or billing association is created here."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Provide the explicit ID of a dedicated existing GCP project."
  }
}

variable "dedicated_billing_project_confirmed" {
  description = "Set true only after verifying this project is dedicated to Bi Plan staging and already has billing enabled."
  type        = bool
  default     = false
  validation {
    condition     = var.dedicated_billing_project_confirmed
    error_message = "Verify the dedicated project and its existing billing association before planning or applying."
  }
}

variable "region" {
  description = "One region for Cloud Run, Firestore, GCS, and Artifact Registry. Select before creating the database."
  type        = string
  default     = "us-central1"
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.region))
    error_message = "Use a regional location, not a multi-region."
  }
}

variable "collection_bucket_name" {
  description = "Optional globally unique staging bucket name. Empty uses PROJECT_ID-biplan-staging-data."
  type        = string
  default     = ""
  validation {
    condition     = var.collection_bucket_name == "" || (can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.collection_bucket_name)) && strcontains(var.collection_bucket_name, "staging"))
    error_message = "Use a valid 3-63 character bucket name containing staging."
  }
}

variable "github_repository" {
  description = "Exact GitHub owner/repository permitted to request the deployment identity."
  type        = string
  default     = "Efeblk/event_recommender"
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "Provide an owner/repository name."
  }
}

variable "github_repository_id" {
  description = "Immutable numeric repository ID, verified with gh api on 2026-09-27. Reverify when changing repositories."
  type        = string
  default     = "1107941471"
  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "A numeric GitHub repository ID is required."
  }
}

variable "github_repository_owner_id" {
  description = "Immutable numeric owner ID, verified with gh api on 2026-09-27."
  type        = string
  default     = "108200358"
  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_owner_id))
    error_message = "A numeric GitHub repository owner ID is required."
  }
}

variable "github_allowed_branch" {
  description = "Only this branch may use the gcp-staging environment deployment identity. Set explicitly to test a reviewed migration branch."
  type        = string
  default     = "master"
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9_./-]*$", var.github_allowed_branch)) && !strcontains(var.github_allowed_branch, "..")
    error_message = "Use a single literal branch name, without refs/heads/ or wildcards."
  }
}

variable "budget_billing_account" {
  description = "Optional existing billing account ID (XXXXXX-XXXXXX-XXXXXX) for a project-filtered budget. Does not link billing or impose a spending cap."
  type        = string
  default     = ""
  validation {
    condition     = var.budget_billing_account == "" || can(regex("^[A-Fa-f0-9]{6}-[A-Fa-f0-9]{6}-[A-Fa-f0-9]{6}$", var.budget_billing_account))
    error_message = "Use an existing billing account ID or leave empty to omit the optional budget."
  }
}

variable "budget_amount_usd" {
  description = "Whole-dollar monthly alert threshold, only used when budget_billing_account is set."
  type        = number
  default     = 5
  validation {
    condition     = var.budget_amount_usd >= 1 && floor(var.budget_amount_usd) == var.budget_amount_usd
    error_message = "Use a positive whole-dollar amount."
  }
}

variable "budget_notification_channels" {
  description = "Optional existing Monitoring notification channel IDs; no email addresses or channels are created."
  type        = list(string)
  default     = []
  validation {
    condition     = length(var.budget_notification_channels) <= 5 && alltrue([for channel in var.budget_notification_channels : can(regex("^projects/[^/]+/notificationChannels/[0-9]+$", channel))])
    error_message = "Supply at most five existing projects/PROJECT/notificationChannels/NUMBER resource names."
  }
}
