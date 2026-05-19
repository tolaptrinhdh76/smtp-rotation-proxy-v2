# AGENT DEPLOYMENT PROMPT — smtp-rotation-proxy v2

> **Chỉ thị cho agent**: Đọc toàn bộ prompt này trước khi viết bất kỳ dòng code nào. Không được hỏi lại. Không được bỏ qua bất kỳ mục nào. Triển khai tuần tự theo thứ tự mục đã liệt kê. Sau khi tạo xong mỗi file quan trọng thì commit ngay.

---

## 0. Bối cảnh & Codebase hiện tại

Dự án hiện có các file sau (giữ nguyên toàn bộ logic, chỉ refactor để tích hợp):

| File | Vai trò |
|---|---|
| `server.js` | SMTP proxy server + TCP shim (port 2525→2626) để tương thích Gitea |
| `rotator.js` | Logic rotate accounts, tracking quota, retry có exponential backoff |
| `config.js` | Cấu hình tĩnh accounts + routing rules |
| `stats.json` | File stats local |
| `package.json` | Dependencies: `smtp-server`, `nodemailer`, `mailparser` |

**Logic cốt lõi cần bảo toàn 100%:**
- TCP Shim tại port `2525` → forward sang SMTPServer nội bộ `2626`, tự động fix `MAIL FROM:addr` → `MAIL FROM:<addr>` (đảm bảo tương thích Gitea và các hệ thống không đặt `<>`)
- `Rotator` class: con trỏ per-rule, `_getCurrentAccountId`, `_advanceAccountForRule`, quota check (`dailyLimit`, `hourlyLimit`), retry + exponential backoff, `findRule` + `matches` (match by `subject`/`from`/`to` regex)
- `loadStats` / `saveStats` / `startResetTimer` (reset theo giờ và ngày)
- Bảo toàn `Reply-To`, `Message-ID`, `In-Reply-To`, `References`, `List-ID` headers (quan trọng cho email threading của Gitea)

---

## 1. Mục tiêu dự án v2

Nâng cấp thành một hệ thống hoàn chỉnh:

1. **Giữ nguyên toàn bộ logic SMTP proxy + rotator hiện tại**
2. **Thêm: override account per-request** — nếu client SMTP truyền credentials (user/pass) hợp lệ khớp một account trong DB thì dùng đúng account đó để gửi, không rotate
3. **REST API** để quản lý accounts, rules, stats — bảo vệ bằng `API_SECRET` trong header
4. **Web UI** để quản lý accounts (add/edit/delete/test/import/export/backup) — bảo vệ bằng Caddy basic auth
5. **Firebase Realtime Database** làm primary storage (accounts, rules, stats)
6. **Môi trường cấu hình** qua `.env` + hướng dẫn rõ ràng
7. **File `.http`** để test toàn bộ API
8. **Phần From**: nếu account có cấu hình `fromName` / `fromAddress` thì override From khi gửi
9. **UI hỗ trợ nhiều SMTP provider** phổ biến (Gmail, Outlook/Hotmail, Yahoo, Zoho, SendGrid SMTP, Mailgun SMTP, custom)
10. **Import/Export** accounts dạng CSV và JSON

---

## 2. Cấu trúc thư mục đích

```
smtp-rotation-proxy/
├── .env.example              # Mẫu env đầy đủ + hướng dẫn lấy từng giá trị
├── .env                      # Không commit (gitignore)
├── .gitignore
├── package.json              # Thêm: express, firebase-admin, dotenv, cors, multer
├── server.js                 # Giữ nguyên + tích hợp override-account logic
├── rotator.js                # Giữ nguyên + nhận config từ Firebase + From override
├── config.js                 # Fallback config nếu Firebase chưa sẵn sàng
├── db/
│   └── firebase.js           # Firebase Admin SDK init + helper CRUD
├── api/
│   ├── index.js              # Express app, mount routes, auth middleware
│   ├── routes/
│   │   ├── accounts.js       # CRUD accounts
│   │   ├── rules.js          # CRUD routing rules
│   │   ├── stats.js          # GET stats, reset stats
│   │   ├── test.js           # POST /test-send (test một account cụ thể)
│   │   ├── backup.js         # GET /backup (dump toàn bộ config+stats dạng JSON)
│   │   └── import-export.js  # POST /import, GET /export (JSON + CSV)
├── ui/
│   ├── index.html            # Single-page app (vanilla HTML+CSS+JS, không framework)
│   ├── app.js                # Frontend logic
│   └── style.css             # Theo DESIGN.md (Airtable design system)
├── Caddyfile.example         # Mẫu Caddy config với basic_auth + reverse_proxy
├── docker-compose.yml        # Node app + (optional) Caddy
├── Dockerfile
├── tests/
│   └── api.http              # HTTPie / REST Client file test toàn bộ endpoint
├── CHANGE_LOGS.md
└── CHANGE_LOGS_USER.md
```

