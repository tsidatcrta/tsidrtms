import { neon } from '@neondatabase/serverless';

export async function onRequestGet(context) {
  try {
    const sql = neon(context.env.DATABASE_URL);
    const batches = await sql`
      SELECT batch_id, fiscal_year, batch_number, batch_label, is_current
      FROM fiscal_batches
      ORDER BY fiscal_year DESC, batch_number DESC
    `;
    return new Response(JSON.stringify({ success: true, data: batches }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
