/**
 * Consumos que dan los propios servicios. Cada proveedor devuelve siempre un objeto con `estado`:
 *   'ok' | 'sin_configurar' | 'error' (con `mensaje`). Nunca lanza: el panel muestra lo que haya.
 * Todos son de solo lectura. ElevenLabs usa la clave que ya existe; GitHub y Anthropic piden credenciales propias y
 * opcionales (token de facturacion de la organizacion y clave de administracion), por eso salen "sin configurar" hasta
 * que se definan. Los formatos de GitHub y Anthropic estan escritos segun su documentacion publica y se leen de forma
 * defensiva: si cambian, el panel lo dice en vez de romperse.
 */
const SIN_CONFIGURAR = (mensaje) => ({ estado: 'sin_configurar', mensaje });
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function getJson(fetchImpl, url, headers) {
  let res;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new Error(`no se ha podido conectar (${err.message})`);
  }
  if (res.status === 401 || res.status === 403) throw new Error('la credencial no es válida o no tiene permiso para leer el consumo');
  if (res.status === 404) throw new Error('el servicio no ha encontrado ese recurso');
  if (!res.ok) throw new Error(`el servicio ha respondido ${res.status}`);
  return res.json();
}

export function elevenLabsUsage({ apiKey, baseUrl = 'https://api.elevenlabs.io', fetchImpl = fetch }) {
  return async () => {
    if (!apiKey) return SIN_CONFIGURAR('Sin clave de ElevenLabs.');
    try {
      const s = await getJson(fetchImpl, `${baseUrl.replace(/\/+$/, '')}/v1/user/subscription`, { 'xi-api-key': apiKey });
      return {
        estado: 'ok',
        plan: String(s.tier ?? ''),
        estadoPlan: String(s.status ?? ''),
        usados: num(s.character_count),
        limite: num(s.character_limit),
        reinicio: s.next_character_count_reset_unix ? new Date(num(s.next_character_count_reset_unix) * 1000).toISOString() : null,
      };
    } catch (err) {
      return { estado: 'error', mensaje: `ElevenLabs: ${err.message}.` };
    }
  };
}

export function githubUsage({ token, org, fetchImpl = fetch, now = Date.now }) {
  return async () => {
    if (!token || !org) return SIN_CONFIGURAR('Falta GITHUB_BILLING_TOKEN (permiso de facturación de la organización) y GITHUB_ORG.');
    const d = new Date(now());
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    try {
      const j = await getJson(fetchImpl, `https://api.github.com/organizations/${encodeURIComponent(org)}/settings/billing/usage?year=${year}&month=${month}`, {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      });
      const porSku = new Map();
      const porDia = new Map();
      let bruto = 0;
      let neto = 0;
      let minutos = 0;
      for (const it of j.usageItems ?? []) {
        const key = `${it.product}|${it.sku}`;
        const acc = porSku.get(key) ?? { producto: String(it.product ?? ''), sku: String(it.sku ?? ''), unidad: String(it.unitType ?? ''), cantidad: 0, bruto: 0, neto: 0 };
        acc.cantidad += num(it.quantity);
        acc.bruto += num(it.grossAmount);
        acc.neto += num(it.netAmount);
        porSku.set(key, acc);
        bruto += num(it.grossAmount);
        neto += num(it.netAmount);
        if (/actions/i.test(String(it.product)) && /min/i.test(String(it.unitType))) {
          minutos += num(it.quantity);
          const dia = String(it.date ?? '').slice(0, 10);
          if (dia) porDia.set(dia, (porDia.get(dia) ?? 0) + num(it.quantity));
        }
      }
      return {
        estado: 'ok',
        organizacion: org,
        mes: `${year}-${String(month).padStart(2, '0')}`,
        minutosActions: Math.round(minutos * 10) / 10,
        totalBruto: Math.round(bruto * 100) / 100,
        totalFacturado: Math.round(neto * 100) / 100,
        items: [...porSku.values()].sort((a, b) => b.bruto - a.bruto).slice(0, 8),
        serieMinutos: [...porDia.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([fecha, minutos]) => ({ fecha, minutos })),
      };
    } catch (err) {
      return { estado: 'error', mensaje: `GitHub: ${err.message}.` };
    }
  };
}

export function anthropicUsage({ adminKey, fetchImpl = fetch, now = Date.now }) {
  return async () => {
    if (!adminKey) return SIN_CONFIGURAR('Falta ANTHROPIC_ADMIN_KEY (clave de administración de la organización).');
    const headers = { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' };
    const end = new Date(now());
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    const q = `starting_at=${encodeURIComponent(start.toISOString())}&ending_at=${encodeURIComponent(end.toISOString())}&bucket_width=1d&limit=31`;
    try {
      const [coste, uso] = await Promise.all([
        getJson(fetchImpl, `https://api.anthropic.com/v1/organizations/cost_report?${q}`, headers),
        getJson(fetchImpl, `https://api.anthropic.com/v1/organizations/usage_report/messages?${q}&group_by[]=model`, headers),
      ]);
      let total = 0;
      const serie = [];
      for (const b of coste.data ?? []) {
        // La API da el importe en centimos de dolar como texto decimal.
        const dia = (b.results ?? []).reduce((s, r) => s + num(r.amount), 0) / 100;
        total += dia;
        serie.push({ fecha: String(b.starting_at ?? '').slice(0, 10), coste: Math.round(dia * 100) / 100 });
      }
      const modelos = new Map();
      for (const b of uso.data ?? []) {
        for (const r of b.results ?? []) {
          const m = modelos.get(r.model ?? 'desconocido') ?? { modelo: r.model ?? 'desconocido', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          m.input += num(r.uncached_input_tokens);
          m.output += num(r.output_tokens);
          m.cacheRead += num(r.cache_read_input_tokens);
          const cw = r.cache_creation ?? {};
          m.cacheWrite += num(cw.ephemeral_1h_input_tokens) + num(cw.ephemeral_5m_input_tokens);
          modelos.set(m.modelo, m);
        }
      }
      return {
        estado: 'ok',
        mes: start.toISOString().slice(0, 7),
        gastoMes: Math.round(total * 100) / 100,
        moneda: 'USD',
        serie,
        modelos: [...modelos.values()].sort((a, b) => b.input + b.output - (a.input + a.output)).slice(0, 6),
      };
    } catch (err) {
      return { estado: 'error', mensaje: `Anthropic: ${err.message}.` };
    }
  };
}