---

## 3. Môi trường `.env`

Tạo file `.env.example` với nội dung sau **và hướng dẫn chi tiết cách lấy từng giá trị**:

```dotenv
# ═══════════════════════════════════════════════════════════════
# SMTP ROTATION PROXY — Environment Configuration
# ═══════════════════════════════════════════════════════════════
# Sao chép file này thành .env và điền các giá trị thực.
# Đừng commit file .env lên git.

# ───────────────────────────────────────────────────────────────
# SERVER
# ───────────────────────────────────────────────────────────────
NODE_ENV=production
PORT_API=3000          # REST API & UI sẽ chạy ở cổng này
PORT_SMTP_EXT=2525     # Cổng Gitea/client kết nối vào
PORT_SMTP_INT=2626     # Cổng nội bộ SMTPServer (không expose ra ngoài)

# ───────────────────────────────────────────────────────────────
# API SECRET (bảo vệ REST API)
# ───────────────────────────────────────────────────────────────
# Tạo bằng: openssl rand -hex 32
API_SECRET=your-strong-random-secret-here

# ───────────────────────────────────────────────────────────────
# FIREBASE REALTIME DATABASE
# ───────────────────────────────────────────────────────────────
# Hướng dẫn lấy thông tin:
# 1. Vào https://console.firebase.google.com
# 2. Tạo project (hoặc dùng project có sẵn)
# 3. Vào Project Settings > Service Accounts
# 4. Click "Generate new private key" → tải file JSON
# 5. Mở file JSON, lấy các giá trị tương ứng bên dưới:
#    - "project_id" → FIREBASE_PROJECT_ID
#    - "client_email" → FIREBASE_CLIENT_EMAIL
#    - "private_key" → FIREBASE_PRIVATE_KEY (giữ nguyên \n, bọc trong dấu "")
# 6. Vào Realtime Database > Create database > lấy URL (dạng https://xxx.firebaseio.com)
#    → FIREBASE_DATABASE_URL
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxx@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMII...\n-----END RSA PRIVATE KEY-----\n"
FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com

# ───────────────────────────────────────────────────────────────
# CADDY / UI AUTH (cấu hình trong Caddyfile, không phải ở đây)
# ───────────────────────────────────────────────────────────────
# UI được bảo vệ bởi Caddy basic_auth.
# Xem Caddyfile.example để cấu hình username/password.
# Tạo hash password cho Caddy: caddy hash-password --plaintext "yourpassword"

# ───────────────────────────────────────────────────────────────
# SMTP SERVER OPTIONS
# ───────────────────────────────────────────────────────────────
SMTP_AUTH_OPTIONAL=true   # true = Gitea không cần auth; false = bắt buộc auth

# ───────────────────────────────────────────────────────────────
# RETRY
# ───────────────────────────────────────────────────────────────
RETRY_MAX_ATTEMPTS=3
RETRY_DELAY_MS=5000
RETRY_EXPONENTIAL_BACKOFF=true

# ───────────────────────────────────────────────────────────────
# DEFAULT QUOTA (áp dụng khi tạo account không chỉ định)
# ───────────────────────────────────────────────────────────────
DEFAULT_DAILY_LIMIT=400
DEFAULT_HOURLY_LIMIT=100
```

---

## 4. Firebase Database Schema

Cấu trúc Realtime Database (JSON path):

```
/smtp-proxy/
  /accounts/
    /{accountId}/
      id: string               # = email prefix hoặc custom id
      host: string             # "smtp.gmail.com"
      port: number             # 465
      secure: boolean          # true (SSL)
      auth/
        user: string           # email
        pass: string           # app password (lưu plain text, Firebase rules restrict access)
      dailyLimit: number
      hourlyLimit: number
      fromName: string         # (optional) hiển thị tên người gửi
      fromAddress: string      # (optional) override From address
      provider: string         # "gmail" | "outlook" | "yahoo" | "zoho" | "sendgrid" | "mailgun" | "custom"
      enabled: boolean
      createdAt: number        # timestamp
      updatedAt: number

  /rules/
    /{ruleId}/
      name: string
      order: number            # thứ tự ưu tiên (nhỏ hơn = cao hơn)
      match/
        subject: string        # regex pattern (string, sẽ compile thành RegExp)
        from: string
        to: string
      accounts: [accountId]    # mảng accountId
      enabled: boolean

  /stats/
    /{accountId}/
      sentToday: number
      sentHour: number
      total: number
      errors: number
      lastResetDay: number
      lastResetHour: number

  /settings/
    retryMaxAttempts: number
    retryDelayMs: number
    retryExponentialBackoff: boolean
    defaultDailyLimit: number
    defaultHourlyLimit: number
```

