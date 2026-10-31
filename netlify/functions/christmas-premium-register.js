
const crypto = require("node:crypto");
const nodemailer = require("nodemailer");
const { getDatabase } = require("@netlify/database");
const { getStore, connectLambda } = require("@netlify/blobs");

const MAX = 4 * 1024 * 1024;
const DEADLINE = Date.parse("2027-01-07T22:59:59Z");

function reply(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(data)
  };
}

const hash = value =>
  crypto.createHash("sha256").update(value).digest("hex");

exports.handler = async event => {
connectLambda(event);
  if (event.httpMethod !== "POST")
    return reply(405, { error: "Method not allowed." });

  if (Date.now() > DEADLINE)
    return reply(403, { error: "Photo contest is closed." });

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch {
    return reply(400, { error: "Invalid request." });
  }

  const name = typeof data.name === "string"
    ? data.name.trim() : "";
  const email = typeof data.email === "string"
    ? data.email.trim().toLowerCase() : "";
  const filename = typeof data.filename === "string"
    ? data.filename : "";
  const mime = data.mime;

  if (!name || name.length > 150 ||
      /[\x00-\x1f]/.test(name) ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return reply(400, { error: "Invalid name or email." });

  if (data.ageConfirmed !== true ||
      data.termsAccepted !== true ||
      data.licenseAccepted !== true)
    return reply(400, { error: "Required agreements are missing." });

  if (!["image/jpeg", "image/png"].includes(mime) ||
      !/\.(jpe?g|png)$/i.test(filename) ||
      filename.length > 255)
    return reply(400, { error: "JPG or PNG required." });

  if (typeof data.photoBase64 !== "string" ||
      data.photoBase64.length > Math.ceil(MAX / 3) * 4 + 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data.photoBase64))
    return reply(400, { error: "Invalid photograph." });

  const bytes = Buffer.from(data.photoBase64, "base64");

  if (!bytes.length || bytes.length > MAX ||
      bytes.toString("base64") !== data.photoBase64)
    return reply(400, { error: "Invalid photograph or file exceeds 4 MB." });

  const jpeg = bytes.length >= 4 &&
    bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;

  const png = bytes.subarray(0, 8).equals(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  );

  if ((mime === "image/jpeg" && !jpeg) ||
      (mime === "image/png" && !png))
    return reply(400, { error: "Image format mismatch." });

  if (typeof data.turnstileToken !== "string" ||
      !data.turnstileToken)
    return reply(400, { error: "Human verification required." });

  if (!process.env.TURNSTILE_SECRET ||
      !process.env.PROTON_SMTP_USER ||
      !process.env.PROTON_SMTP_TOKEN)
    return reply(503, { error: "Contest configuration unavailable." });

  let db, key, inserted = false;

  try {
    const verification = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          secret: process.env.TURNSTILE_SECRET,
          response: data.turnstileToken,
          remoteip: event.headers?.["x-nf-client-connection-ip"] || ""
        }),
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!verification.ok)
      throw new Error("Turnstile service unavailable.");

    const result = await verification.json();

    const localTest =
  process.env.CONTEXT === "dev" &&
  result.hostname === "localhost";

if (!result.success || (result.hostname !== "grimson.no" && !localTest))
  return reply(403, { error: "Human verification failed." });

    db = getDatabase({
  connectionString: process.env.GRIMSON_DATABASE_URL
});

    const existing = await db.pool.query(
      "SELECT 1 FROM christmas_premium_entries WHERE email=$1 LIMIT 1",
      [email]
    );

    if (existing.rowCount)
      return reply(200, {
        success: true,
        message: "If eligible, a confirmation email will be sent."
      });

    const token = crypto.randomBytes(32).toString("hex");
    key = crypto.randomUUID() + (mime === "image/png" ? ".png" : ".jpg");

    const store = getStore("christmas-premium-private");

    await store.set(key, bytes, {
      metadata: { contentType: mime }
    });

    const saved = await db.pool.query(
      `INSERT INTO christmas_premium_entries
       (full_name, email, verification_token_hash,
        verification_expires_at, newsletter_consent,
        photo_storage_key, photo_original_filename,
        photo_mime_type, photo_size_bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (email) DO NOTHING RETURNING id`,
      [
        name, email, hash(token),
        new Date(Date.now() + 86400000),
        data.newsletterConsent === true,
        key, filename, mime, bytes.length
      ]
    );

    if (!saved.rowCount) {
      await store.delete(key);
      return reply(200, {
        success: true,
        message: "If eligible, a confirmation email will be sent."
      });
    }

    inserted = true;

    const confirmationBase =
  process.env.CONTEXT === "dev"
    ? "http://localhost:8888"
    : "https://grimson.no";

const url =
  confirmationBase +
  "/.netlify/functions/christmas-premium-confirm?token=" +
  encodeURIComponent(token);

    const mailer = nodemailer.createTransport({
      host: "smtp.protonmail.ch",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: process.env.PROTON_SMTP_USER,
        pass: process.env.PROTON_SMTP_TOKEN
      },
      tls: { minVersion: "TLSv1.2" }
    });

    await mailer.sendMail({
      from: process.env.PROTON_SMTP_USER,
      to: email,
      subject: "GRIMSON PREMIUM Photo Contest — Confirm your entry",
      text: `Hello ${name},

Confirm your PREMIUM photo contest entry within 24 hours:
${url}

If you did not submit a photo, ignore this email.

GRIMSON`
    });

    return reply(200, {
      success: true,
      message: "If eligible, a confirmation email will be sent."
    });

  } catch (error) {
    console.error("PREMIUM registration error", error);

    if (inserted && db && key) {
      try {
        await db.pool.query(
          `DELETE FROM christmas_premium_entries
           WHERE photo_storage_key=$1
           AND email_verified_at IS NULL`,
          [key]
        );
      } catch (e) {
        console.error("Database rollback failed", e);
      }
    }

    if (key) {
      try {
        await getStore("christmas-premium-private").delete(key);
      } catch (e) {
        console.error("Photo rollback failed", e);
      }
    }

    return reply(503, {
      error: "Photo submission unavailable. Please retry."
    });
  }
};
