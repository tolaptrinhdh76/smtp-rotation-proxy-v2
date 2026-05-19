// ============================================
// rotator.js
const nodemailer = require("nodemailer");
const fs = require("fs");

class Rotator {
  constructor(config) {
    this.config = config;
    this.accounts = new Map();
    this.statsFile = "./stats.json";

    // NEW: giữ state con trỏ theo từng rule name
    // { [ruleName]: { currentIndex: number } }
    this.ruleState = new Map();
    config.rules.forEach((r) => {
      // luôn bắt đầu ở index 0
      this.ruleState.set(r.name, { currentIndex: 0 });
    });

    // Khởi tạo accounts
    config.accounts.forEach((acc) => {
      this.accounts.set(acc.id, {
        config: acc,
        transporter: nodemailer.createTransport(acc),
        stats: {
          sentToday: 0,
          sentHour: 0,
          total: 0,
          errors: 0,
          lastResetDay: Date.now(),
          lastResetHour: Date.now(),
        },
      });
    });

    this.loadStats();
    this.startResetTimer();
  }

  loadStats() {
    try {
      if (fs.existsSync(this.statsFile)) {
        const data = JSON.parse(fs.readFileSync(this.statsFile, "utf8"));
        const today = new Date().toDateString();

        data.forEach((s) => {
          const acc = this.accounts.get(s.id);
          if (acc && new Date(s.lastResetDay).toDateString() === today) {
            acc.stats.sentToday = s.sentToday;
            acc.stats.total = s.total;
          }
        });
        console.log("✓ Stats loaded");
      }
    } catch (e) {
      console.log("No previous stats");
    }
  }

  saveStats() {
    const data = Array.from(this.accounts.entries()).map(([id, acc]) => ({
      id,
      sentToday: acc.stats.sentToday,
      total: acc.stats.total,
      lastResetDay: acc.stats.lastResetDay,
    }));
    fs.writeFileSync(this.statsFile, JSON.stringify(data));
  }

  startResetTimer() {
    setInterval(() => {
      const now = Date.now();

      this.accounts.forEach((acc) => {
        // Reset giờ
        const lastHour = new Date(acc.stats.lastResetHour);
        const nowH = new Date(now);
        if (lastHour.getHours() !== nowH.getHours() || now - acc.stats.lastResetHour >= 60 * 60 * 1000) {
          acc.stats.sentHour = 0;
          acc.stats.lastResetHour = now;
        }

        // Reset ngày (theo local time của server)
        const lastDayStr = new Date(acc.stats.lastResetDay).toDateString();
        const nowDayStr = new Date(now).toDateString();
        if (lastDayStr !== nowDayStr) {
          acc.stats.sentToday = 0;
          acc.stats.lastResetDay = now;
        }
      });

      this.saveStats(); // lưu đều đặn
    }, 60_000); // mỗi phút kiểm tra & save 1 lần
  }

  findRule(email) {
    for (const rule of this.config.rules) {
      if (this.matches(rule.match, email)) {
        return rule;
      }
    }
    return this.config.rules[this.config.rules.length - 1];
  }

  matches(match, email) {
    if (match.subject && !match.subject.test(email.subject || "")) return false;
    if (match.from && !match.from.test(email.from || "")) return false;
    if (match.to && !match.to.test(email.to || "")) return false;
    return true;
  }

  _isWithinQuota(acc) {
    const withinDaily = acc.stats.sentToday < acc.config.dailyLimit;
    const withinHourly = acc.stats.sentHour < acc.config.hourlyLimit;
    return withinDaily && withinHourly;
  }

  _advanceAccountForRule(rule) {
    const state = this.ruleState.get(rule.name);
    const list = rule.accounts.filter((id) => this.accounts.has(id));
    if (list.length === 0) throw new Error("No valid accounts configured for rule: " + rule.name);

    for (let step = 0; step < list.length; step++) {
      state.currentIndex = (state.currentIndex + 1) % list.length;
      const nextId = list[state.currentIndex];
      const acc = this.accounts.get(nextId);
      if (acc && this._isWithinQuota(acc)) {
        return nextId;
      }
    }
    throw new Error("All accounts in rule exhausted quota: " + rule.name);
  }