**Firebase Security Rules** (thêm vào `database.rules.json` và hướng dẫn deploy):

```json
{
  "rules": {
    "smtp-proxy": {
      ".read": false,
      ".write": false
    }
  }
}
```

Mọi access đều qua Firebase Admin SDK (server-side), không cho phép client-side direct access.

---

## 5. `db/firebase.js` — Firebase helper

```javascript
// db/firebase.js
// Khởi tạo Firebase Admin SDK
// Export các helper: getAccounts(), setAccount(), deleteAccount(),
//                    getRules(), setRule(), deleteRule(),
//                    getStats(), updateStats(), resetStats()
//                    getSettings(), updateSettings()
// Nếu Firebase chưa sẵn sàng (env chưa set), fallback về config.js local
```

Yêu cầu:
- Dùng `firebase-admin` package
- Đọc credentials từ env
- Có `isFirebaseReady()` helper trả về `true/false`
- Mọi hàm đều có try/catch, log lỗi rõ ràng
- `getAccounts()` trả về array đã sắp xếp theo `createdAt`
- `getRules()` trả về array đã sắp xếp theo `order`

---

## 6. `rotator.js` — Nâng cấp

Giữ nguyên toàn bộ logic. Bổ sung thêm:

### 6.1 Nhận config từ Firebase

Constructor nhận `config` như cũ, nhưng trước khi khởi tạo, nếu Firebase ready thì load accounts + rules từ Firebase (overwrite config in-memory). Thêm method `reloadFromFirebase()` để UI có thể trigger reload sau khi edit account.

### 6.2 From override

Trong method `send(email)`, sau khi chọn được `accId`:

```javascript
// Nếu account có fromName hoặc fromAddress, override From
const acc = this.accounts.get(accId);
if (acc.config.fromAddress) {
  const displayName = acc.config.fromName || acc.config.fromAddress;
  email.from = `"${displayName}" <${acc.config.fromAddress}>`;
}
```

### 6.3 Override account per-request

Thêm method `sendWithAccount(email, accountId)` — dùng đúng accountId được chỉ định, bỏ qua rotate logic. Vẫn áp dụng From override và stats tracking.

---

## 7. `server.js` — Nâng cấp

Giữ nguyên 100% TCP shim và SMTPServer logic. Bổ sung:

### 7.1 Override account qua SMTP AUTH

Trong `onAuth(auth, session, callback)`:

```javascript
onAuth(auth, session, callback) {
  // Nếu auth.username là email của một account đã config
  // thì lưu accountId vào session để onData dùng
  const matchedAccount = rotator.findAccountByEmail(auth.username);
  if (matchedAccount) {
    // verify password (so sánh với app password trong config)
    if (matchedAccount.config.auth.pass === auth.password) {
      session.overrideAccountId = matchedAccount.config.id;
      return callback(null, { user: auth.username });
    }
  }
  // Fallback: auth optional, accept anyway
  callback(null, { user: auth.username || 'anonymous' });
}
```

Trong `onData`, nếu `session.overrideAccountId` có giá trị thì gọi `rotator.sendWithAccount(email, session.overrideAccountId)` thay vì `rotator.send(email)`.

### 7.2 Mount Express API

```javascript
const apiApp = require('./api/index');
apiApp.listen(process.env.PORT_API || 3000, () => {
  console.log(`✓ API & UI on port ${process.env.PORT_API || 3000}`);
});
```

---

## 8. REST API — `api/`

### 8.1 Auth middleware

```javascript
// Tất cả route /api/* yêu cầu header: X-API-Secret: <API_SECRET>
function apiAuth(req, res, next) {
  const secret = req.headers['x-api-secret'];
  if (!secret || secret !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
```

### 8.2 Routes

#### `GET /api/accounts`
Trả về mảng accounts (password được mask: chỉ hiện 4 ký tự cuối).

#### `POST /api/accounts`
Tạo account mới. Body JSON:
```json
{
  "provider": "gmail",
  "auth": { "user": "example@gmail.com", "pass": "app-password" },
  "dailyLimit": 400,
  "hourlyLimit": 100,
  "fromName": "My App",
  "fromAddress": "noreply@mydomain.com",
  "enabled": true
}
```
Server tự resolve `host`, `port`, `secure` từ `provider`. Validate bắt buộc: `provider`, `auth.user`, `auth.pass`.

