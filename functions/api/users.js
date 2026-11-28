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
    const colsRows = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'
    `;
    const colNames = colsRows.map(r => r.column_name);
    const colSet = new Set(colNames);

    const phoneCandidates = ['phone', 'username', 'tel', 'mobile', 'user_phone'];
    let phoneCol = phoneCandidates.find(c => colSet.has(c));

    if (!phoneCol) {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`;
      phoneCol = 'phone';
      colSet.add('phone');
    }

    const nameCol = colSet.has('name_surname')
      ? 'name_surname'
      : (colSet.has('full_name') ? 'full_name' : null);

    const getPhoneVal = (row) => String(row[phoneCol] || row.phone || row.username || '').trim();

    // 1. GET
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
          name_surname: u.name_surname || u.full_name || '',
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

    // 2. POST (Bulk Import & Single Add)
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
          const rankVal = String(item.rank || '').trim();
          const nameVal = String(item.name_surname || '').trim();

          const allRows = await sql`SELECT * FROM users`;
          const matched = allRows.find(r => getPhoneVal(r).replace(/[^0-9]/g, '') === cleanPhone);

          if (matched) {
            if (phoneCol === 'phone' && colSet.has('rank') && colSet.has('role')) {
              try {
                await sql`
                  UPDATE users
                  SET rank = ${rankVal},
                      role = ${role},
                      army_region = ${cleanRegion},
                      unit_name = ${rawUnit},
                      is_active = true
                  WHERE phone = ${cleanPhone}
                `;
              } catch (_) {
                await sql`
                  UPDATE users
                  SET rank = ${rankVal},
                      role = ${role},
                      army_region = ${cleanRegion}
                  WHERE phone = ${cleanPhone}
                `;
              }
              if (nameCol === 'name_surname') {
                await sql`UPDATE users SET name_surname = ${nameVal} WHERE phone = ${cleanPhone}`;
              } else if (nameCol === 'full_name') {
                await sql`UPDATE users SET full_name = ${nameVal} WHERE phone = ${cleanPhone}`;
              }
            }
            updatedCount++;
          } else {
            if (phoneCol === 'phone') {
              try {
                await sql`
                  INSERT INTO users (phone, pin, rank, role, army_region, unit_name, is_active)
                  VALUES (${cleanPhone}, ${pin}, ${rankVal}, ${role}, ${cleanRegion}, ${rawUnit}, true)
                `;
              } catch (_) {
                await sql`
                  INSERT INTO users (phone, pin, rank, role, army_region)
                  VALUES (${cleanPhone}, ${pin}, ${rankVal}, ${role}, ${cleanRegion})
                `;
              }
              if (nameCol === 'name_surname') {
                await sql`UPDATE users SET name_surname = ${nameVal} WHERE phone = ${cleanPhone}`;
              } else if (nameCol === 'full_name') {
                await sql`UPDATE users SET full_name = ${nameVal} WHERE phone = ${cleanPhone}`;
              }
            }
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

      const allRows = await sql`SELECT * FROM users`;
      const dup = allRows.find(r => getPhoneVal(r).replace(/[^0-9]/g, '') === cleanPhone);
      if (dup) {
        return new Response(
          JSON.stringify({ success: false, error: 'เบอร์โทรศัพท์นี้มีอยู่ในระบบแล้ว' }),
          { status: 400, headers }
        );
      }

      const pin = String(body.pin || '123456').trim() || '123456';
      try {
        await sql`
          INSERT INTO users (phone, pin, rank, role, army_region, is_active)
          VALUES (${cleanPhone}, ${pin}, ${body.rank || ''}, ${body.role || 'unit'}, ${body.army_region || ''}, true)
        `;
      } catch (_) {
        await sql`
          INSERT INTO users (phone, pin, rank, role, army_region)
          VALUES (${cleanPhone}, ${pin}, ${body.rank || ''}, ${body.role || 'unit'}, ${body.army_region || ''})
        `;
      }
      if (nameCol === 'name_surname') {
        await sql`UPDATE users SET name_surname = ${body.name_surname} WHERE phone = ${cleanPhone}`;
      } else if (nameCol === 'full_name') {
        await sql`UPDATE users SET full_name = ${body.name_surname} WHERE phone = ${cleanPhone}`;
      }

      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // 3. PUT
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

      await sql`
        UPDATE users
        SET rank = ${body.rank || ''},
            role = ${body.role || 'unit'},
            army_region = ${body.army_region || ''}
        WHERE phone = ${targetPhone}
      `;
      if (body.pin && String(body.pin).trim() !== '') {
        await sql`UPDATE users SET pin = ${String(body.pin).trim()} WHERE phone = ${targetPhone}`;
      }
      if (nameCol === 'name_surname') {
        await sql`UPDATE users SET name_surname = ${body.name_surname || ''} WHERE phone = ${targetPhone}`;
      } else if (nameCol === 'full_name') {
        await sql`UPDATE users SET full_name = ${body.name_surname || ''} WHERE phone = ${targetPhone}`;
      }

      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // 4. DELETE
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
