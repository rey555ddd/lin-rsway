// 柴犬聯盟 抽獎活動 API
// KV binding: LIN_RSWAY_LOTTERY
// key: lot:{id} → { id, name, prizes:[{title,count}], pinHash, ownerToken, registrants:[name], draws:[{prize,winner}], createdAt }
// 路由：POST/GET /api/lottery?action=create|info|register|manage|draw|result&id=...

const HEADERS_JSON = { 'content-type': 'application/json; charset=utf-8' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS_JSON });
}
function err(msg, status = 400) { return json({ error: msg }, status); }

function rndId(len = 8) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const arr = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(arr).map(b => chars[b % chars.length]).join('');
}
function rndToken() {
  const arr = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getLot(env, id) {
  const raw = await env.LIN_RSWAY_LOTTERY.get('lot:' + id);
  return raw ? JSON.parse(raw) : null;
}
async function putLot(env, lot) {
  await env.LIN_RSWAY_LOTTERY.put('lot:' + lot.id, JSON.stringify(lot));
}

function publicInfo(lot) {
  return {
    id: lot.id,
    name: lot.name,
    prizes: lot.prizes,
    registrantCount: (lot.registrants || []).length,
    drawn: (lot.draws || []).length > 0,
    createdAt: lot.createdAt,
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const id = url.searchParams.get('id');

  // CORS for safety
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  try {
    // ===== create =====
    if (action === 'create' && request.method === 'POST') {
      const body = await request.json();
      const name = (body.name || '').trim().slice(0, 80);
      const pin = (body.pin || '').trim();
      const prizes = Array.isArray(body.prizes)
        ? body.prizes
            .map(p => ({ title: String(p.title || '').trim().slice(0, 60), count: Math.max(1, Math.min(999, parseInt(p.count) || 0)) }))
            .filter(p => p.title && p.count > 0)
        : [];
      if (!name) return err('缺活動名稱');
      if (pin.length < 4) return err('密碼至少 4 碼');
      if (prizes.length === 0) return err('至少一個有效獎項');
      if (prizes.length > 30) return err('獎項上限 30');

      const id = rndId(8);
      const ownerToken = rndToken();
      const lot = {
        id, name,
        prizes,
        pinHash: await sha256(pin),
        ownerToken,
        registrants: [],
        draws: [],
        createdAt: Date.now(),
      };
      await putLot(env, lot);
      return json({ id, ownerToken });
    }

    // ===== info（public 報名頁用）=====
    if (action === 'info' && request.method === 'GET') {
      if (!id) return err('缺 id');
      const lot = await getLot(env, id);
      if (!lot) return err('找不到活動', 404);
      return json({ info: publicInfo(lot) });
    }

    // ===== register =====
    if (action === 'register' && request.method === 'POST') {
      if (!id) return err('缺 id');
      const lot = await getLot(env, id);
      if (!lot) return err('找不到活動', 404);
      if ((lot.draws || []).length > 0) return err('已開抽、不能再報名');
      const body = await request.json();
      const name = (body.name || '').trim().slice(0, 30);
      if (!name) return err('填名字');
      lot.registrants = lot.registrants || [];
      if (lot.registrants.length >= 500) return err('報名額滿');
      if (lot.registrants.includes(name)) return err('這個名字已經報過了、換一個');
      lot.registrants.push(name);
      await putLot(env, lot);
      return json({ ok: true, registrantCount: lot.registrants.length });
    }

    // ===== manage（密碼或 ownerToken 解鎖、回完整資料）=====
    if (action === 'manage' && request.method === 'POST') {
      if (!id) return err('缺 id');
      const lot = await getLot(env, id);
      if (!lot) return err('找不到活動', 404);
      const body = await request.json();
      const ok = body.ownerToken
        ? body.ownerToken === lot.ownerToken
        : (body.pin && (await sha256(body.pin)) === lot.pinHash);
      if (!ok) return err('密碼錯誤', 401);
      return json({
        info: {
          id: lot.id,
          name: lot.name,
          prizes: lot.prizes,
          registrants: lot.registrants || [],
          draws: lot.draws || [],
          ownerToken: lot.ownerToken, // 回給前端存 localStorage
        },
      });
    }

    // ===== draw =====
    if (action === 'draw' && request.method === 'POST') {
      if (!id) return err('缺 id');
      const lot = await getLot(env, id);
      if (!lot) return err('找不到活動', 404);
      const body = await request.json();
      const ok = body.ownerToken
        ? body.ownerToken === lot.ownerToken
        : (body.pin && (await sha256(body.pin)) === lot.pinHash);
      if (!ok) return err('密碼錯誤', 401);
      if ((lot.draws || []).length > 0) return err('已抽過、不能重抽');

      const flatPrizes = [];
      lot.prizes.forEach(p => { for (let i = 0; i < p.count; i++) flatPrizes.push(p.title); });
      // shuffle 報名者
      const pool = [...(lot.registrants || [])];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      lot.draws = flatPrizes.map((prize, i) => ({
        prize,
        winner: i < pool.length ? pool[i] : null,
      }));
      await putLot(env, lot);
      return json({ draws: lot.draws });
    }

    // ===== result（公開頁）=====
    if (action === 'result' && request.method === 'GET') {
      if (!id) return err('缺 id');
      const lot = await getLot(env, id);
      if (!lot) return err('找不到活動', 404);
      return json({
        name: lot.name,
        drawn: (lot.draws || []).length > 0,
        draws: lot.draws || [],
      });
    }

    return err('未知 action', 404);
  } catch (e) {
    return err('伺服器錯誤：' + (e.message || String(e)), 500);
  }
}