**Provider presets:**
```javascript
const PROVIDER_PRESETS = {
  gmail:    { host: 'smtp.gmail.com',        port: 465, secure: true },
  outlook:  { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  hotmail:  { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  yahoo:    { host: 'smtp.mail.yahoo.com',   port: 465, secure: true },
  zoho:     { host: 'smtp.zoho.com',         port: 465, secure: true },
  sendgrid: { host: 'smtp.sendgrid.net',     port: 587, secure: false },
  mailgun:  { host: 'smtp.mailgun.org',      port: 587, secure: false },
  custom:   null, // phải tự nhập host, port, secure
};
```

#### `PUT /api/accounts/:id`
Update một account. Không được đổi `id`. Nếu `pass` là chuỗi rỗng hoặc masked thì giữ nguyên password cũ.

#### `DELETE /api/accounts/:id`
Xóa account. Trả về 400 nếu account đang được dùng trong bất kỳ rule nào.

#### `POST /api/accounts/:id/test`
Test gửi email thật qua account này. Body:
```json
{ "to": "test@example.com" }
```
Gửi email test và trả về kết quả (success/error + thời gian).

#### `GET /api/rules`
Trả về tất cả rules đã sort theo `order`.

#### `POST /api/rules`
Tạo rule mới. Body:
```json
{
  "name": "Critical",
  "order": 1,
  "match": { "subject": "\\[CRITICAL\\]", "from": "", "to": "" },
  "accounts": ["accountId1", "accountId2"],
  "enabled": true
}
```
`match` fields là regex string (compile về RegExp khi dùng).

#### `PUT /api/rules/:id`
Update rule.

#### `DELETE /api/rules/:id`
Xóa rule (không được xóa rule `Default` cuối cùng).

#### `GET /api/stats`
Trả về stats tất cả accounts.

#### `POST /api/stats/reset`
Reset stats (`today` + `hour`) cho tất cả hoặc một account cụ thể.
Body: `{ "accountId": "optional-specific-id" }`

#### `GET /api/backup`
Dump toàn bộ: accounts (password masked), rules, stats, settings dưới dạng JSON.
Response header: `Content-Disposition: attachment; filename="smtp-backup-{date}.json"`

#### `POST /api/import`
Import accounts + rules từ JSON hoặc CSV.
- Multipart form-data, field `file`, accept `.json` và `.csv`
- JSON format: `{ accounts: [...], rules: [...] }`
- CSV format cho accounts: `provider,user,pass,dailyLimit,hourlyLimit,fromName,fromAddress,enabled`
- Merge strategy: nếu account `id` đã tồn tại thì skip (không overwrite) trừ khi `?overwrite=true`
- Trả về `{ imported: N, skipped: M, errors: [...] }`

#### `GET /api/export`
Export accounts (password masked) + rules + stats dạng JSON hoặc CSV.
Query: `?format=json` (default) hoặc `?format=csv`
CSV chỉ export accounts.

#### `GET /api/health`
Health check không cần auth. Trả về:
```json
{
  "status": "ok",
  "firebase": true,
  "accountsTotal": 18,
  "accountsAvailable": 16,
  "uptime": 3600
}
```

---

## 9. Web UI — `ui/`

### 9.1 Design System (theo `DESIGN.md` — Airtable)

Áp dụng chính xác design system từ `DESIGN.md`. Không được tự ý thêm màu mới hay font mới.

**CSS Variables cần khai báo:**
```css
:root {
  --color-primary: #181d26;
  --color-primary-active: #0d1218;
  --color-canvas: #ffffff;
  --color-surface-soft: #f8fafc;
  --color-surface-strong: #e0e2e6;
  --color-surface-dark: #181d26;
  --color-hairline: #dddddd;
  --color-ink: #181d26;
  --color-body: #333840;
  --color-muted: #41454d;
  --color-on-primary: #ffffff;
  --color-link: #1b61c9;
  --color-signature-coral: #aa2d00;
  --color-signature-forest: #0a2e0e;
  --color-signature-cream: #f5e9d4;
  --color-signature-peach: #fcab79;
  --color-signature-mint: #a8d8c4;
  --color-success: #006400;
  --color-error: #aa2d00;

  --rounded-xs: 2px;
  --rounded-sm: 6px;
  --rounded-md: 10px;
  --rounded-lg: 12px;

  --spacing-xs: 8px;
  --spacing-sm: 12px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --spacing-xl: 32px;
  --spacing-xxl: 48px;
  --spacing-section: 96px;

  --font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
```

**Typography:**
- Display: 32px / weight 400
- Title: 20px / weight 400
- Label: 16px / weight 500
- Body: 14px / weight 400
- Button: 16px / weight 500

