import { neon } from '@neondatabase/serverless';

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const batchId = url.searchParams.get('batch_id');
    const region = url.searchParams.get('region') || 'ALL';

    const sql = neon(context.env.DATABASE_URL);

    // 1. Summary grouped by Region Command
    const regionSummary = await sql`
      SELECT 
        m.region_code,
        m.region_command,
        COUNT(m.unit_id)::int AS unit_count,
        COALESCE(SUM(b.recruit_quota), 0)::int AS total_recruits
      FROM master_units m
      LEFT JOIN batch_active_units b 
        ON m.unit_id = b.unit_id AND b.batch_id = ${batchId}
      WHERE m.is_active = TRUE
      GROUP BY m.region_code, m.region_command
      ORDER BY m.region_code ASC
    `;

    // 2. Unit list (filtered by region if specified)
    let units;
    if (region && region !== 'ALL') {
      units = await sql`
        SELECT 
          m.unit_id, m.unit_code, m.seq_in_region, m.unit_name, 
          m.division_name, m.region_command, m.location, m.attached_units,
          COALESCE(b.recruit_quota, 0)::int AS recruit_quota,
          COALESCE(b.status, 'INACTIVE') AS batch_status
        FROM master_units m
        LEFT JOIN batch_active_units b 
          ON m.unit_id = b.unit_id AND b.batch_id = ${batchId}
        WHERE m.is_active = TRUE AND m.region_command = ${region}
        ORDER BY m.unit_code ASC
      `;
    } else {
      units = await sql`
        SELECT 
          m.unit_id, m.unit_code, m.seq_in_region, m.unit_name, 
          m.division_name, m.region_command, m.location, m.attached_units,
          COALESCE(b.recruit_quota, 0)::int AS recruit_quota,
          COALESCE(b.status, 'INACTIVE') AS batch_status
        FROM master_units m
        LEFT JOIN batch_active_units b 
          ON m.unit_id = b.unit_id AND b.batch_id = ${batchId}
        WHERE m.is_active = TRUE
        ORDER BY m.unit_code ASC
      `;
    }

    return new Response(JSON.stringify({
      success: true,
      summary: regionSummary,
      units
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
