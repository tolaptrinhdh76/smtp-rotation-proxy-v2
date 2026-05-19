require('dotenv').config();

const DEFAULT_DAILY_LIMIT = Number(process.env.DEFAULT_DAILY_LIMIT || 400);
const DEFAULT_HOURLY_LIMIT = Number(process.env.DEFAULT_HOURLY_LIMIT || 100);

module.exports = {
  smtpServer: {
    authOptional: String(process.env.SMTP_AUTH_OPTIONAL || 'true') === 'true',
    disabledCommands: ['STARTTLS'],
  },
  retry: {
    maxAttempts: Number(process.env.RETRY_MAX_ATTEMPTS || 3),
    delayMs: Number(process.env.RETRY_DELAY_MS || 5000),
    exponentialBackoff: String(process.env.RETRY_EXPONENTIAL_BACKOFF || 'true') === 'true',
  },
  settings: {
    defaultDailyLimit: DEFAULT_DAILY_LIMIT,
    defaultHourlyLimit: DEFAULT_HOURLY_LIMIT,
  },
  accounts: [],
  rules: [{ id: 'default', name: 'Default', order: 999, match: {}, accounts: [], enabled: true }],
};
