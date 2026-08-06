export { sendTemplate, getDeliveryStatus, emailHealthCheck, retryDelivery, retryAllFailedDeliveries, type SendTemplateRequest, type SendTemplateResult, type SendTemplateStatus, type RelatedEntityType, type RetrySweepResult } from './service'
export { getEmailProvider, listRegisteredEmailProviders } from './registry'
export { EMAIL_TEMPLATES, getEmailTemplate, renderTemplate, TemplateValidationError, type EmailTemplateDef, type TemplateVars } from './templates/catalogue'
export { loadBookingEmailContext, loadListingEmailContext, loadUserDisplayName, loadDisputeEmailContext, loadBarterEmailContext, loadOrderEmailContext, loadAffiliateCommissionEmailContext, loadAffiliateListingEmailContext, formatMoney, formatDateTime, type BookingEmailContext, type ListingEmailContext, type DisputeEmailContext, type BarterEmailContext, type OrderEmailContext, type AffiliateCommissionEmailContext, type AffiliateListingEmailContext } from './context'
export { dispatchPaymentExpiredEmails } from './dispatch-expiry'
export { sendDuePaymentReminders, PAYMENT_REMINDER_HOURS_BEFORE_DUE, type ReminderSweepResult } from './reminders'
export {
  EmailConfigurationError,
  InvalidRecipientError,
  EmailTimeoutError,
  RetryableEmailError,
  RateLimitedEmailError,
  TerminalEmailError,
  isRetryableEmailError,
} from './errors'
