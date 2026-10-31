
const crypto = require("node:crypto");
const nodemailer = require("nodemailer");
const { getDatabase } = require("@netlify/database");

const DEADLINE = Date.parse("2026-11-30T23:00:00Z");
const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

function reply(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(data),
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return reply(405, { error: "Method not allowed." });
  }

  if (Date.now() >= DEADLINE) {
    return reply(403, { error: "Registration is closed." });
  }

  let input;

  try {
    input = JSON.parse(event.body || "{}");
  } catch {
    return reply(400, { error: "Invalid request." });
  }

  const name = typeof input?.name === "string"
    ? input.name.trim()
    : "";

  const email = typeof input?.email === "string"
    ? input.email.trim().toLowerCase()
    : "";

  const token = typeof input?.turnstileToken === "string"
    ? input.turnstileToken
    : "";

  if (
    !name ||
    name.length > 150 ||
    /[\r\n\x00-\x1f]/.test(name) ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return reply(400, {
      error: "Please enter a valid name and email.",
    });
  }

  if (input.ageConfirmed !== true ||
      input.termsAccepted !== true) {
    return reply(400, {
      error: "Age confirmation and acceptance of terms are required.",
    });
  }

  if (!token) {
    return reply(400, {
      error: "Human verification is required.",
    });
  }

  if (!process.env.CHRISTMAS_TURNSTILE_SECRET ||
      !process.env.PROTON_SMTP_USER ||
      !process.env.PROTON_SMTP_TOKEN) {
    console.error("Christmas registration configuration missing.");
    return reply(503, {
      error: "Registration temporarily unavailable.",
    });
  }

  try {
    const secret = process.env.CHRISTMAS_TURNSTILE_SECRET || "";

console.log("CORE secret diagnostics:", {
  present: secret.length > 0,
  length: secret.length,
  hasWhitespace: secret !== secret.trim(),
  looksLikeSiteKey: secret.startsWith("0x4")
});
    const verification = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          secret: process.env.TURNSTILE_SECRET,
          response: token,
          remoteip:
            event.headers?.["x-nf-client-connection-ip"] || "",
        }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!verification.ok) {
      throw new Error("Turnstile service unavailable.");
    }

    const result = await verification.json();
    console.log("CORE Turnstile verification:", {
  success: result.success,
  hostname: result.hostname,
  errors: result["error-codes"]
});

    if (!result.success ||
        result.hostname !== "grimson.no") {
      return reply(403, {
        error: "Human verification failed.",
      });
    }

    const confirmationToken =
      crypto.randomBytes(32).toString("hex");

    const confirmationHash = hashToken(confirmationToken);

    const expiresAt = new Date(
      Date.now() + TOKEN_LIFETIME_MS
    );

    const db = getDatabase({
  connectionString: process.env.GRIMSON_DATABASE_URL
});

    const insert = await db.pool.query(
      `INSERT INTO christmas_core_entries
       (full_name, email, verification_token_hash,
        verification_expires_at, newsletter_consent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [
        name,
        email,
        confirmationHash,
        expiresAt,
        input.newsletterConsent === true,
      ]
    );

    const genericMessage = {
      success: true,
      message:
        "If eligible, a confirmation email will be sent.",
    };

    if (insert.rowCount === 0) {
      return reply(200, genericMessage);
    }

    const confirmationUrl =
      "https://grimson.no/.netlify/functions/" +
      "christmas-core-confirm?token=" +
      encodeURIComponent(confirmationToken);

    const transporter = nodemailer.createTransport({
      host: "smtp.protonmail.ch",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: process.env.PROTON_SMTP_USER,
        pass: process.env.PROTON_SMTP_TOKEN,
      },
      tls: {
        minVersion: "TLSv1.2",
      },
    });

    try {
      await transporter.sendMail({
        from: process.env.PROTON_SMTP_USER,
        to: email,
        subject:
          "GRIMSON Christmas Giveaway - Confirm your entry",
        text:
          `Hello ${name},\n\n` +
          "Please confirm your entry for the GRIMSON " +
          "Christmas Giveaway using this link:\n\n" +
          `${confirmationUrl}\n\n` +
          "This link expires in 24 hours.\n\n" +
          "If you did not register, you can ignore this email.\n\n" +
          "GRIMSON\nhttps://grimson.no",
      });
    } catch (mailError) {
      console.error(
        "Christmas confirmation email failed:",
        mailError
      );

      await db.pool.query(
        `DELETE FROM christmas_core_entries
         WHERE id = $1
         AND verification_token_hash = $2
         AND email_verified_at IS NULL`,
        [insert.rows[0].id, confirmationHash]
      );

      return reply(503, {
        error:
          "Unable to send confirmation email. Please try again.",
      });
    }

    return reply(200, genericMessage);
  } catch (error) {
    console.error("Christmas registration failed:", error);

    return reply(500, {
      error: "Registration temporarily unavailable.",
    });
  }
};
