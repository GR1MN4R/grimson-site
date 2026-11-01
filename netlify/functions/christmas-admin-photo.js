const { getDatabase } = require("@netlify/database");
const { getStore, connectLambda } = require("@netlify/blobs");

function reply(statusCode, message) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify({ error: message })
  };
}

exports.handler = async (event, context) => {
  if (event.httpMethod !== "GET") return reply(405, "Method not allowed.");

  const user = context?.clientContext?.user;
  if (!user) return reply(401, "Authentication required.");

  const roles = user.app_metadata?.roles;
  if (
    user.email?.toLowerCase() !== "admin@grimson.no" ||
    !Array.isArray(roles) ||
    !roles.includes("admin")
  ) return reply(403, "Administrator access required.");

  const id = event.queryStringParameters?.id;
  const numericId = typeof id === "string" && /^[1-9]\d*$/.test(id) && id.length <= 19;
  const uuidId = typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  if (!numericId && !uuidId) return reply(400, "Invalid submission ID.");

  try {
    connectLambda(event);
    const db = getDatabase({ connectionString: process.env.GRIMSON_DATABASE_URL });
    const result = await db.pool.query(
      `SELECT photo_storage_key, photo_mime_type
       FROM christmas_premium_entries
       WHERE id = $1
       LIMIT 1`,
      [id]
    );

    if (!result.rowCount) return reply(404, "Submission not found.");

    const { photo_storage_key, photo_mime_type } = result.rows[0];
    if (!["image/jpeg", "image/png"].includes(photo_mime_type)) {
      return reply(415, "Unsupported image format.");
    }

    const store = getStore("christmas-premium-private");
    const photo = await store.get(photo_storage_key, { type: "arrayBuffer" });
    if (!photo) return reply(404, "Photo not found.");

    return {
      statusCode: 200,
      isBase64Encoded: true,
      headers: {
        "Content-Type": photo_mime_type,
        "Content-Disposition": "inline",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox"
      },
      body: Buffer.from(photo).toString("base64")
    };
  } catch (error) {
    console.error("Admin photo error:", error);
    return reply(500, "Unable to load photo.");
  }
};
