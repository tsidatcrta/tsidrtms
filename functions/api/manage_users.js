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
    const colSet = new Set(colsRows.map(r => r.column_name));

    const requiredCols = [
      ['phone', 'TEXT'],
      ['phone_number', 'TEXT'],
      ['pin', "TEXT DEFAULT '123456'"],
      ['pin_hash', "TEXT DEFAULT '123456'"],
      ['rank', "TEXT DEFAULT ''"],
      ['name_surname', "TEXT DEFAULT ''"],
      ['first_name', "TEXT DEFAULT ''"],
      ['last_name', "TEXT DEFAULT ''"],
      ['role', "TEXT DEFAULT 'unit'"],
      ['army_region', "TEXT DEFAULT ''"],
      ['unit_name', "TEXT DEFAULT ''"],
      ['is_active', 'BOOLEAN DEFAULT true']
    ];

    for (const [colName, ddl] of requiredCols) {
      if (!colSet.has(colName)) {
        await sql`SELECT 1`;
        if (colName === 'phone') await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`;
        else if (colName === 'phone_number') await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT`;
        else if (colName === 'pin') await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS pin TEXT DEFAULT '123456'`;
        else if (colName === 'pin_hash') await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash TEXT DEFAULT '123456'`;
        else if (colName === 'rank') await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS rank TEXT DEFAULT ''`;
        else if (colName === 'name_surname') await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS name_surname TEXT DEFAULT ''`;
        else if (colName === 'first_name') await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT DEFAULT ''`;
        else if (colName === 'last_name') await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT DEFAULT ''`;
        else if (colName === 'role') await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'unit'`;
        else if (colName === 'army_region') await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS army_region TEXT DEFAULT ''`;
        else if (colName === 'unit_name') await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS unit_name TEXT DEFAULT ''`;
        else if (colName === 'is_active') await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`;
        colSet.add(colName);
      }
    }

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

    const normalizeRole = (rawRole) => {
      const r = String(rawRole || '').trim().toLowerCase();
      if (['admin', 'ผู้ดูแลระบบ', 'แอดมิน'].includes(r)) return 'admin';
      if (['command', 'ทภ.', 'นขต.ทบ.', 'ผู้บังคับบัญชา', 'commander'].includes(r)) return 'command';
      if (['trainer', 'ผู้ฝึก', 'ครูฝึก'].includes(r)) return 'trainer';
      if (['user', 'หน่วย', 'หน่วยฝึก', 'unit'].includes(r)) return 'unit';
      return 'unit';
    };

    const splitName = (fullStr) => {
      const cleaned = String(fullStr || '').trim().replace(/\s+/g, ' ');
      if (!cleaned) return { firstName: '', lastName: '' };
      const parts = cleaned.split(' ');
      return {
        firstName: parts[0] || cleaned,
        lastName: parts.slice(1).join(' ')
      };
    };

    const normalizeRecord = (raw) => {
      const cleanPhone = String(raw.phone || raw.phone_number || raw.id || '').replace(/[^0-9]/g, '');
      const pinVal = String(raw.pin || raw.pin_hash || '123456').trim() || '123456';
      const roleVal = normalizeRole(raw.role);

      let cleanRegion = String(raw.army_region || '').trim();
      if (cleanRegion.includes(':')) {
        cleanRegion = cleanRegion.split(':').pop().trim();
      }

      const unitVal = String(raw.raw_unit || raw.unit_name || '').trim();
      const rankVal = String(raw.rank || '').trim();
      const nameVal = String(raw.name_surname || raw.full_name || '').trim();
      const { firstName, lastName } = splitName(nameVal || rankVal || cleanPhone);
      const firstVal = String(raw.first_name || firstName || '').trim();
      const lastVal = String(raw.last_name || lastName || '').trim();
      const activeVal = raw.is_active !== undefined ? Boolean(raw.is_active) : true;

      return {
        cleanPhone,
        pinVal,
        roleVal,
        cleanRegion,
        unitVal,
        rankVal,
        nameVal,
        firstVal,
        lastVal,
        activeVal
      };
    };

    if (method === 'GET') {
      const mode = url.searchParams.get('mode');
      if (mode === 'units') {
        return new Response(JSON.stringify({ success: true, units: [] }), { headers });
      }

      const rows = await sql`SELECT * FROM users`;
      const normalized = rows.map(u => {
        const pVal = getPhoneVal(u);
        const combinedName = u.name_surname || u.full_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || '';
        return {
          ...u,
          phone: pVal,
          phone_number: pVal,
          pin: getPinVal(u),
          rank: u.rank || '',
          name_surname: combinedName,
          first_name: u.first_name || '',
          last_name: u.last_name || '',
          role: normalizeRole(u.role),
          army_region: u.army_region || '',
          unit_name: u.unit_name || '',
          is_active: u.is_active !== false,
          id: u.id || u.user_id || pVal
        };
      });

      const roleOrder = { admin: 1, command: 2, unit: 3, trainer: 3, user: 3 };
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
        const dedupMap = new Map();
        for (const item of body.records) {
          const rec = normalizeRecord(item);
          if (rec.cleanPhone.length >= 9) {
            dedupMap.set(rec.cleanPhone, rec);
          }
        }

        const allRows = await sql`SELECT * FROM users`;
        const existingPhones = new Set(
          allRows.map(r => getPhoneVal(r).replace(/[^0-9]/g, '')).filter(Boolean)
        );

        let importedCount = 0;
        let updatedCount = 0;
        const hasFullName = colSet.has('full_name');

        for (const rec of dedupMap.values()) {
          if (existingPhones.has(rec.cleanPhone)) {
            await sql`
              UPDATE users
              SET phone = ${rec.cleanPhone},
                  phone_number = ${rec.cleanPhone},
                  pin = ${rec.pinVal},
                  pin_hash = ${rec.pinVal},
                  rank = ${rec.rankVal},
                  name_surname = ${rec.nameVal},
                  first_name = ${rec.firstVal},
                  last_name = ${rec.lastVal},
                  role = ${rec.roleVal},
                  army_region = ${rec.cleanRegion},
                  unit_name = ${rec.unitVal},
                  is_active = ${rec.activeVal}
              WHERE phone = ${rec.cleanPhone} OR phone_number = ${rec.cleanPhone}
            `;
            if (hasFullName) {
              await sql`
                UPDATE users
                SET full_name = COALESCE(NULLIF(full_name, ''), ${rec.nameVal})
                WHERE phone = ${rec.cleanPhone} OR phone_number = ${rec.cleanPhone}
              `;
            }
            updatedCount++;
          } else {
            await sql`
              INSERT INTO users (
                phone, phone_number, pin, pin_hash, rank, name_surname, first_name, last_name, role, army_region, unit_name, is_active
              )
              VALUES (
                ${rec.cleanPhone}, ${rec.cleanPhone}, ${rec.pinVal}, ${rec.pinVal}, ${rec.rankVal}, ${rec.nameVal}, ${rec.firstVal}, ${rec.lastVal}, ${rec.roleVal}, ${rec.cleanRegion}, ${rec.unitVal}, ${rec.activeVal}
              )
            `;
            if (hasFullName) {
              await sql`
                UPDATE users
                SET full_name = ${rec.nameVal}
                WHERE phone = ${rec.cleanPhone} OR phone_number = ${rec.cleanPhone}
              `;
            }
            existingPhones.add(rec.cleanPhone);
            importedCount++;
          }
        }

        return new Response(
          JSON.stringify({ success: true, importedCount, updatedCount }),
          { headers }
        );
      }

      const rec = normalizeRecord(body);
      if (!rec.cleanPhone || !rec.nameVal) {
        return new Response(
          JSON.stringify({ success: false, error: 'กรุณากรอกเบอร์โทรศัพท์และชื่อ-สกุลให้ครบถ้วน' }),
          { status: 400, headers }
        );
      }

      const dup = await sql`
        SELECT phone
        FROM users
        WHERE phone = ${rec.cleanPhone} OR phone_number = ${rec.cleanPhone}
        LIMIT 1
      `;
      if (dup.length > 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'เบอร์โทรศัพท์นี้มีอยู่ในระบบแล้ว' }),
          { status: 400, headers }
        );
      }

      await sql`
        INSERT INTO users (
          phone, phone_number, pin, pin_hash, rank, name_surname, first_name, last_name, role, army_region, unit_name, is_active
        )
        VALUES (
          ${rec.cleanPhone}, ${rec.cleanPhone}, ${rec.pinVal}, ${rec.pinVal}, ${rec.rankVal}, ${rec.nameVal}, ${rec.firstVal}, ${rec.lastVal}, ${rec.roleVal}, ${rec.cleanRegion}, ${rec.unitVal}, ${rec.activeVal}
        )
      `;
      if (colSet.has('full_name')) {
        await sql`
          UPDATE users
          SET full_name = ${rec.nameVal}
          WHERE phone = ${rec.cleanPhone} OR phone_number = ${rec.cleanPhone}
        `;
      }

      return new Response(JSON.stringify({ success: true }), { headers });
    }

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
      const nextName = body.name_surname !== undefined
        ? String(body.name_surname).trim()
        : (current.name_surname || current.full_name || '');
      const { firstName, lastName } = splitName(nextName);
      const nextRole = body.role !== undefined ? normalizeRole(body.role) : normalizeRole(current.role);

      await sql`
        UPDATE users
        SET phone = ${targetPhone},
            phone_number = ${targetPhone},
            pin = ${pinToSave},
            pin_hash = ${pinToSave},
            rank = ${body.rank !== undefined ? String(body.rank).trim() : (current.rank || '')},
            name_surname = ${nextName},
            first_name = ${body.first_name !== undefined ? String(body.first_name).trim() : (firstName || current.first_name || '')},
            last_name = ${body.last_name !== undefined ? String(body.last_name).trim() : (lastName || current.last_name || '')},
            role = ${nextRole},
            army_region = ${body.army_region !== undefined ? String(body.army_region).trim() : (current.army_region || '')},
            unit_name = ${body.unit_name !== undefined ? String(body.unit_name).trim() : (current.unit_name || '')}
        WHERE phone = ${targetPhone} OR phone_number = ${targetPhone}
      `;

      return new Response(JSON.stringify({ success: true }), { headers });
    }

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