**Buttons:**
- Primary: `background: var(--color-primary)`, `color: var(--color-on-primary)`, `border-radius: var(--rounded-lg)`, `padding: 10px 20px`
- Secondary: `background: var(--color-canvas)`, `color: var(--color-ink)`, `border: 1px solid var(--color-hairline)`, `border-radius: var(--rounded-lg)`

**Cards:**
- `background: var(--color-canvas)`, `border: 1px solid var(--color-hairline)`, `border-radius: var(--rounded-md)`, `padding: var(--spacing-xl)`

### 9.2 Layout & Navigation

Single-page app với sidebar navigation:

```
┌─────────────────────────────────────────────────────┐
│ Top bar: Logo "SMTP Proxy" + Health status badge    │
├──────────┬──────────────────────────────────────────┤
│ Sidebar  │ Main content area                        │
│          │                                          │
│ • Accounts│                                         │
│ • Rules  │                                          │
│ • Stats  │                                          │
│ • Import │                                          │
│ • Export │                                          │
│ • Settings│                                         │
└──────────┴──────────────────────────────────────────┘
```

### 9.3 Trang Accounts

**Danh sách accounts:**
- Table/card grid hiển thị: provider icon, email, from name, today quota (x/400), hour quota (x/100), total sent, errors, enabled toggle, actions
- Filter: All / Available / Exhausted / Error
- Search by email
- Sort by: total sent, today sent, errors

**Add Account Modal:**
- Step 1: Chọn provider (Gmail, Outlook, Yahoo, Zoho, SendGrid, Mailgun, Custom) — hiển thị dạng card grid với logo/icon
- Step 2: Nhập credentials:
  - Email / Username
  - Password / App Password (masked input, show/hide toggle)
  - Daily Limit, Hourly Limit
  - From Name (optional), From Address (optional)
  - Enabled toggle
  - Nếu provider = `custom`: thêm Host, Port, Secure (SSL/TLS)
- Nút "Test connection" trước khi lưu — gọi `/api/accounts/:id/test`

**Edit Account:** Modal tương tự Add. Password field: hiển thị placeholder "••••••••", chỉ update nếu user nhập giá trị mới.

**Delete Account:** Confirm dialog. Nếu account đang dùng trong rule thì hiện cảnh báo.

**Bulk actions:** Checkbox để chọn nhiều, bulk enable/disable/delete.

**Import:** Nút "Import" mở modal với drag-and-drop file zone. Accept `.json` và `.csv`. Hiển thị preview trước khi confirm. Option "Overwrite existing".

**Export:** Nút "Export" mở dropdown: "Export JSON", "Export CSV".

### 9.4 Trang Rules

- Drag-and-drop reorder (thứ tự = priority)
- Mỗi rule hiển thị: name, match conditions (subject/from/to regex), accounts count, enabled toggle
- Add/Edit Rule Modal:
  - Name
  - Match conditions: subject regex, from regex, to regex (text input với hint "regex pattern, để trống = bỏ qua")
  - Accounts: multi-select dropdown từ danh sách accounts
  - Order: number (auto-set, có thể chỉnh)
  - Enabled toggle
- Không được xóa rule Default cuối cùng

### 9.5 Trang Stats

- Refresh button + auto-refresh toggle (30s)
- Summary cards ở top:
  - Total accounts
  - Available accounts
  - Total sent today
  - Total errors
- Table chi tiết mỗi account: email, today (x/limit với progress bar), hour (x/limit), total, errors, last activity
- "Reset Stats" button: confirm dialog, chọn reset all hoặc reset một account
- Mini chart: bar chart tổng emails sent per account (dùng CSS bars, không cần library)

### 9.6 Trang Settings

- API Secret: masked display + copy button (không cho xem full, chỉ confirm reset)
- Retry settings: maxAttempts, delayMs, exponentialBackoff
- Default quotas: defaultDailyLimit, defaultHourlyLimit
- Save button gọi `PUT /api/settings`

### 9.7 UX Details

- Mọi action đều có loading state (button disabled + spinner)
- Toast notifications (top-right) cho success/error
- Không dùng bất kỳ CSS framework nào (Bootstrap, Tailwind) — viết CSS thuần theo DESIGN.md
- Không dùng bất kỳ JS framework nào (React, Vue) — vanilla JS ES6+
- Fetch API với async/await
- `X-API-Secret` được lưu trong `sessionStorage` sau khi user nhập lần đầu
- Nếu API trả 401, redirect về màn hình nhập secret

---

## 10. Caddy Configuration

### `Caddyfile.example`

