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
    // 1. GET: ดึงรายชื่อผู้ใช้งานทั้งหมด (พร้อมข้อมูลหน่วยและกองทัพภาค) และรายการหน่วยฝึกสำหรับ Dropdown
    if (method === 'GET') {
      const mode = url.searchParams.get('mode');

      // ดึงรายชื่อหน่วยฝึกทั้งหมด (294 หน่วย + หน่วยบังคับบัญชา)
      if (mode === 'units') {
        const units = await sql`
          SELECT id, unit_code, unit_name, army_region, tier_level
          FROM units
          ORDER BY army_region ASC, unit_code ASC, unit_name ASC
        `;
        return new Response(JSON.stringify({ success: true, units }), { headers });
      }

      // ดึงรายชื่อผู้ใช้งานทั้งหมด
      const users = await sql`
        SELECT 
          u.id,
          u.phone,
          u.rank,
          u.full_name,
          u.position,
          u.role,
          u.unit_id,
          u.army_region,
          u.is_active,
          u.last_login_at,
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
          u.army_region ASC,
          un.unit_name ASC,
          u.full_name ASC
      `;

      return new Response(JSON.stringify({ success: true, users }), { headers });
    }

    // 2. POST: เพิ่มผู้ใช้งานใหม่ 1 รายการ หรือ นำเข้าข้อมูลชุดใหญ่ (Bulk Import)
    if (method === 'POST') {
      const body = await request.json();

      // กรณี Bulk Import (นำเข้าจาก CSV/ข้อความวางเป็นชุด)
      if (body.action === 'bulk_import' && Array.isArray(body.records)) {
        let importedCount = 0;
        let updatedCount = 0;

        for (const item of body.records) {
          const cleanPhone = String(item.phone || '').replace(/[^0-9]/g, '');
          if (cleanPhone.length < 9) continue;

          const pin = String(item.pin || '123456').trim();
          const role = item.role || 'unit';
          const region = item.army_region || '';
          const unitId = item.unit_id ? Number(item.unit_id) : null;

          const existing = await sql`SELECT id FROM users WHERE phone = ${cleanPhone} LIMIT 1`;
          if (existing.length > 0) {
            await sql`
              UPDATE users 
              SET rank = ${item.rank || ''},
                  full_name = ${item.full_name || ''},
                  position = ${item.position || ''},
                  role = ${role},
                  army_region = ${region},
                  unit_id = ${unitId},
                  is_active = true
              WHERE phone = ${cleanPhone}
            `;
            updatedCount++;
          } else {
            await sql`
              INSERT INTO users (phone, pin, rank, full_name, position, role, army_region, unit_id, is_active)
              VALUES (${cleanPhone}, ${pin}, ${item.rank || ''}, ${item.full_name || ''}, ${item.position || ''}, ${role}, ${region}, ${unitId}, true)
            `;
            importedCount++;
          }
        }

        return new Response(
          JSON.stringify({ success: true, importedCount, updatedCount }),
          { headers }
        );
      }

      // กรณีเพิ่มผู้ใช้งานทีละ 1 รายการ
      const cleanPhone = String(body.phone || '').replace(/[^0-9]/g, '');
      if (!cleanPhone || !body.full_name) {
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

      const pin = String(body.pin || '123456').trim();
      const unitId = body.unit_id ? Number(body.unit_id) : null;

      await sql`
        INSERT INTO users (phone, pin, rank, full_name, position, role, army_region, unit_id, is_active)
        VALUES (
          ${cleanPhone},
          ${pin},
          ${body.rank || ''},
          ${body.full_name},
          ${body.position || ''},
          ${body.role || 'unit'},
          ${body.army_region || ''},
          ${unitId},
          true
        )
      `;

      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // 3. PUT: แก้ไขข้อมูลผู้ใช้งาน / เปลี่ยนสิทธิ์ / รีเซ็ต PIN / เปิด-ปิดสถานะ
    if (method === 'PUT') {
      const body = await request.json();
      if (!body.id) {
        return new Response(
          JSON.stringify({ success: false, error: 'ไม่พบรหัสอ้างอิงผู้ใช้งาน' }),
          { status: 400, headers }
        );
      }

      // รีเซ็ต PIN เฉพาะจุด
      if (body.action === 'reset_pin') {
        const newPin = String(body.pin || '123456').trim();
        await sql`UPDATE users SET pin = ${newPin} WHERE id = ${Number(body.id)}`;
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // เปิด/ปิด สถานะการใช้งาน
      if (body.action === 'toggle_status') {
        await sql`UPDATE users SET is_active = ${Boolean(body.is_active)} WHERE id = ${Number(body.id)}`;
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // อัปเดตข้อมูลทั่วไป
      const cleanPhone = String(body.phone || '').replace(/[^0-9]/g, '');
      const unitId = body.unit_id ? Number(body.unit_id) : null;

      if (body.pin && String(body.pin).trim() !== '') {
        await sql`
          UPDATE users
          SET phone = ${cleanPhone},
              pin = ${String(body.pin).trim()},
              rank = ${body.rank || ''},
              full_name = ${body.full_name || ''},
              position = ${body.position || ''},
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
              full_name = ${body.full_name || ''},
              position = ${body.position || ''},
              role = ${body.role || 'unit'},
              army_region = ${body.army_region || ''},
              unit_id = ${unitId}
          WHERE id = ${Number(body.id)}
        `;
      }

      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // 4. DELETE: ลบผู้ใช้งาน (ป้องกันการลบแอดมินหลัก 0800000000)
    if (method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) {
        return new Response(JSON.stringify({ success: false, error: 'ไม่พบ ID' }), { status: 400, headers });
      }

      const target = await sql`SELECT phone FROM users WHERE id = ${Number(id)} LIMIT 1`;
      if (target.length > 0 && target[0].phone === '0800000000') {
        return new Response(
          JSON.stringify({ success: false, error: 'ไม่สามารถลบบัญชีผู้ดูแลระบบหลักได้' }),
          { status: 403, headers }
        );
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
