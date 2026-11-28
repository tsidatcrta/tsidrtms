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
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS pin TEXT DEFAULT '123456'`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS rank TEXT DEFAULT ''`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS name_surname TEXT DEFAULT ''`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'unit'`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS army_region TEXT DEFAULT ''`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS unit_name TEXT DEFAULT ''`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`;

    const getPhoneVal = (row) => String(row.phone || row.username || row.tel || '').trim();

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
          const cleanPhone = String(item.phone || '').replace(/[^0-9]/g, '');
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
              SET pin = ${pin},
                  rank = ${rankVal},
                  name_surname = ${nameVal},
                  role = ${role},
                  army_region = ${cleanRegion},
                  unit_name = ${rawUnit},
                  is_active = true
              WHERE phone = ${cleanPhone}
            `;
            updatedCount++;
          } else {
            await sql`
              INSERT INTO users (phone, pin, rank, name_surname, role, army_region, unit_name, is_active)
              VALUES (${cleanPhone}, ${pin}, ${rankVal}, ${nameVal}, ${role}, ${cleanRegion}, ${rawUnit}, true)
            `;
            existingPhones.add(cleanPhone);
            importedCount++;
          }
        }

        return new Response(
          JSON.stringify({ success: true, importedCount, updatedCount }),
          { headers }
        );
      }

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
      await sql`
        INSERT INTO users (phone, pin, rank, name_surname, role, army_region, unit_name, is_active)
        VALUES (
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

      return new Response(JSON.stringify({ success: true }), { headers });
    }

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
          SET pin = ${String(body.pin).trim()},
              rank = ${body.rank || ''},
              name_surname = ${body.name_surname || ''},
              role = ${body.role || 'unit'},
              army_region = ${body.army_region || ''},
              unit_name = ${body.unit_name || ''}
          WHERE phone = ${targetPhone}
        `;
      } else {
        await sql`
          UPDATE users
          SET rank = ${body.rank || ''},
              name_surname = ${body.name_surname || ''},
              role = ${body.role || 'unit'},
              army_region = ${body.army_region || ''},
              unit_name = ${body.unit_name || ''}
          WHERE phone = ${targetPhone}
        `;
      }

      return new Response(JSON.stringify({ success: true }), { headers });
    }

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
