const retry = {
  maxAttempts: 3,
  delayMs: 5000,
  exponentialBackoff: true,
};
const smtpServer = {
  port: 2525,
  host: "0.0.0.0",
  authOptional: true,
  disabledCommands: ["STARTTLS"],
};
const accounts = (() => {
  const createGmailAccount = (user, pass, dailyLimit, hourlyLimit) => {
    user = (user + "").toLowerCase();
    // Ép kiểu số và đặt giá trị mặc định nếu không hợp lệ
    const daily = Number.isFinite(Number(dailyLimit)) ? Number(dailyLimit) : 400;
    const hourly = Number.isFinite(Number(hourlyLimit)) ? Number(hourlyLimit) : 100;
    return {
      id: user.split("@")[0] || "",
      host: "smtp.gmail.com",
      port: 465,
      auth: {
        user: user,
        pass: pass,
      },
      dailyLimit: daily,
      hourlyLimit: hourly,
    };
  };
  const resultAccounts = [];
  return resultAccounts;
})();
const rules = (() => {
  // Routing rules (kiểm tra từ trên xuống)
  // matches(match, email) {
  //   if (match.subject && !match.subject.test(email.subject || "")) return false;
  //   if (match.from && !match.from.test(email.from || "")) return false;
  //   if (match.to && !match.to.test(email.to || "")) return false;
  //   return true;
  // }
  return [
    {
      name: "Default",
      match: {}, // Match tất cả
      accounts: accounts.map((x) => x.id),
    },
    {
      name: "Critical",
      match: {
        subject: /\[CRITICAL\]|\[URGENT\]/i,
      },
      accounts: ["smtp1"], // Dùng riêng smtp1
    },
    {
      name: "Production",
      match: {
        subject: /prod-app|production/i,
        from: /@myorg\.com$/,
      },
      accounts: ["smtp1"],
    },
    {
      name: "Specific Org",
      match: {
        from: /@myorg\.com$/,
      },
      accounts: ["smtp2", "smtp1"],
    },
  ];
})();
// config.js
module.exports = {
  // SMTP Server (Gitea kết nối vào đây)
  smtpServer,
  // Các Gmail accounts để rotate
  accounts,
  // Routing rules (kiểm tra từ trên xuống)
  rules,
  //Cấu hình retry
  retry,
};