```caddyfile
# Caddyfile.example
# Thay "smtp.yourdomain.com" bằng domain thật của bạn.
# Tạo hash password: caddy hash-password --plaintext "yourpassword"

smtp.yourdomain.com {
    # Bảo vệ toàn bộ UI (không bảo vệ /api/* vì đã có API_SECRET)
    @ui {
        not path /api/*
        not path /health
    }

    basicauth @ui {
        # Thêm users: <username> <bcrypt-hash>
        admin $2a$14$...your-bcrypt-hash-here...
    }

    reverse_proxy localhost:3000

    # Logging
    log {
        output file /var/log/caddy/smtp-proxy.log
    }
}
```

**Hướng dẫn generate password hash:**
```bash
# Cài caddy: https://caddyserver.com/docs/install
caddy hash-password --plaintext "your-strong-password"
# Paste output vào Caddyfile ở chỗ $2a$14$...
```

---

## 11. Docker

### `Dockerfile`

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 2525 3000
CMD ["node", "server.js"]
```

### `docker-compose.yml`

```yaml
version: '3.8'
services:
  smtp-proxy:
    build: .
    restart: unless-stopped
    ports:
      - "2525:2525"   # SMTP ext port cho Gitea
      - "3000:3000"   # API & UI (Caddy sẽ reverse proxy)
    env_file: .env
    volumes:
      - ./stats.json:/app/stats.json  # Fallback stats local
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - smtp-proxy

volumes:
  caddy_data:
  caddy_config:
```

---

## 12. `.http` Test File

Tạo `tests/api.http` với nội dung đầy đủ, đọc biến từ `.env` qua `@` syntax (tương thích VS Code REST Client extension và httpyac):

```http
### api.http — SMTP Proxy API Tests
### Yêu cầu: VS Code REST Client extension hoặc httpyac
### Copy .env.example -> .env và điền giá trị trước khi chạy

@baseUrl = http://localhost:3000
@apiSecret = {{$dotenv API_SECRET}}
@testEmail = test@example.com

### ─────────────────────────────────────────────────
### HEALTH
### ─────────────────────────────────────────────────

# @name health
GET {{baseUrl}}/api/health
Content-Type: application/json

###

### ─────────────────────────────────────────────────
### ACCOUNTS
### ─────────────────────────────────────────────────

# @name listAccounts
GET {{baseUrl}}/api/accounts
X-API-Secret: {{apiSecret}}

###

# @name createAccount
POST {{baseUrl}}/api/accounts
X-API-Secret: {{apiSecret}}
Content-Type: application/json

{
  "provider": "gmail",
  "auth": {
    "user": "example@gmail.com",
    "pass": "xxxx xxxx xxxx xxxx"
  },
  "dailyLimit": 400,
  "hourlyLimit": 100,
  "fromName": "My App",
  "fromAddress": "noreply@mydomain.com",
  "enabled": true
}

###

# @name updateAccount
PUT {{baseUrl}}/api/accounts/example
X-API-Secret: {{apiSecret}}
Content-Type: application/json

{
  "dailyLimit": 500,
  "enabled": false
}

###

# @name testAccount
POST {{baseUrl}}/api/accounts/example/test
X-API-Secret: {{apiSecret}}
Content-Type: application/json

{
  "to": "{{testEmail}}"
}

###

# @name deleteAccount
DELETE {{baseUrl}}/api/accounts/example
X-API-Secret: {{apiSecret}}

###

### ─────────────────────────────────────────────────
### RULES
### ─────────────────────────────────────────────────

# @name listRules
GET {{baseUrl}}/api/rules
X-API-Secret: {{apiSecret}}

###

# @name createRule
POST {{baseUrl}}/api/rules
X-API-Secret: {{apiSecret}}
Content-Type: application/json

{
  "name": "Critical Emails",
  "order": 1,
  "match": {
    "subject": "\\[CRITICAL\\]|\\[URGENT\\]",
    "from": "",
    "to": ""
  },
  "accounts": [],
  "enabled": true
}

###

# @name updateRule
PUT {{baseUrl}}/api/rules/critical-emails
X-API-Secret: {{apiSecret}}
Content-Type: application/json

{
  "enabled": false
}

###

# @name deleteRule
DELETE {{baseUrl}}/api/rules/critical-emails
X-API-Secret: {{apiSecret}}

###

### ─────────────────────────────────────────────────
### STATS
### ─────────────────────────────────────────────────

# @name getStats
GET {{baseUrl}}/api/stats
X-API-Secret: {{apiSecret}}

###

# @name resetAllStats
POST {{baseUrl}}/api/stats/reset
X-API-Secret: {{apiSecret}}
Content-Type: application/json

{}

###

# @name resetOneAccountStats
POST {{baseUrl}}/api/stats/reset
X-API-Secret: {{apiSecret}}
Content-Type: application/json

