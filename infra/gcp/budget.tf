resource "google_billing_budget" "staging" {
  count           = var.budget_billing_account != "" ? 1 : 0
  billing_account = var.budget_billing_account
  display_name    = "Bi Plan staging monthly alert"
  budget_filter {
    projects               = ["projects/${data.google_project.selected.number}"]
    calendar_period        = "MONTH"
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }
  amount {
    specified_amount {
      currency_code = var.budget_currency_code
      units         = tostring(var.budget_amount)
    }
  }
  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 1
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 1
    spend_basis       = "FORECASTED_SPEND"
  }
  # Google omits an all-default rule from its response. Only emit this block
  # when custom channels exist, avoiding perpetual drift for IAM-only alerts.
  dynamic "all_updates_rule" {
    for_each = length(var.budget_notification_channels) > 0 ? [true] : []
    content {
      monitoring_notification_channels = var.budget_notification_channels
      disable_default_iam_recipients   = false
    }
  }
  depends_on = [google_project_service.required]
}
