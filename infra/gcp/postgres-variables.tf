variable "postgres_staging_enabled" {
  description = "Create the approved, paid Cloud SQL staging resources. This remains false until the user approves the concrete staging activation bundle."
  type        = bool
  default     = false
}

variable "postgres_activation_authorization_reference" {
  description = "Non-secret reference to the recorded user approval for the Cloud SQL staging activation bundle. Required only when postgres_staging_enabled is true."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.postgres_staging_enabled ||
      can(regex("^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,255}$", trimspace(var.postgres_activation_authorization_reference)))
    )
    error_message = "postgres_activation_authorization_reference must identify the recorded approval (at least 8 non-whitespace characters) when postgres_staging_enabled is true."
  }
}