{
  "accountId": "example"
}

###

### ─────────────────────────────────────────────────
### BACKUP / IMPORT / EXPORT
### ─────────────────────────────────────────────────

# @name backup
GET {{baseUrl}}/api/backup
X-API-Secret: {{apiSecret}}

###

# @name exportJson
GET {{baseUrl}}/api/export?format=json
X-API-Secret: {{apiSecret}}

###

# @name exportCsv
GET {{baseUrl}}/api/export?format=csv
X-API-Secret: {{apiSecret}}

###
# Import: dùng curl vì REST Client không handle multipart tốt
# curl -X POST http://localhost:3000/api/import \
#   -H "X-API-Secret: $API_SECRET" \
#   -F "file=@accounts.json"
#
# curl -X POST http://localhost:3000/api/import?overwrite=true \
#   -H "X-API-Secret: $API_SECRET" \
#   -F "file=@accounts.csv"
###

### ─────────────────────────────────────────────────
### SETTINGS
### ─────────────────────────────────────────────────

# @name getSettings
GET {{baseUrl}}/api/settings
X-API-Secret: {{apiSecret}}

###

# @name updateSettings
PUT {{baseUrl}}/api/settings
X-API-Secret: {{apiSecret}}
Content-Type: application/json

{
  "retryMaxAttempts": 3,
  "retryDelayMs": 5000,
  "retryExponentialBackoff": true,
  "defaultDailyLimit": 400,
  "defaultHourlyLimit": 100
}

###

### ─────────────────────────────────────────────────
### ERROR CASES (kiểm tra xử lý lỗi)
### ─────────────────────────────────────────────────

# @name unauthorizedRequest (expect 401)
GET {{baseUrl}}/api/accounts
X-API-Secret: wrong-secret

###

# @name createAccountMissingFields (expect 400)
POST {{baseUrl}}/api/accounts
X-API-Secret: {{apiSecret}}
Content-Type: application/json

{
  "provider": "gmail"
}

###
```

---

## 13. Import/Export Format Specification

### JSON format (full):
```json
{
  "version": "2.0",
  "exportedAt": "2026-05-19T00:00:00.000Z",
  "accounts": [
    {
      "provider": "gmail",
      "host": "smtp.gmail.com",
      "port": 465,
      "secure": true,
      "auth": { "user": "example@gmail.com", "pass": "****" },
      "dailyLimit": 400,
      "hourlyLimit": 100,
      "fromName": "My App",
      "fromAddress": "noreply@example.com",
      "enabled": true
    }
  ],
  "rules": [
    {
      "name": "Default",
      "order": 999,
      "match": {},
      "accounts": ["example"],
      "enabled": true
    }
  ]
}
```

Password trong export JSON luôn là `"****"` (masked). Khi import, nếu pass là `"****"` thì skip update password.

### CSV format (accounts only):
```csv
provider,user,pass,dailyLimit,hourlyLimit,fromName,fromAddress,host,port,secure,enabled
gmail,example@gmail.com,xxxx xxxx xxxx xxxx,400,100,My App,noreply@example.com,,,, true
custom,user@example.com,password123,200,50,Custom,noreply@example.com,mail.example.com,587,false,true
```

Khi import CSV, nếu `provider` không phải `custom` thì `host`/`port`/`secure` lấy từ preset, bỏ qua giá trị trong CSV.

---

## 14. Xử lý SMTP Shim — Đảm bảo tương thích toàn hệ thống

Giữ nguyên logic shim hiện tại. Bổ sung thêm:

1. **Fix thêm case `AUTH LOGIN` thiếu `<>`**: Một số client gửi `AUTH LOGIN user@domain` không theo chuẩn — shim log warning nhưng không break.

2. **Timeout handling**: Client connection timeout sau 60s nếu không có activity.

3. **Logging**: Log mỗi connection với `[SHIM] Client {ip} connected` và `[SHIM] Client {ip} disconnected after {ms}ms`.

4. **Gitea-specific**: Giữ nguyên behavior `MAIL FROM:addr` → `MAIL FROM:<addr>` fix. Test phải pass với `telnet localhost 2525` manual test.

5. **Universal compatibility**: Shim phải hoạt động với:
   - Gitea (chính)
   - GitLab (tương tự Gitea)
   - Forgejo (fork Gitea)
   - Các mailer client chuẩn khác

---

## 15. Thứ tự triển khai (Agent phải theo đúng thứ tự này)

```
PHASE 1 — Foundation
├── [ ] Tạo .gitignore
├── [ ] Tạo .env.example (đầy đủ comments hướng dẫn)
├── [ ] Cập nhật package.json (thêm: express, firebase-admin, dotenv, cors, multer, uuid)
├── [ ] Tạo db/firebase.js
└── [ ] Update config.js (đọc từ env, fallback defaults)

