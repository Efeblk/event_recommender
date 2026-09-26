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
      currency_code = "USD"
      units         = tostring(var.budget_amount_usd)
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
  all_updates_rule {
    monitoring_notification_channels = var.budget_notification_channels
    disable_default_iam_recipients   = false
  }
  depends_on = [google_project_service.required]
}
