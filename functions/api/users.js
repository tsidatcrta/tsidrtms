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
    // 1. GET: ดึงรายชื่อผู้ใช้งานทั้งหมด (และลองดึงตาราง units หากมีอยู่จริง)
    if (method === 'GET') {
      const mode = url.searchParams.get('mode');

      if (mode === 'units') {
        try {
          const units = await sql`SELECT * FROM units ORDER BY id ASC`;
          return new Response(JSON.stringify({ success: true, units }), { headers });
        } catch (_) {
          return new Response(JSON.stringify({ success: true, units: [] }), { headers });
        }
      }

      let users = [];
      try {
        users = await sql`
          SELECT 
            u.*,
            un.unit_name,
            un.unit_code
          FROM users u
          LEFT JOIN units un ON u.unit_id = un.id
          ORDER BY 
            CASE u.role 
              WHEN 'admin' THEN 1 
              WHEN 'command' THEN 2 
              ELSE 3 
            END,
            u.id ASC
        `;
      } catch (_) {
        // กรณีไม่มีตาราง units ในฐานข้อมูล ให้ดึงเฉพาะตาราง users
        users = await sql`
          SELECT * FROM users
          ORDER BY 
            CASE role 
              WHEN 'admin' THEN 1 
              WHEN 'command' THEN 2 
              ELSE 3 
            END,
            id ASC
        `;
      }

      return new Response(JSON.stringify({ success: true, users }), { headers });
    }

    // 2. POST: เพิ่มผู้ใช้งานใหม่ หรือ นำเข้าชุดใหญ่
    if (method === 'POST') {
      const body = await request.json();

      if (body.action === 'bulk_import' && Array.isArray(body.records)) {
        let allUnits = [];
        try {
          allUnits = await sql`SELECT id, unit_code, unit_name, army_region FROM units`;
        } catch (_) {
          allUnits = [];
        }

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
          let unitId = item.unit_id ? Number(item.unit_id) : null;

          if (!unitId && rawUnit && allUnits.length > 0) {
            const codePart = rawUnit.includes(':') ? rawUnit.split(':')[0].trim() : '';
            const namePart = rawUnit.includes(':') ? rawUnit.split(':').slice(1).join(':').trim() : rawUnit;

            const found = allUnits.find(u =>
              (codePart && String(u.unit_code).trim() === codePart) ||
              String(u.unit_name).trim() === namePart ||
              String(u.unit_name).trim() === rawUnit
            );
            if (found) {
              unitId = found.id;
              if (!cleanRegion && found.army_region) cleanRegion = found.army_region;
            }
          }

          const existing = await sql`SELECT id FROM users WHERE phone = ${cleanPhone} LIMIT 1`;
          if (existing.length > 0) {
            try {
              await sql`
                UPDATE users 
                SET rank = ${item.rank || ''},
                    name_surname = ${item.name_surname || ''},
                    role = ${role},
                    army_region = ${cleanRegion},
                    unit_id = ${unitId},
                    unit_name = ${rawUnit},
                    is_active = true
                WHERE phone = ${cleanPhone}
              `;
            } catch (_) {
              await sql`
                UPDATE users 
                SET rank = ${item.rank || ''},
                    name_surname = ${item.name_surname || ''},
                    role = ${role},
                    army_region = ${cleanRegion},
                    unit_id = ${unitId},
                    is_active = true
                WHERE phone = ${cleanPhone}
              `;
            }
            updatedCount++;
          } else {
            try {
              await sql`
                INSERT INTO users (phone, pin, rank, name_surname, role, army_region, unit_id, unit_name, is_active)
                VALUES (${cleanPhone}, ${pin}, ${item.rank || ''}, ${item.name_surname || ''}, ${role}, ${cleanRegion}, ${unitId}, ${rawUnit}, true)
              `;
            } catch (_) {
              await sql`
                INSERT INTO users (phone, pin, rank, name_surname, role, army_region, unit_id, is_active)
                VALUES (${cleanPhone}, ${pin}, ${item.rank || ''}, ${item.name_surname || ''}, ${role}, ${cleanRegion}, ${unitId}, true)
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

      const dup = await sql`SELECT id FROM users WHERE phone = ${cleanPhone} LIMIT 1`;
      if (dup.length > 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'เบอร์โทรศัพท์นี้มีอยู่ในระบบแล้ว' }),
          { status: 400, headers }
        );
      }

      const pin = String(body.pin || '123456').trim() || '123456';
      const unitId = body.unit_id ? Number(body.unit_id) : null;

      await sql`
        INSERT INTO users (phone, pin, rank, name_surname, role, army_region, unit_id, is_active)
        VALUES (
          ${cleanPhone},
          ${pin},
          ${body.rank || ''},
          ${body.name_surname},
          ${body.role || 'unit'},
          ${body.army_region || ''},
          ${unitId},
          true
        )
      `;

      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // 3. PUT: แก้ไขข้อมูล / รีเซ็ต PIN / เปิด-ปิดสถานะ
    if (method === 'PUT') {
      const body = await request.json();
      if (!body.id) {
        return new Response(JSON.stringify({ success: false, error: 'ไม่พบ ID' }), { status: 400, headers });
      }

      if (body.action === 'reset_pin') {
        await sql`UPDATE users SET pin = ${String(body.pin || '123456').trim()} WHERE id = ${Number(body.id)}`;
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      if (body.action === 'toggle_status') {
        await sql`UPDATE users SET is_active = ${Boolean(body.is_active)} WHERE id = ${Number(body.id)}`;
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      const cleanPhone = String(body.phone || '').replace(/[^0-9]/g, '');
      const unitId = body.unit_id ? Number(body.unit_id) : null;

      if (body.pin && String(body.pin).trim() !== '') {
        await sql`
          UPDATE users
          SET phone = ${cleanPhone},
              pin = ${String(body.pin).trim()},
              rank = ${body.rank || ''},
              name_surname = ${body.name_surname || ''},
              role = ${body.role || 'unit'},
              army_region = ${body.army_region || ''},
              unit_id = ${unitId}
          WHERE id = ${Number(body.id)}
        `;
      } else {
        await sql`
          UPDATE users
          SET phone = ${cleanPhone},
              rank = ${body.rank || ''},
              name_surname = ${body.name_surname || ''},
              role = ${body.role || 'unit'},
              army_region = ${body.army_region || ''},
              unit_id = ${unitId}
          WHERE id = ${Number(body.id)}
        `;
      }

      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // 4. DELETE: ลบผู้ใช้งาน
    if (method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return new Response(JSON.stringify({ success: false, error: 'ไม่พบ ID' }), { status: 400, headers });

      const target = await sql`SELECT phone FROM users WHERE id = ${Number(id)} LIMIT 1`;
      if (target.length > 0 && target[0].phone === '0800000000') {
        return new Response(JSON.stringify({ success: false, error: 'ไม่สามารถลบบัญชีแอดมินหลักได้' }), { status: 403, headers });
      }

      await sql`DELETE FROM users WHERE id = ${Number(id)}`;
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