PHASE 2 — Core Logic
├── [ ] Refactor rotator.js (giữ nguyên + Firebase load + From override + sendWithAccount)
└── [ ] Refactor server.js (giữ nguyên + override account + mount Express)

PHASE 3 — API
├── [ ] api/index.js (Express app + auth middleware + CORS + static UI)
├── [ ] api/routes/accounts.js
├── [ ] api/routes/rules.js
├── [ ] api/routes/stats.js
├── [ ] api/routes/test.js
├── [ ] api/routes/backup.js
└── [ ] api/routes/import-export.js

PHASE 4 — UI
├── [ ] ui/style.css (CSS variables + base styles theo DESIGN.md)
├── [ ] ui/index.html (layout + navigation skeleton)
└── [ ] ui/app.js (full SPA logic)

PHASE 5 — DevOps & Docs
├── [ ] Dockerfile
├── [ ] docker-compose.yml
├── [ ] Caddyfile.example
├── [ ] tests/api.http
├── [ ] CHANGE_LOGS.md (technical)
└── [ ] CHANGE_LOGS_USER.md (user-facing)
```

---

## 16. Ràng buộc kỹ thuật bắt buộc

1. **Không dùng `config.js` hardcode** — accounts và rules phải được load từ Firebase khi runtime. `config.js` chỉ dùng làm fallback khi Firebase chưa config.

2. **Password never logged** — Không bao giờ log `auth.pass` ra console hay file. Luôn mask khi return từ API.

3. **Graceful shutdown** — Khi nhận SIGTERM/SIGINT, đợi email đang gửi hoàn thành (max 10s) trước khi tắt.

4. **Stats sync** — Stats được save vào Firebase sau mỗi email gửi thành công hoặc thất bại. Nếu Firebase unavailable, fallback về `stats.json` local.

5. **Rule order** — Rules trong Firebase phải sort theo field `order` (ascending). Rule có `order` cao nhất (999) là Default fallback.

6. **Regex serialization** — Rules `match.subject/from/to` lưu dưới dạng string trong Firebase, compile thành `RegExp` khi load vào memory.

7. **Account ID** — Mặc định là phần trước `@` của email. Nếu trùng, append `-2`, `-3`,... Không dùng UUID cho account ID (để human-readable).

8. **Rule ID** — Slugify `name` (lowercase, spaces → hyphens). Ví dụ: "Critical Emails" → `critical-emails`.

9. **API returns consistent shape:**
   ```json
   { "success": true, "data": {...} }
   { "success": false, "error": "message" }
   ```

10. **UI không dùng external CDN** — Tất cả assets phải local (không load từ cdnjs, googleapis, etc.) để hoạt động trong mạng nội bộ.

---

## 17. Kiểm thử tối thiểu agent phải tự verify

Sau khi viết xong code, agent phải tự check các điểm sau và sửa nếu sai:

- [ ] `node server.js` khởi động không lỗi (với .env đã set)
- [ ] `GET /api/health` trả 200
- [ ] `GET /api/accounts` không có `X-API-Secret` trả 401
- [ ] `POST /api/accounts` với body hợp lệ tạo account và persist vào Firebase
- [ ] `POST /api/accounts/:id/test` gửi email thật
- [ ] `GET /api/backup` trả JSON với accounts (pass masked)
- [ ] `GET /api/export?format=csv` trả CSV hợp lệ
- [ ] `POST /api/import` với file CSV import đúng
- [ ] UI load tại `http://localhost:3000` không lỗi JS console
- [ ] UI nhập API Secret sai → báo lỗi; đúng → hiện accounts list
- [ ] TCP shim: `echo -e "EHLO test\r\nMAIL FROM:test@example.com\r\nQUIT\r\n" | nc localhost 2525` → fix `MAIL FROM:<test@example.com>` và không lỗi

---

## 18. Lưu ý cuối

- Commit message format: `feat: <mô tả ngắn>` / `fix: <mô tả>` / `refactor: <mô tả>`
- Mỗi file sau khi viết xong phải được verify bằng cách đọc lại nội dung
- Nếu có bất kỳ import nào fail khi `node -e "require('./file')"` thì phải sửa ngay
- Không để `TODO` hay placeholder code trong code cuối cùng
- Tất cả `console.log` phải có prefix: `[SMTP]`, `[API]`, `[DB]`, `[ROTATOR]`, `[SHIM]`
- File `.env` không được commit (kiểm tra `.gitignore`)
