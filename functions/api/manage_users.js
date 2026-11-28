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
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS pin TEXT DEFAULT '123456'`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash TEXT DEFAULT '123456'`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS rank TEXT DEFAULT ''`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS name_surname TEXT DEFAULT ''`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'unit'`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS army_region TEXT DEFAULT ''`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS unit_name TEXT DEFAULT ''`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`;

    const colsRows = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'
    `;
    const colSet = new Set(colsRows.map(r => r.column_name));

    const getPhoneVal = (row) => {
      for (const c of ['phone', 'phone_number', 'username', 'tel']) {
        if (row[c] !== undefined && row[c] !== null && String(row[c]).trim() !== '') {
          return String(row[c]).trim();
        }
      }
      return '';
    };

    const getPinVal = (row) => {
      for (const c of ['pin', 'pin_hash', 'password']) {
        if (row[c] !== undefined && row[c] !== null && String(row[c]).trim() !== '') {
          return String(row[c]).trim();
        }
      }
      return '123456';
    };

    const upsertUserRecord = async (raw) => {
      const cleanPhone = String(raw.phone || raw.phone_number || raw.id || '').replace(/[^0-9]/g, '');
      const pinVal = String(raw.pin || raw.pin_hash || '123456').trim() || '123456';
      const roleVal = ['admin', 'command', 'unit'].includes(raw.role) ? raw.role : 'unit';

      let cleanRegion = String(raw.army_region || '').trim();
      if (cleanRegion.includes(':')) {
        cleanRegion = cleanRegion.split(':').pop().trim();
      }

      const unitVal = String(raw.raw_unit || raw.unit_name || '').trim();
      const rankVal = String(raw.rank || '').trim();
      const nameVal = String(raw.name_surname || raw.full_name || '').trim();
      const activeVal = raw.is_active !== undefined ? Boolean(raw.is_active) : true;

      const existing = await sql`
        SELECT *
        FROM users
        WHERE phone = ${cleanPhone} OR phone_number = ${cleanPhone}
        LIMIT 1
      `;

      if (existing.length > 0) {
        await sql`
          UPDATE users
          SET phone = ${cleanPhone},
              phone_number = ${cleanPhone},
              pin = ${pinVal},
              pin_hash = ${pinVal},
              rank = ${rankVal},
              name_surname = ${nameVal},
              role = ${roleVal},
              army_region = ${cleanRegion},
              unit_name = ${unitVal},
              is_active = ${activeVal}
          WHERE phone = ${cleanPhone} OR phone_number = ${cleanPhone}
        `;
        if (colSet.has('full_name')) {
          await sql`
            UPDATE users
            SET full_name = COALESCE(NULLIF(full_name, ''), ${nameVal})
            WHERE phone = ${cleanPhone} OR phone_number = ${cleanPhone}
          `;
        }
        return 'updated';
      } else {
        await sql`
          INSERT INTO users (
            phone, phone_number, pin, pin_hash, rank, name_surname, role, army_region, unit_name, is_active
          )
          VALUES (
            ${cleanPhone}, ${cleanPhone}, ${pinVal}, ${pinVal}, ${rankVal}, ${nameVal}, ${roleVal}, ${cleanRegion}, ${unitVal}, ${activeVal}
          )
        `;
        if (colSet.has('full_name')) {
          await sql`
            UPDATE users
            SET full_name = ${nameVal}
            WHERE phone = ${cleanPhone} OR phone_number = ${cleanPhone}
          `;
        }
        return 'inserted';
      }
    };

    // 1. GET: ดึงรายชื่อผู้ใช้งานทั้งหมด
    if (method === 'GET') {
      const mode = url.searchParams.get('mode');
      if (mode === 'units') {
        return new Response(JSON.stringify({ success: true, units: [] }), { headers });
      }

      const rows = await sql`SELECT * FROM users`;
      const normalized = rows.map(u => {
        const pVal = getPhoneVal(u);
        return {
          ...u,
          phone: pVal,
          phone_number: pVal,
          pin: getPinVal(u),
          rank: u.rank || '',
          name_surname: u.name_surname || u.full_name || '',
          role: u.role || 'unit',
          army_region: u.army_region || '',
          unit_name: u.unit_name || '',
          is_active: u.is_active !== false,
          id: u.id || u.user_id || pVal
        };
      });

      const roleOrder = { admin: 1, command: 2, unit: 3 };
      normalized.sort((a, b) => {
        const rDiff = (roleOrder[a.role] || 9) - (roleOrder[b.role] || 9);
        if (rDiff !== 0) return rDiff;
        return String(a.phone).localeCompare(String(b.phone));
      });

      return new Response(JSON.stringify({ success: true, users: normalized }), { headers });
    }

    // 2. POST: เพิ่มผู้ใช้งานใหม่ หรือ นำเข้าชุดใหญ่
    if (method === 'POST') {
      const body = await request.json();

      if (body.action === 'bulk_import' && Array.isArray(body.records)) {
        let importedCount = 0;
        let updatedCount = 0;

        for (const item of body.records) {
          const cleanPhone = String(item.phone || item.phone_number || '').replace(/[^0-9]/g, '');
          if (cleanPhone.length < 9) continue;

          const status = await upsertUserRecord(item);
          if (status === 'inserted') importedCount++;
          else updatedCount++;
        }

        return new Response(
          JSON.stringify({ success: true, importedCount, updatedCount }),
          { headers }
        );
      }

      const cleanPhone = String(body.phone || body.phone_number || '').replace(/[^0-9]/g, '');
      if (!cleanPhone || !body.name_surname) {
        return new Response(
          JSON.stringify({ success: false, error: 'กรุณากรอกเบอร์โทรศัพท์และชื่อ-สกุลให้ครบถ้วน' }),
          { status: 400, headers }
        );
      }

      const dup = await sql`
        SELECT phone
        FROM users
        WHERE phone = ${cleanPhone} OR phone_number = ${cleanPhone}
        LIMIT 1
      `;
      if (dup.length > 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'เบอร์โทรศัพท์นี้มีอยู่ในระบบแล้ว' }),
          { status: 400, headers }
        );
      }

      await upsertUserRecord(body);
      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // 3. PUT: แก้ไขข้อมูล / รีเซ็ต PIN / เปิด-ปิดสถานะ
    if (method === 'PUT') {
      const body = await request.json();
      const targetPhone = String(body.phone || body.phone_number || body.id || '').replace(/[^0-9]/g, '');
      if (!targetPhone) {
        return new Response(JSON.stringify({ success: false, error: 'ไม่พบเบอร์โทรศัพท์อ้างอิง' }), { status: 400, headers });
      }

      if (body.action === 'reset_pin') {
        const newPin = String(body.pin || '123456').trim() || '123456';
        await sql`
          UPDATE users
          SET pin = ${newPin},
              pin_hash = ${newPin}
          WHERE phone = ${targetPhone} OR phone_number = ${targetPhone}
        `;
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      if (body.action === 'toggle_status') {
        await sql`
          UPDATE users
          SET is_active = ${Boolean(body.is_active)}
          WHERE phone = ${targetPhone} OR phone_number = ${targetPhone}
        `;
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      const currentRows = await sql`
        SELECT *
        FROM users
        WHERE phone = ${targetPhone} OR phone_number = ${targetPhone}
        LIMIT 1
      `;
      const current = currentRows[0] || {};
      const pinToSave = (body.pin && String(body.pin).trim() !== '')
        ? String(body.pin).trim()
        : getPinVal(current);

      await sql`
        UPDATE users
        SET phone = ${targetPhone},
            phone_number = ${targetPhone},
            pin = ${pinToSave},
            pin_hash = ${pinToSave},
            rank = ${body.rank !== undefined ? String(body.rank).trim() : (current.rank || '')},
            name_surname = ${body.name_surname !== undefined ? String(body.name_surname).trim() : (current.name_surname || current.full_name || '')},
            role = ${body.role || current.role || 'unit'},
            army_region = ${body.army_region !== undefined ? String(body.army_region).trim() : (current.army_region || '')},
            unit_name = ${body.unit_name !== undefined ? String(body.unit_name).trim() : (current.unit_name || '')}
        WHERE phone = ${targetPhone} OR phone_number = ${targetPhone}
      `;

      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // 4. DELETE: ลบผู้ใช้งาน
    if (method === 'DELETE') {
      const idOrPhone = String(url.searchParams.get('id') || '').replace(/[^0-9]/g, '');
      if (!idOrPhone) {
        return new Response(JSON.stringify({ success: false, error: 'ไม่พบข้อมูลที่ต้องการลบ' }), { status: 400, headers });
      }
      if (idOrPhone === '0800000000') {
        return new Response(JSON.stringify({ success: false, error: 'ไม่สามารถลบบัญชีแอดมินหลักได้' }), { status: 403, headers });
      }

      await sql`DELETE FROM users WHERE phone = ${idOrPhone} OR phone_number = ${idOrPhone}`;
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