  _getCurrentAccountId(rule) {
    const state = this.ruleState.get(rule.name);
    const list = rule.accounts.filter((id) => this.accounts.has(id));
    if (list.length === 0) throw new Error("No valid accounts configured for rule: " + rule.name);

    // Nếu con trỏ đang trỏ vào account không tồn tại/quota, tự động nhảy tới account tiếp theo có quota
    let accId = list[state.currentIndex % list.length];
    let acc = this.accounts.get(accId);

    if (!acc || !this._isWithinQuota(acc)) {
      accId = this._advanceAccountForRule(rule);
      acc = this.accounts.get(accId);
    }
    return accId;
  }

  selectAccount(accountIds) {
    // Bỏ logic cân bằng/least-used; luôn dùng con trỏ của rule
    const accId = this._getCurrentAccountId(rule);
    console.log(`  Using account (by rule pointer): ${accId}`);
    return accId;
  }

  async send(email) {
    const rule = this.findRule(email);
    let lastError;
    let triedAccounts = new Set();

    for (let i = 0; i <= this.config.retry.maxAttempts; i++) {
      try {
        // Lấy account chưa thử
        const availableAccounts = rule.accounts.filter((id) => !triedAccounts.has(id));

        if (availableAccounts.length === 0) {
          throw new Error("All accounts in rule failed, tried: " + Array.from(triedAccounts).join(", "));
        }
        console.log(`  availableAccounts: ${JSON.stringify(availableAccounts)}`);
        const accId = this.selectAccount(availableAccounts);
        const acc = this.accounts.get(accId);
        triedAccounts.add(accId);

        console.log(`[${i + 1}/${this.config.retry.maxAttempts + 1}] ${accId} (${rule.name})`);
        console.log(`  Account: ${acc.config.auth.user}`);
        console.log(`  Host: ${acc.config.host}:${acc.config.port}`);
        console.log(`  To: ${email.to}`);
        console.log(`  Subject: ${email.subject}`);

        const result = await acc.transporter.sendMail(email);

        acc.stats.sentToday++;
        acc.stats.sentHour++;
        acc.stats.total++;

        console.log(`✓ Sent via ${accId} (${acc.stats.sentToday} today)`);

        return { success: true, accId, messageId: result.messageId };
      } catch (error) {
        lastError = error;

        // Đánh dấu account này có lỗi
        const lastTriedAccount = Array.from(triedAccounts).pop();
        if (lastTriedAccount) {
          const acc = this.accounts.get(lastTriedAccount);
          if (acc) {
            acc.stats.errors++;
          }
        }

        // Kiểm tra lỗi authentication/credentials
        const isAuthError =
          error.message.includes("Invalid login") ||
          error.message.includes("authentication") ||
          error.message.includes("BadCredentials") ||
          error.message.includes("535");

        // Kiểm tra lỗi quota
        const isQuotaError =
          error.message.includes("quota") || error.message.includes("limit") || error.message.includes("550") || error.message.includes("421");

        if (isAuthError || isQuotaError) {
          console.error(`✗ ${isAuthError ? "Auth failed" : "Quota reached"}, trying next account...`);

          // Đánh dấu account này có vấn đề
          if (lastTriedAccount) {
            const acc = this.accounts.get(lastTriedAccount);
            if (acc && isQuotaError) {
              acc.stats.sentToday = acc.config.dailyLimit;
            }
          }

          // Thử account khác NGAY trong cùng attempt
          if (triedAccounts.size < rule.accounts.length) {
            continue; // Không tăng i, thử account khác
          }
        }

        console.error(`✗ Failed: ${error.message}`);

        if (i < this.config.retry.maxAttempts) {
          const delay = this.config.retry.exponentialBackoff ? this.config.retry.delayMs * Math.pow(2, i) : this.config.retry.delayMs;
          console.log(`  Retry in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastError;
  }
  async send(email) {
    const rule = this.findRule(email);
    let lastError;

    for (let i = 0; i <= this.config.retry.maxAttempts; i++) {
      let accId, acc;
      try {
        // 1) Lấy account hiện tại của rule (hoặc auto-advance nếu account hiện tại đã hết quota)
        accId = this._getCurrentAccountId(rule);
        // accId = this.selectAccount(rule.accounts, rule);
        acc = this.accounts.get(accId);

        console.log(`[${i + 1}/${this.config.retry.maxAttempts + 1}] ${accId} (${rule.name})`);
        console.log(`  Account: ${acc.config.auth.user}`);
        console.log(`  Host: ${acc.config.host}:${acc.config.port}`);
        console.log(`  To: ${email.to}`);
        console.log(`  Subject: ${email.subject}`);

        const result = await acc.transporter.sendMail(email);

        // 2) Cập nhật thống kê
        acc.stats.sentToday++;
        acc.stats.sentHour++;
        acc.stats.total++;

        console.log(`✓ Sent via ${accId} (${acc.stats.sentToday} today)`);

        // 3) Nếu sau lần gửi này account chạm ngưỡng => advance con trỏ CHO LẦN GỬI SAU
        if (!this._isWithinQuota(acc)) {
          console.log(`  Quota reached for ${accId}, advancing pointer for rule "${rule.name}"`);
          this._advanceAccountForRule(rule);
        }

        return { success: true, accId, messageId: result.messageId };
      } catch (error) {
        lastError = error;
        console.error(`✗ Failed: ${error.message}`);

        // Phân loại lỗi
        const msg = error && error.message ? error.message : "";
        const isAuthError = /Invalid login|authentication|BadCredentials|535/i.test(msg);
        const isQuotaError = /quota|limit|550|421/i.test(msg);

        // Ghi nhận lỗi vào account hiện tại (nếu có)
        if (accId && this.accounts.has(accId)) {
          const accRef = this.accounts.get(accId);
          accRef.stats.errors++;
          // Nếu là lỗi quota thì "đánh dấu đã hết quota" cho tới hết ngày/giờ
          if (isQuotaError) {
            accRef.stats.sentToday = Math.max(accRef.stats.sentToday, accRef.config.dailyLimit);
            accRef.stats.sentHour = Math.max(accRef.stats.sentHour, accRef.config.hourlyLimit);
          }
        }

        // CHỈ đổi tài khoản nếu là lỗi quota hoặc auth
        if (isAuthError || isQuotaError) {
          try {
            const nextId = this._advanceAccountForRule(rule);
            console.error(`  ${isAuthError ? "Auth" : "Quota"} issue -> switch to next account: ${nextId}`);
            // Không tăng vòng lặp i ở đây; thử lại ngay (vẫn tính cùng attempt i)
            continue;
          } catch (advanceErr) {
            console.error(`  No alternative account available: ${advanceErr.message}`);
            // hết tài khoản để xoay -> rơi xuống retry exponential/backoff
          }
        }

        // Retry nếu còn lượt
        if (i < this.config.retry.maxAttempts) {
          const delay = this.config.retry.exponentialBackoff ? this.config.retry.delayMs * Math.pow(2, i) : this.config.retry.delayMs;
          console.log(`  Retry in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastError;
  }

  getStats() {
    return Array.from(this.accounts.entries()).map(([id, acc]) => {
      const cfg = acc.config;
      return {
        id,
        email: cfg.auth.user,
        today: `${acc.stats.sentToday}/${cfg.dailyLimit}`,
        hour: `${acc.stats.sentHour}/${cfg.hourlyLimit}`,
        total: acc.stats.total,
        errors: acc.stats.errors,
        available: acc.stats.sentToday < cfg.dailyLimit && acc.stats.sentHour < cfg.hourlyLimit,
      };
    });
  }

  printStats() {
    console.log("\n=== STATS ===");
    this.getStats().forEach((s) => {
      console.log(`${s.email} ${s.available ? "✓" : "✗"}`);
      console.log(`  Today: ${s.today} | Hour: ${s.hour} | Total: ${s.total} | Errors: ${s.errors}`);
    });
    console.log("");
  }
}

module.exports = Rotator;
