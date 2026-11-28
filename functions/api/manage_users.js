import { neon } from '@neondatabase/serverless';

export async function onRequest(context) {
  const { request, env } = context;
  const sql = neon(env.DATABASE_URL);
  const url = new URL(request.url);
  const method = request.method;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  try {
    // 1. GET: ดึงรายชื่อผู้ใช้งานทั้งหมด (ไม่เรียกหาคอลัมน์ id)
    if (method === 'GET') {
      const mode = url.searchParams.get('mode');
      if (mode === 'units') {
        return new Response(JSON.stringify({ success: true, units: [] }), { headers });
      }

      const users = await sql`SELECT * FROM users`;
      const normalized = users.map(u => ({
        ...u,
        id: u.id || u.user_id || u.phone
      }));

      const roleOrder = { admin: 1, command: 2, unit: 3 };
      normalized.sort((a, b) => (roleOrder[a.role] || 9) - (roleOrder[b.role] || 9));

      return new Response(JSON.stringify({ success: true, users: normalized }), { headers });
    }

    // 2. POST: เพิ่มผู้ใช้งานใหม่ หรือ นำเข้าชุดใหญ่
    if (method === 'POST') {
      const body = await request.json();

      if (body.action === 'bulk_import' && Array.isArray(body.records)) {
        let importedCount = 0;
        let updatedCount = 0;

        for (const item of body.records) {
          const cleanPhone = String(item.phone || '').replace(/[^0-9]/g, '');
          if (cleanPhone.length < 9) continue;

          const pin = String(item.pin || '123456').trim() || '123456';
          const role = ['admin', 'command', 'unit'].includes(item.role) ? item.role : 'unit';

          let cleanRegion = String(item.army_region || '').trim();
          if (cleanRegion.includes(':')) {
            cleanRegion = cleanRegion.split(':').pop().trim();
          }

          const rawUnit = String(item.raw_unit || item.unit_name || '').trim();
          const rankVal = item.rank || '';
          const nameVal = item.name_surname || '';

          const existing = await sql`SELECT phone FROM users WHERE phone = ${cleanPhone} LIMIT 1`;
          if (existing.length > 0) {
            try {
              await sql`
                UPDATE users 
                SET rank = ${rankVal}, name_surname = ${nameVal}, role = ${role}, army_region = ${cleanRegion}, unit_name = ${rawUnit}, is_active = true
                WHERE phone = ${cleanPhone}
              `;
            } catch (_) {
              await sql`
                UPDATE users 
                SET rank = ${rankVal}, name_surname = ${nameVal}, role = ${role}, army_region = ${cleanRegion}
                WHERE phone = ${cleanPhone}
              `;
            }
            updatedCount++;
          } else {
            try {
              await sql`
                INSERT INTO users (phone, pin, rank, name_surname, role, army_region, unit_name, is_active)
                VALUES (${cleanPhone}, ${pin}, ${rankVal}, ${nameVal}, ${role}, ${cleanRegion}, ${rawUnit}, true)
              `;
            } catch (_) {
              await sql`
                INSERT INTO users (phone, pin, rank, name_surname, role, army_region)
                VALUES (${cleanPhone}, ${pin}, ${rankVal}, ${nameVal}, ${role}, ${cleanRegion})
              `;
            }
            importedCount++;
          }
        }

        return new Response(
          JSON.stringify({ success: true, importedCount, updatedCount }),
          { headers }
        );
      }

      // เพิ่มทีละ 1 รายการ
      const cleanPhone = String(body.phone || '').replace(/[^0-9]/g, '');
      if (!cleanPhone || !body.name_surname) {
        return new Response(
          JSON.stringify({ success: false, error: 'กรุณากรอกเบอร์โทรศัพท์และชื่อ-สกุลให้ครบถ้วน' }),
          { status: 400, headers }
        );
      }

      const dup = await sql`SELECT phone FROM users WHERE phone = ${cleanPhone} LIMIT 1`;
      if (dup.length > 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'เบอร์โทรศัพท์นี้มีอยู่ในระบบแล้ว' }),
          { status: 400, headers }
        );
      }

      const pin = String(body.pin || '123456').trim() || '123456';
      try {
        await sql`
          INSERT INTO users (phone, pin, rank, name_surname, role, army_region, is_active)
          VALUES (${cleanPhone}, ${pin}, ${body.rank || ''}, ${body.name_surname}, ${body.role || 'unit'}, ${body.army_region || ''}, true)
        `;
      } catch (_) {
        await sql`
          INSERT INTO users (phone, pin, rank, name_surname, role, army_region)
          VALUES (${cleanPhone}, ${pin}, ${body.rank || ''}, ${body.name_surname}, ${body.role || 'unit'}, ${body.army_region || ''})
        `;
      }

      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // 3. PUT: แก้ไขข้อมูล / รีเซ็ต PIN / เปิด-ปิดสถานะ
    if (method === 'PUT') {
      const body = await request.json();
      const targetPhone = String(body.phone || body.id || '').replace(/[^0-9]/g, '');
      if (!targetPhone) {
        return new Response(JSON.stringify({ success: false, error: 'ไม่พบเบอร์โทรศัพท์อ้างอิง' }), { status: 400, headers });
      }

      if (body.action === 'reset_pin') {
        await sql`UPDATE users SET pin = ${String(body.pin || '123456').trim()} WHERE phone = ${targetPhone}`;
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      if (body.action === 'toggle_status') {
        await sql`UPDATE users SET is_active = ${Boolean(body.is_active)} WHERE phone = ${targetPhone}`;
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      if (body.pin && String(body.pin).trim() !== '') {
        await sql`
          UPDATE users
          SET pin = ${String(body.pin).trim()}, rank = ${body.rank || ''}, name_surname = ${body.name_surname || ''}, role = ${body.role || 'unit'}, army_region = ${body.army_region || ''}
          WHERE phone = ${targetPhone}
        `;
      } else {
        await sql`
          UPDATE users
          SET rank = ${body.rank || ''}, name_surname = ${body.name_surname || ''}, role = ${body.role || 'unit'}, army_region = ${body.army_region || ''}
          WHERE phone = ${targetPhone}
        `;
      }

      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // 4. DELETE: ลบผู้ใช้งาน
    if (method === 'DELETE') {
      const idOrPhone = String(url.searchParams.get('id') || '').replace(/[^0-9]/g, '');
      if (!idOrPhone) return new Response(JSON.stringify({ success: false, error: 'ไม่พบข้อมูลที่ต้องการลบ' }), { status: 400, headers });
      if (idOrPhone === '0800000000') {
        return new Response(JSON.stringify({ success: false, error: 'ไม่สามารถลบบัญชีแอดมินหลักได้' }), { status: 403, headers });
      }

      await sql`DELETE FROM users WHERE phone = ${idOrPhone}`;
      return new Response(JSON.stringify({ success: true }), { headers });
    }

    return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), { status: 405, headers });
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers }
    );
  }
}
