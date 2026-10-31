
const { getDatabase } = require("@netlify/database");

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

exports.handler = async (event, context) => {
  if (event.httpMethod !== "GET") {
    return reply(405, { error: "Method not allowed." });
  }

  const user = context.clientContext?.user;

  if (!user) {
    return reply(401, { error: "Authentication required." });
  }

  const roles = user.app_metadata?.roles;

  if (
    user.email?.toLowerCase() !== "admin@grimson.no" ||
    !Array.isArray(roles) ||
    !roles.includes("admin")
  ) {
    return reply(403, { error: "Administrator access required." });
  }

  try {
    const db = getDatabase();

    const result = await db.sql`
      SELECT
        id,
        full_name,
        email,
        display_name,
        email_verified_at,
        moderation_status,
        photo_original_filename,
        photo_mime_type,
        photo_size_bytes,
        created_at
      FROM christmas_premium_entries
      ORDER BY created_at DESC
      LIMIT 100
    `;

    return reply(200, {
      entries: result.rows
    });
  } catch (error) {
    console.error("Admin list error:", error);
    return reply(500, {
      error: "Unable to load submissions."
    });
  }
};
