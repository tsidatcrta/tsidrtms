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
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS rank TEXT DEFAULT ''`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS name_surname TEXT DEFAULT ''`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'unit'`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS army_region TEXT DEFAULT ''`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS unit_name TEXT DEFAULT ''`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`;

    const colsInfo = await sql`
      SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'
    `;
    const colNames = new Set(colsInfo.map(c => c.column_name));
    const notNullCols = colsInfo.filter(c => c.is_nullable === 'NO');

    const phoneCols = ['phone', 'phone_number', 'username', 'tel', 'mobile', 'user_phone'].filter(c => colNames.has(c));
    const getPhoneVal = (row) => {
      for (const c of phoneCols) {
        if (row[c] !== undefined && row[c] !== null && String(row[c]).trim() !== '') {
          return String(row[c]).trim();
        }
      }
      return '';
    };

    const syncAllPhoneCols = async (targetPhone) => {
      if (colNames.has('phone')) {
        await sql`UPDATE users SET phone = ${targetPhone} WHERE phone = ${targetPhone} OR phone_number = ${targetPhone}`;
      }
      if (colNames.has('phone_number')) {
        await sql`UPDATE users SET phone_number = ${targetPhone} WHERE phone_number = ${targetPhone} OR phone = ${targetPhone}`;
      }
    };

    const findRowByPhone = async (cleanPhone) => {
      const allRows = await sql`SELECT * FROM users`;
      return allRows.find(r => getPhoneVal(r).replace(/[^0-9]/g, '') === cleanPhone) || null;
    };

    const fillAnyMissingNotNull = async (cleanPhone, defaultMap = {}) => {
      for (const col of notNullCols) {
        const name = col.column_name;
        if (phoneCols.includes(name)) continue;
        const fallback = defaultMap[name] !== undefined
          ? defaultMap[name]
          : (col.data_type === 'boolean' ? true : (col.data_type.includes('int') || col.data_type === 'numeric' ? 0 : ''));

        if (name === 'pin' && colNames.has('pin')) {
          await sql`UPDATE users SET pin = COALESCE(pin, ${String(fallback)}) WHERE phone = ${cleanPhone} OR phone_number = ${cleanPhone}`;
        } else if (name === 'role' && colNames.has('role')) {
          await sql`UPDATE users SET role = COALESCE(role, ${String(fallback)}) WHERE phone = ${cleanPhone} OR phone_number = ${cleanPhone}`;
        } else if (name === 'name_surname' && colNames.has('name_surname')) {
          await sql`UPDATE users SET name_surname = COALESCE(name_surname, ${String(fallback)}) WHERE phone = ${cleanPhone} OR phone_number = ${cleanPhone}`;
        } else if (name === 'full_name' && colNames.has('full_name')) {
          await sql`UPDATE users SET full_name = COALESCE(full_name, ${String(fallback)}) WHERE phone = ${cleanPhone} OR phone_number = ${cleanPhone}`;
        } else if (name === 'rank' && colNames.has('rank')) {
          await sql`UPDATE users SET rank = COALESCE(rank, ${String(fallback)}) WHERE phone = ${cleanPhone} OR phone_number = ${cleanPhone}`;
        } else if (name === 'army_region' && colNames.has('army_region')) {
          await sql`UPDATE users SET army_region = COALESCE(army_region, ${String(fallback)}) WHERE phone = ${cleanPhone} OR phone_number = ${cleanPhone}`;
        } else if (name === 'unit_name' && colNames.has('unit_name')) {
          await sql`UPDATE users SET unit_name = COALESCE(unit_name, ${String(fallback)}) WHERE phone = ${cleanPhone} OR phone_number = ${cleanPhone}`;
        }
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
          pin: String(u.pin || u.password || '123456'),
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
        const allRows = await sql`SELECT * FROM users`;
        const existingPhones = new Set(
          allRows.map(r => getPhoneVal(r).replace(/[^0-9]/g, '')).filter(Boolean)
        );

        let importedCount = 0;
        let updatedCount = 0;

        for (const item of body.records) {
          const cleanPhone = String(item.phone || item.phone_number || '').replace(/[^0-9]/g, '');
          if (cleanPhone.length < 9) continue;

          const pin = String(item.pin || '123456').trim() || '123456';
          const role = ['admin', 'command', 'unit'].includes(item.role) ? item.role : 'unit';

          let cleanRegion = String(item.army_region || '').trim();
          if (cleanRegion.includes(':')) {
            cleanRegion = cleanRegion.split(':').pop().trim();
          }

          const rawUnit = String(item.raw_unit || item.unit_name || '').trim();
          const rankVal = String(item.rank || '').trim();
          const nameVal = String(item.name_surname || '').trim();

          if (existingPhones.has(cleanPhone)) {
            await sql`
              UPDATE users
              SET phone = ${cleanPhone},
                  phone_number = ${cleanPhone},
                  pin = ${pin},
                  rank = ${rankVal},
                  name_surname = ${nameVal},
                  role = ${role},
                  army_region = ${cleanRegion},
                  unit_name = ${rawUnit},
                  is_active = true
              WHERE phone = ${cleanPhone} OR phone_number = ${cleanPhone}
            `;
            await fillAnyMissingNotNull(cleanPhone, {
              pin,
              rank: rankVal,
              name_surname: nameVal,
              full_name: nameVal,
              role,
              army_region: cleanRegion,
              unit_name: rawUnit
            });
            updatedCount++;
          } else {
            await sql`
              INSERT INTO users (phone, phone_number, pin, rank, name_surname, role, army_region, unit_name, is_active)
              VALUES (${cleanPhone}, ${cleanPhone}, ${pin}, ${rankVal}, ${nameVal}, ${role}, ${cleanRegion}, ${rawUnit}, true)
            `;
            await fillAnyMissingNotNull(cleanPhone, {
              pin,
              rank: rankVal,
              name_surname: nameVal,
              full_name: nameVal,
              role,
              army_region: cleanRegion,
              unit_name: rawUnit
            });
            existingPhones.add(cleanPhone);
            importedCount++;
          }
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

      const dup = await findRowByPhone(cleanPhone);
      if (dup) {
        return new Response(
          JSON.stringify({ success: false, error: 'เบอร์โทรศัพท์นี้มีอยู่ในระบบแล้ว' }),
          { status: 400, headers }
        );
      }

      const pin = String(body.pin || '123456').trim() || '123456';
      await sql`
        INSERT INTO users (phone, phone_number, pin, rank, name_surname, role, army_region, unit_name, is_active)
        VALUES (
          ${cleanPhone},
          ${cleanPhone},
          ${pin},
          ${body.rank || ''},
          ${body.name_surname || ''},
          ${body.role || 'unit'},
          ${body.army_region || ''},
          ${body.unit_name || ''},
          true
        )
      `;
      await fillAnyMissingNotNull(cleanPhone, {
        pin,
        rank: body.rank || '',
        name_surname: body.name_surname || '',
        full_name: body.name_surname || '',
        role: body.role || 'unit',
        army_region: body.army_region || '',
        unit_name: body.unit_name || ''
      });

      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // 3. PUT: แก้ไขข้อมูล / รีเซ็ต PIN / เปิด-ปิดสถานะ
    if (method === 'PUT') {
      const body = await request.json();
      const targetPhone = String(body.phone || body.phone_number || body.id || '').replace(/[^0-9]/g, '');
      if (!targetPhone) {
        return new Response(JSON.stringify({ success: false, error: 'ไม่พบเบอร์โทรศัพท์อ้างอิง' }), { status: 400, headers });
      }

      await syncAllPhoneCols(targetPhone);

      if (body.action === 'reset_pin') {
        await sql`
          UPDATE users
          SET pin = ${String(body.pin || '123456').trim()}
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

      if (body.pin && String(body.pin).trim() !== '') {
        await sql`
          UPDATE users
          SET phone = ${targetPhone},
              phone_number = ${targetPhone},
              pin = ${String(body.pin).trim()},
              rank = ${body.rank || ''},
              name_surname = ${body.name_surname || ''},
              role = ${body.role || 'unit'},
              army_region = ${body.army_region || ''},
              unit_name = ${body.unit_name || ''}
          WHERE phone = ${targetPhone} OR phone_number = ${targetPhone}
        `;
      } else {
        await sql`
          UPDATE users
          SET phone = ${targetPhone},
              phone_number = ${targetPhone},
              rank = ${body.rank || ''},
              name_surname = ${body.name_surname || ''},
              role = ${body.role || 'unit'},
              army_region = ${body.army_region || ''},
              unit_name = ${body.unit_name || ''}
          WHERE phone = ${targetPhone} OR phone_number = ${targetPhone}
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
