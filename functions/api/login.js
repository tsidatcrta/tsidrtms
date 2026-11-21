import { neon } from '@neondatabase/serverless';

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { phone_number, pin, batch_id } = body;

    if (!phone_number || !pin) {
      return new Response(JSON.stringify({ success: false, error: 'กรุณากรอกเบอร์โทรศัพท์และรหัส PIN' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const sql = neon(context.env.DATABASE_URL);
    const users = await sql`
      SELECT 
        u.user_id, u.phone_number, u.rank, u.first_name, u.last_name, 
        u.position, u.role, u.scope_region, u.photo_url, u.unit_id,
        m.unit_code, m.unit_name, m.region_command
      FROM users u
      LEFT JOIN master_units m ON u.unit_id = m.unit_id
      WHERE u.phone_number = ${phone_number.trim()} 
        AND u.pin_hash = ${pin.trim()} 
        AND u.is_active = TRUE
      LIMIT 1
    `;

    if (users.length === 0) {
      return new Response(JSON.stringify({ success: false, error: 'เบอร์โทรศัพท์หรือรหัส PIN ไม่ถูกต้อง' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const user = users[0];

    // Update last_login
    await sql`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE user_id = ${user.user_id}`;

    // Fetch selected batch info
    const batches = await sql`
      SELECT batch_id, batch_label, fiscal_year, batch_number 
      FROM fiscal_batches 
      WHERE batch_id = ${batch_id}
      LIMIT 1
    `;

    return new Response(JSON.stringify({
      success: true,
      user,
      batch: batches[0] || null
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
