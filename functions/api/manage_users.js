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

    const getPhoneVal = (row) => {
      for (const c of ['phone', 'phone_number', 'username', 'tel', 'เบอร์โทร', 'เบอร์โทรศัพท์']) {
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

    const getUnitVal = (row) => {
      for (const c of ['unit_name', 'raw_unit', 'ชื่อหน่วยฝึก', 'หน่วยฝึก', 'unit', 'unit_title', 'training_unit']) {
        if (row[c] !== undefined && row[c] !== null && String(row[c]).trim() !== '') {
          const val = String(row[c]).trim();
          if (val !== '-' && val !== 'ส่วนกลาง') return val;
        }
      }
      return '';
    };

    const getRegionVal = (row) => {
      for (const c of ['army_region', 'กองทัพภาค', 'สังกัด']) {
        if (row[c] !== undefined && row[c] !== null && String(row[c]).trim() !== '') {
          let val = String(row[c]).trim();
          if (val.includes(':')) {
            val = val.split(':').pop().trim();
          }
          return val;
        }
      }
      return '';
    };

    const getRankVal = (row) => {
      for (const c of ['rank', 'ยศ', 'คำนำหน้า']) {
        if (row[c] !== undefined && row[c] !== null && String(row[c]).trim() !== '') {
          return String(row[c]).trim();
        }
      }
      return '';
    };

    const getNameVal = (row) => {
      for (const c of ['name_surname', 'full_name', 'ชื่อ-สกุล', 'ชื่อ']) {
        if (row[c] !== undefined && row[c] !== null && String(row[c]).trim() !== '') {
          return String(row[c]).trim();
        }
      }
      return '';
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
      const rawPhone = getPhoneVal(raw) || String(raw.id || '').trim();
      const cleanPhone = rawPhone.replace(/[^0-9]/g, '');
      const pinVal = getPinVal(raw);
      const roleVal = normalizeRole(raw.role || raw['สิทธิ์'] || raw['ระดับสิทธิ์']);
      const cleanRegion = getRegionVal(raw);
      const unitVal = getUnitVal(raw);
      const rankVal = getRankVal(raw);
      const nameVal = getNameVal(raw);
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

    const toCsvCell = (val) => {
      const s = String(val ?? '');
      if (s.includes('"') || s.includes(',') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
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

      if (url.searchParams.get('format') === 'csv') {
        const csvHeaders = ['phone', 'pin', 'rank', 'name_surname', 'role', 'army_region', 'unit_name', 'is_active'];
        const lines = [
          csvHeaders.join(','),
          ...normalized.map(u => csvHeaders.map(h => toCsvCell(u[h])).join(','))
        ];
        return new Response('\uFEFF' + lines.join('\n'), {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="users.csv"',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

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
        const hasPhone = colSet.has('phone');
        const hasPhoneNum = colSet.has('phone_number');
        const hasPin = colSet.has('pin');
        const hasPinHash = colSet.has('pin_hash');
        const hasRank = colSet.has('rank');
        const hasNameSurname = colSet.has('name_surname');
        const hasFirstName = colSet.has('first_name');
        const hasLastName = colSet.has('last_name');
        const hasRole = colSet.has('role');
        const hasRegion = colSet.has('army_region');
        const hasUnitName = colSet.has('unit_name');
        const hasActive = colSet.has('is_active');

        for (const rec of dedupMap.values()) {
          if (existingPhones.has(rec.cleanPhone)) {
            await sql`
              UPDATE users
              SET phone = CASE WHEN ${hasPhone} THEN ${rec.cleanPhone} ELSE phone END,
                  phone_number = CASE WHEN ${hasPhoneNum} THEN ${rec.cleanPhone} ELSE phone_number END,
                  pin = CASE WHEN ${hasPin} THEN ${rec.pinVal} ELSE pin END,
                  pin_hash = CASE WHEN ${hasPinHash} THEN ${rec.pinVal} ELSE pin_hash END,
                  rank = CASE WHEN ${hasRank} THEN ${rec.rankVal} ELSE rank END,
                  name_surname = CASE WHEN ${hasNameSurname} THEN ${rec.nameVal} ELSE name_surname END,
                  first_name = CASE WHEN ${hasFirstName} THEN ${rec.firstVal} ELSE first_name END,
                  last_name = CASE WHEN ${hasLastName} THEN ${rec.lastVal} ELSE last_name END,
                  role = CASE WHEN ${hasRole} THEN ${rec.roleVal} ELSE role END,
                  army_region = CASE WHEN ${hasRegion} AND ${rec.cleanRegion} <> '' THEN ${rec.cleanRegion} ELSE army_region END,
                  unit_name = CASE WHEN ${hasUnitName} AND ${rec.unitVal} <> '' THEN ${rec.unitVal} ELSE unit_name END,
                  is_active = CASE WHEN ${hasActive} THEN ${rec.activeVal} ELSE is_active END
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
      const nextUnit = body.unit_name !== undefined ? String(body.unit_name).trim() : (current.unit_name || '');

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
            unit_name = ${nextUnit}
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
