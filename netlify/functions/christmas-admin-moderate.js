const nodemailer = require('nodemailer');
const { getDatabase } = require('@netlify/database');

function reply(statusCode, data) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(data) };
}
const statuses = { approve: 'approved', reject: 'rejected', ban: 'banned' };
const signature = '\n\nGRIMSON — GO TANTO!\nwww.grimson.no';
const appeal = '\n\nIf you disagree with this decision, you can request a review through our official contact page: https://grimson.no/contact.html. Please use the email address associated with your submission.';

function emailFor(row, action, reason) {
  const hello = `Hello ${row.full_name},\n\n`;
  if (action === 'approve') return { subject: 'GRIMSON PREMIUM — Submission Accepted', text: hello + 'Your photograph has been accepted into the GRIMSON PREMIUM photo competition. This confirms eligibility for consideration, not that you have won.' + signature };
  if (action === 'reject') return { subject: 'GRIMSON PREMIUM — Submission Not Accepted', text: hello + 'After reviewing your submission, your photograph has not been accepted into the competition.\n\nPossible reasons include: the GRIMSON CORE knife is not clearly identifiable; the photo does not show a genuine GRIMSON CORE; the submission does not meet the published competition rules; the image contains unlawful or inappropriate content; rights to the photograph are unclear; or submitted information is inaccurate. These are general examples, not a statement that every reason applies to your submission.' + (reason ? '\n\nReason for this decision: ' + reason : '') + appeal + signature };
  if (action === 'ban') return { subject: 'GRIMSON PREMIUM — Competition Disqualification', text: hello + 'Your entry has been disqualified from the GRIMSON PREMIUM photo competition following an administrative review. This restriction applies to this competition only.' + (reason ? '\n\nReason: ' + reason : '') + appeal + signature };
  return { subject: 'GRIMSON PREMIUM — Decision Updated', text: hello + `A previous moderation decision regarding your GRIMSON PREMIUM submission has been reversed. Your current entry status is: ${row.moderation_status.toUpperCase()}.` + (row.moderation_status === 'pending' ? '\n\nYour submission is awaiting review.' : '') + appeal + signature };
}

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed.' });
  const user = context?.clientContext?.user;
  if (user?.email?.toLowerCase() !== 'admin@grimson.no' || !Array.isArray(user?.app_metadata?.roles) || !user.app_metadata.roles.includes('admin')) return reply(403, { error: 'Administrator access required.' });
  if (!event.body || Buffer.byteLength(event.body) > 4096) return reply(400, { error: 'Invalid request size.' });
  let input;
  try { input = JSON.parse(event.body); } catch { return reply(400, { error: 'Invalid JSON.' }); }
  const { id, action, requestId } = input || {};
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (!/^[1-9]\d{0,18}$/.test(String(id)) || !['approve','reject','ban','undo'].includes(action) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(requestId)) || reason.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(reason)) return reply(400, { error: 'Invalid moderation request.' });
  if ((action === 'reject' || action === 'ban') && !reason) return reply(400, { error: 'A reason is required.' });
  if (!process.env.PROTON_SMTP_USER || !process.env.PROTON_SMTP_TOKEN) return reply(503, { error: 'SMTP configuration missing. No decision saved.' });
  const db = getDatabase({ connectionString: process.env.GRIMSON_DATABASE_URL });
  const client = await db.pool.connect();
  let row, eventId;
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id, entry_id, new_status, notification_status FROM christmas_premium_moderation_events WHERE request_id=$1', [requestId]);
    if (existing.rowCount) { await client.query('ROLLBACK'); return reply(200, { success: true, duplicate: true, status: existing.rows[0].new_status, notification: existing.rows[0].notification_status }); }
    const result = await client.query('SELECT id, full_name, email, email_verified_at, moderation_status FROM christmas_premium_entries WHERE id=$1 FOR UPDATE', [id]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return reply(404, { error: 'Submission not found.' }); }
    row = result.rows[0];
    if (!row.email_verified_at) { await client.query('ROLLBACK'); return reply(409, { error: 'Email is not verified.' }); }
    const prior = row.moderation_status;
    let next;
    if (action === 'undo') {
      const last = await client.query('SELECT action,previous_status,new_status FROM christmas_premium_moderation_events WHERE entry_id=$1 ORDER BY id DESC LIMIT 1', [id]);
      if (!last.rowCount || last.rows[0].action === 'undo' || last.rows[0].new_status !== prior) { await client.query('ROLLBACK'); return reply(409, { error: 'No decision available to undo.' }); }
      next = last.rows[0].previous_status;
    } else next = statuses[action];
    if (next === prior) { await client.query('ROLLBACK'); return reply(409, { error: 'Submission already has this status.' }); }
    await client.query('UPDATE christmas_premium_entries SET moderation_status=$1, moderated_at=NOW() WHERE id=$2', [next,id]);
    const inserted = await client.query('INSERT INTO christmas_premium_moderation_events(entry_id,action,previous_status,new_status,reason,admin_email,request_id,notification_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [id,action,prior,next,reason || null,user.email.toLowerCase(),requestId,'sending']);
    eventId = inserted.rows[0].id;
    await client.query('COMMIT');
    row.moderation_status = next;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Moderation database error:',err);
    return reply(500,{error:'Unable to save moderation decision.'});
  } finally { client.release(); }
  try {
    const mail = emailFor(row, action, reason);
    const transporter = nodemailer.createTransport({host:'smtp.protonmail.ch',port:587,secure:false,requireTLS:true,auth:{user:process.env.PROTON_SMTP_USER,pass:process.env.PROTON_SMTP_TOKEN}});
    await transporter.sendMail({from:process.env.PROTON_SMTP_USER,to:row.email,subject:mail.subject,text:mail.text});
    await db.pool.query("UPDATE christmas_premium_moderation_events SET notification_status='sent',notified_at=NOW() WHERE id=$1",[eventId]);
    return reply(200,{success:true,status:row.moderation_status,notification:'sent'});
  } catch(err) {
    console.error('Moderation notification failed:',err);
    try { await db.pool.query("UPDATE christmas_premium_moderation_events SET notification_status='failed',notification_error=$2 WHERE id=$1",[eventId,String(err.message||err).slice(0,500)]); } catch(e) { console.error('Unable to record notification failure',e); }
    return reply(200,{success:true,status:row.moderation_status,notification:'failed',warning:'Decision saved, but email delivery failed. Check function logs before retrying; do not click again.'});
  }
};
