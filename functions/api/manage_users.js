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
    const colsInfo = await sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'
    `;
    const colMap = new Map(colsInfo.map(c => [c.column_name, c]));

    const ensureCol = async (name, ddlSuffix) => {
      if (!colMap.has(name)) {
        await sql.unsafe(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${name} ${ddlSuffix}`);
        const added = await sql`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'users' AND column_name = ${name}
        `;
        if (added[0]) colMap.set(name, added[0]);
      }
    };

    await ensureCol('phone', 'TEXT');
    await ensureCol('pin', "TEXT DEFAULT '123456'");
    await ensureCol('rank', "TEXT DEFAULT ''");
    await ensureCol('name_surname', "TEXT DEFAULT ''");
    await ensureCol('role', "TEXT DEFAULT 'unit'");
    await ensureCol('army_region', "TEXT DEFAULT ''");
    await ensureCol('unit_name', "TEXT DEFAULT ''");
    await ensureCol('is_active', 'BOOLEAN DEFAULT true');

    const phoneCols = ['phone', 'phone_number', 'username', 'tel', 'mobile', 'user_phone'].filter(c => colMap.has(c));
    const pinCols = ['pin_hash', 'pin', 'password', 'passcode', 'user_pin'].filter(c => colMap.has(c));

    const getPhoneVal = (row) => {
      for (const c of phoneCols) {
        if (row[c] !== undefined && row[c] !== null && String(row[c]).trim() !== '') {
          return String(row[c]).trim();
        }
      }
      return '';
    };

    const getPinVal = (row) => {
      for (const c of ['pin', 'pin_hash', 'password', 'passcode', 'user_pin']) {
        if (colMap.has(c) && row[c] !== undefined && row[c] !== null && String(row[c]).trim() !== '') {
          return String(row[c]).trim();
        }
      }
      return '123456';
    };

    const fallbackForCol = (colName, data) => {
      const meta = colMap.get(colName);
      if (data[colName] !== undefined && data[colName] !== null && String(data[colName]) !== '') {
        return data[colName];
      }
      if (!meta) return '';
      if (meta.data_type === 'boolean') return true;
      if (
        meta.data_type.includes('int') ||
        meta.data_type === 'numeric' ||
        meta.data_type === 'real' ||
        meta.data_type === 'double precision'
      ) {
        return 0;
      }
      if (meta.data_type.includes('timestamp') || meta.data_type === 'date') {
        return new Date().toISOString();
      }
      return '';
    };

    const buildRecordPayload = (raw) => {
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

      const payload = {
        phone: cleanPhone,
        phone_number: cleanPhone,
        username: cleanPhone,
        pin: pinVal,
        pin_hash: pinVal,
        password: pinVal,
        rank: rankVal,
        name_surname: nameVal,
        full_name: nameVal,
        role: roleVal,
        army_region: cleanRegion,
        unit_name: unitVal,
        is_active: raw.is_active !== undefined ? Boolean(raw.is_active) : true
      };

      for (const [colName, meta] of colMap.entries()) {
        if (payload[colName] !== undefined) continue;
        if (meta.is_nullable === 'NO' && !meta.column_default) {
          payload[colName] = fallbackForCol(colName, raw);
        }
      }

      return { cleanPhone, pinVal, payload };
    };

    const insertUserRow = async (payload) => {
      const cols = [];
      const vals = [];
      for (const [colName, meta] of colMap.entries()) {
        if (colName === 'id' && meta.column_default) continue;
        if (payload[colName] !== undefined) {
          cols.push(colName);
          vals.push(payload[colName]);
        } else if (meta.is_nullable === 'NO' && !meta.column_default) {
          cols.push(colName);
          vals.push(fallbackForCol(colName, payload));
        }
      }
      const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
      await sql.unsafe(
        `INSERT INTO users (${cols.join(', ')}) VALUES (${placeholders})`,
        vals
      );
    };

    const updateUserByPhone = async (cleanPhone, fieldsToUpdate) => {
      const setClauses = [];
      const vals = [];
      let idx = 1;

      for (const [colName, val] of Object.entries(fieldsToUpdate)) {
        if (colMap.has(colName) && val !== undefined) {
          setClauses.push(`${colName} = $${idx++}`);
          vals.push(val);
        }
      }

      for (const [colName, meta] of colMap.entries()) {
        if (fieldsToUpdate[colName] === undefined && meta.is_nullable === 'NO' && !meta.column_default) {
          setClauses.push(`${colName} = COALESCE(${colName}, $${idx++})`);
          vals.push(fallbackForCol(colName, fieldsToUpdate));
        }
      }

      if (setClauses.length === 0) return;

      const whereConds = phoneCols.map(c => `regexp_replace(COALESCE(${c}::text, ''), '[^0-9]', '', 'g') = $${idx}`);
      vals.push(cleanPhone);

      await sql.unsafe(
        `UPDATE users SET ${setClauses.join(', ')} WHERE ${whereConds.join(' OR ')}`,
        vals
      );
    };

    const findMatchingPhones = async (cleanPhone) => {
      const allRows = await sql`SELECT * FROM users`;
      return allRows.filter(r => getPhoneVal(r).replace(/[^0-9]/g, '') === cleanPhone);
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
        const allRows = await sql`SELECT * FROM users`;
        const existingPhones = new Set(
          allRows.map(r => getPhoneVal(r).replace(/[^0-9]/g, '')).filter(Boolean)
        );

        let importedCount = 0;
        let updatedCount = 0;

        for (const item of body.records) {
          const { cleanPhone, payload } = buildRecordPayload(item);
          if (cleanPhone.length < 9) continue;

          if (existingPhones.has(cleanPhone)) {
            await updateUserByPhone(cleanPhone, payload);
            updatedCount++;
          } else {
            await insertUserRow(payload);
            existingPhones.add(cleanPhone);
            importedCount++;
          }
        }

        return new Response(
          JSON.stringify({ success: true, importedCount, updatedCount }),
          { headers }
        );
      }

      const { cleanPhone, payload } = buildRecordPayload(body);
      if (!cleanPhone || !payload.name_surname) {
        return new Response(
          JSON.stringify({ success: false, error: 'กรุณากรอกเบอร์โทรศัพท์และชื่อ-สกุลให้ครบถ้วน' }),
          { status: 400, headers }
        );
      }

      const dupRows = await findMatchingPhones(cleanPhone);
      if (dupRows.length > 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'เบอร์โทรศัพท์นี้มีอยู่ในระบบแล้ว' }),
          { status: 400, headers }
        );
      }

      await insertUserRow(payload);
      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // 3. PUT: แก้ไขข้อมูล / รีเซ็ต PIN / เปิด-ปิดสถานะ
    if (method === 'PUT') {
      const body = await request.json();
      const { cleanPhone, pinVal, payload } = buildRecordPayload(body);
      if (!cleanPhone) {
        return new Response(JSON.stringify({ success: false, error: 'ไม่พบเบอร์โทรศัพท์อ้างอิง' }), { status: 400, headers });
      }

      if (body.action === 'reset_pin') {
        const pinUpdate = {};
        for (const c of pinCols) pinUpdate[c] = pinVal;
        await updateUserByPhone(cleanPhone, pinUpdate);
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      if (body.action === 'toggle_status') {
        await updateUserByPhone(cleanPhone, { is_active: Boolean(body.is_active) });
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      const updateData = { ...payload };
      if (!body.pin && !body.pin_hash) {
        for (const c of pinCols) delete updateData[c];
      }

      await updateUserByPhone(cleanPhone, updateData);
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

      const whereConds = phoneCols.map(c => `regexp_replace(COALESCE(${c}::text, ''), '[^0-9]', '', 'g') = $1`);
      await sql.unsafe(`DELETE FROM users WHERE ${whereConds.join(' OR ')}`, [idOrPhone]);
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
