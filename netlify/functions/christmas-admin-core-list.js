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
  if (!user) return reply(401, { error: "Authentication required." });

  const roles = user.app_metadata?.roles;
  if (
    user.email?.toLowerCase() !== "admin@grimson.no" ||
    !Array.isArray(roles) ||
    !roles.includes("admin")
  ) {
    return reply(403, { error: "Administrator access required." });
  }

  const rawPage = event.queryStringParameters?.page ?? "0";
  if (!/^(0|[1-9]\\d{0,5})$/.test(rawPage)) {
    return reply(400, { error: "Invalid page." });
  }
  const page = Number(rawPage);
  const pageSize = 200;

  try {
    const db = getDatabase({
      connectionString: process.env.GRIMSON_DATABASE_URL
    });
    const result = await db.pool.query(
      `SELECT id, full_name, email, email_verified_at, created_at
       FROM christmas_core_entries
       ORDER BY created_at DESC, id DESC
       LIMIT $1 OFFSET $2`,
      [pageSize + 1, page * pageSize]
    );
    const hasMore = result.rows.length > pageSize;
    return reply(200, {
      entries: result.rows.slice(0, pageSize),
      hasMore
    });
  } catch (error) {
    console.error("CORE admin list error:", error);
    return reply(500, { error: "Unable to load CORE participants." });
  }
};
