// ============================================
// server.js
const { SMTPServer } = require("smtp-server");
const { simpleParser } = require("mailparser");
const Rotator = require("./rotator");
const config = require("./config");

const rotator = new Rotator(config);

const INTERNAL_PORT = 2626; // cổng nội bộ cho SMTPServer thật
const EXTERNAL_PORT = 2525; // cổng client (Gitea) sẽ kết nối vào

const server = new SMTPServer({
  ...config.smtpServer,
  // KHÔNG dùng port ở đây nữa, ta sẽ gọi .listen(INTERNAL_PORT) phía dưới
  logger: true,
  hideSTARTTLS: true,
  disableReverseLookup: true,

  onAuth(auth, session, callback) {
    console.log("[SMTP] AUTH user =", auth.username || "(none)");
    callback(null, { user: auth.username || "gitea" });
  },
  onData(stream, session, callback) {
    simpleParser(stream, async (err, parsed) => {
      if (err) {
        console.error("Parse error:", err);
        return callback(new Error("Parse failed"));
      }

      try {
        // Lấy địa chỉ From/To
        const headerFromAddr = parsed.from?.value?.[0]?.address || session.envelope?.mailFrom?.address || "";
        const headerFromName = parsed.from?.value?.[0]?.name || "";
        const rcpts = parsed.to?.value?.map((v) => v.address) || session.envelope?.rcptTo?.map((r) => r.address) || [];
        if (!rcpts.length) throw new Error("No recipient found");

        // Giữ nguyên Reply-To từ email gốc (cực quan trọng cho token)
        // mailparser lưu headers trong parsed.headers (Map) và parsed.replyTo
        let replyTo = null;
        const replyToHdr = parsed.headers.get("reply-to");
        if (replyToHdr) {
          // reply-to có thể là string hoặc AddressObject
          if (typeof replyToHdr === "string") {
            replyTo = replyToHdr;
          } else if (replyToHdr?.value?.length) {
            replyTo = replyToHdr.value.map((a) => (a.name ? `"${a.name}" <${a.address}>` : a.address)).join(", ");
          }
        } else if (parsed.replyTo?.value?.length) {
          replyTo = parsed.replyTo.value.map((a) => (a.name ? `"${a.name}" <${a.address}>` : a.address)).join(", ");
        }

        // Bảo toàn thêm một số headers quan trọng để threading hoạt động đúng
        const passHeaders = {};
        ["message-id", "in-reply-to", "references", "list-id"].forEach((h) => {
          const v = parsed.headers.get(h);
          if (v) passHeaders[h] = typeof v === "string" ? v : String(v);
        });

        // Dựng mail để gửi đi (KHÔNG tự đặt replyTo thủ công nếu đã có từ Gitea)
        const email = {
          from: headerFromName ? `"${headerFromName}" <${headerFromAddr}>` : headerFromAddr || "noreply@yourdomain.com",
          to: rcpts.join(", "),
          subject: parsed.subject || "(no subject)",
          text: parsed.text,
          html: parsed.html,
        };
        if (replyTo) email.replyTo = replyTo; // giữ nguyên Reply-To có token
        if (Object.keys(passHeaders).length) email.headers = passHeaders;

        console.log("\n=== INCOMING ===");
        console.log(`  FROM: ${email.from}`);
        console.log(`  TO  : ${email.to}`);
        if (email.replyTo) console.log(`  REPLY-TO: ${email.replyTo}`);
        console.log(`  SUBJ: ${email.subject}`);

        await rotator.send(email);
        callback();
      } catch (error) {
        console.error("Send error:", error);
        callback(new Error(error.message));
      }
    });
  },
});

// NGHE Ở CỔNG NỘI BỘ (KHÔNG trực tiếp cho Gitea kết nối)
server.listen(INTERNAL_PORT, () => {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║  SMTP Rotation Proxy (internal)      ║");
  console.log("╚══════════════════════════════════════╝\n");
  console.log(`✓ SMTPServer listening on ${INTERNAL_PORT}`);
  console.log(`✓ ${config.accounts.length} accounts loaded`);
  console.log(`✓ ${config.rules.length} routing rules\n`);
  rotator.printStats();
});

// =========================
// Shim TCP tại EXTERNAL_PORT (2525)
// Sửa "MAIL FROM:addr" => "MAIL FROM:<addr>"
//     "RCPT TO:addr"   => "RCPT TO:<addr>"
// rồi forward sang SMTPServer nội bộ 2626
// =========================
const net = require("net");

function fixSmtpLine(line) {
  const raw = line.replace(/\r?\n$/, "");

  // MAIL FROM (thiếu <>)
  let m = raw.match(/^MAIL FROM:([^<>\s][^\s\r\n]*)(\s.*)?$/i);
  if (m) {
    const addr = m[1].trim();
    const tail = m[2] ? m[2] : "";
    const fixed = `MAIL FROM:<${addr}>${tail}`;
    console.log("[FIX]", raw, "=>", fixed);
    return fixed + "\r\n";
  }

  // RCPT TO (phòng hờ)
  m = raw.match(/^RCPT TO:([^<>\s][^\s\r\n]*)(\s.*)?$/i);
  if (m) {
    const addr = m[1].trim();
    const tail = m[2] ? m[2] : "";
    const fixed = `RCPT TO:<${addr}>${tail}`;
    console.log("[FIX]", raw, "=>", fixed);
    return fixed + "\r\n";
  }

  return raw + "\r\n";
}

function makeLineSplitter(onLine) {
  let buf = "";
  return (chunk, writer) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx + 1);
      buf = buf.slice(idx + 1);
      const out = onLine(line);
      writer(out);
    }
  };
}

const shim = net.createServer((client) => {
  const upstream = net.connect(INTERNAL_PORT, "127.0.0.1");

  const writeUp = (s) => upstream.write(s);
  const splitClient = makeLineSplitter(fixSmtpLine);

  client.on("data", (data) => splitClient(data, writeUp));
  upstream.on("data", (data) => client.write(data));

  const closeBoth = () => {
    try {
      client.destroy();
    } catch {}
    try {
      upstream.destroy();
    } catch {}
  };
  client.on("error", closeBoth);
  upstream.on("error", closeBoth);
  client.on("close", closeBoth);
  upstream.on("close", closeBoth);
});

shim.listen(EXTERNAL_PORT, () => {
  console.log(`Shim listening on ${EXTERNAL_PORT} -> 127.0.0.1:${INTERNAL_PORT}`);
  console.log("Point Gitea SMTP_ADDR to 127.0.0.1 and SMTP_PORT to", EXTERNAL_PORT);
});
