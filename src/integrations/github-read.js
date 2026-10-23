/**
 * GitHub de solo lectura para consultar el codigo de los proyectos (revision automatica y conversacion).
 * Usa un token propio de grano fino con permisos de lectura (Contents, Pull requests, Metadata), distinto del que
 * lanza agentes: con este token es imposible modificar nada. El repositorio nunca lo elige el modelo: lo resuelve
 * el conector a partir del proyecto.
 */
export class GithubReadError extends Error {}

const REPO = /^[\w.-]+\/[\w.-]+$/;
const API = 'https://api.github.com';

const checkRepo = (repo) => {
  if (!REPO.test(repo ?? '')) throw new GithubReadError('Repositorio no válido (formato owner/repo).');
};

/** Rutas relativas dentro del repo, sin saltos de directorio. */
export function cleanPath(path = '') {
  const p = String(path).trim().replace(/^\/+|\/+$/g, '');
  if (p.split('/').some((s) => s === '..' || s === '.')) throw new GithubReadError('Ruta no válida.');
  if (p.length > 300 || /[\0\\]/.test(p)) throw new GithubReadError('Ruta no válida.');
  return p;
}

/** Extrae un tramo de lineas de un texto, acotado en lineas y en caracteres. */
export function slice(text, desdeLinea = 1, { maxLines = 250, maxChars = 7000 } = {}) {
  const lines = text.split('\n');
  const from = Math.max(1, Math.floor(desdeLinea));
  let out = [];
  let chars = 0;
  let i = from - 1;
  for (; i < lines.length && out.length < maxLines; i++) {
    if (chars + lines[i].length + 1 > maxChars && out.length) break;
    out.push(lines[i].slice(0, maxChars));
    chars += lines[i].length + 1;
  }
  const hasta = from - 1 + out.length;
  return { lineasTotales: lines.length, desdeLinea: from, hastaLinea: hasta, contenido: out.join('\n'), hayMas: hasta < lines.length };
}

export class HttpGithubReader {
  #token;
  #fetch;

  constructor({ token, fetchImpl = fetch }) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async #get(path, query = {}, accept = 'application/vnd.github+json') {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    let res;
    try {
      res = await this.#fetch(url, {
        headers: { Authorization: `Bearer ${this.#token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new GithubReadError(`No he podido conectar con GitHub (${err.message}).`);
    }
    if (res.status === 404) throw new GithubReadError('No existe, o el token de lectura no tiene acceso a ese repositorio.');
    if (res.status === 401) throw new GithubReadError('El token de lectura de GitHub no es válido o ha caducado.');
    if (res.status === 403 || res.status === 429) {
      throw new GithubReadError(res.headers?.get?.('x-ratelimit-remaining') === '0' ? 'GitHub ha limitado las consultas; prueba más tarde.' : 'El token de lectura no tiene permiso para esto.');
    }
    if (!res.ok) throw new GithubReadError(`GitHub ha respondido ${res.status}.`);
    return res.json();
  }

  async searchCode({ repo, query, limit = 6 }) {
    checkRepo(repo);
    const data = await this.#get('/search/code', { q: `${query} repo:${repo}`, per_page: limit }, 'application/vnd.github.text-match+json');
    return {
      total: data.total_count ?? 0,
      resultados: (data.items ?? []).slice(0, limit).map((it) => ({
        ruta: it.path,
        fragmentos: (it.text_matches ?? []).slice(0, 2).map((m) => String(m.fragment ?? '').slice(0, 300)),
      })),
    };
  }

  /** Archivo (texto en base64 de la API) o listado de un directorio. */
  async readPath({ repo, path = '', ref }) {
    checkRepo(repo);
    const p = cleanPath(path);
    const data = await this.#get(`/repos/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}`, { ref });
    if (Array.isArray(data)) {
      return { tipo: 'directorio', ruta: p, entradas: data.slice(0, 200).map((e) => ({ nombre: e.name, tipo: e.type === 'dir' ? 'directorio' : 'archivo', bytes: e.type === 'dir' ? undefined : e.size })) };
    }
    if (data.type !== 'file') throw new GithubReadError('Solo se pueden leer archivos y directorios.');
    if (data.encoding !== 'base64' || typeof data.content !== 'string') throw new GithubReadError('El archivo es demasiado grande para leerlo.');
    const text = Buffer.from(data.content, 'base64').toString('utf8');
    if (text.includes('\0')) throw new GithubReadError('Es un archivo binario.');
    return { tipo: 'archivo', ruta: p, texto: text };
  }

  async listCommits({ repo, path, ref, limit = 10 }) {
    checkRepo(repo);
    const data = await this.#get(`/repos/${repo}/commits`, { per_page: limit, sha: ref, path: path ? cleanPath(path) : undefined });
    return data.slice(0, limit).map((c) => ({
      sha: String(c.sha).slice(0, 7),
      fecha: c.commit?.author?.date,
      autor: c.commit?.author?.name,
      mensaje: String(c.commit?.message ?? '').split('\n')[0].slice(0, 160),
    }));
  }

  async listPulls({ repo, state = 'open', limit = 10 }) {
    checkRepo(repo);
    const data = await this.#get(`/repos/${repo}/pulls`, { state, per_page: limit, sort: 'updated', direction: 'desc' });
    return data.slice(0, limit).map((p) => ({
      numero: p.number,
      titulo: String(p.title ?? '').slice(0, 160),
      estado: p.merged_at ? 'fusionado' : p.state === 'open' ? (p.draft ? 'borrador' : 'abierto') : 'cerrado',
      autor: p.user?.login,
      rama: p.head?.ref,
      actualizado: p.updated_at,
    }));
  }

  // ── Seguimiento de agentes (solo lectura): ejecuciones del workflow, PR, checks y diff ──

  /** Ejecuciones recientes del workflow del agente. `titulo` es el run-name ("praxon ticket=.. run=.."). */
  async listWorkflowRuns({ repo, workflowFile = 'praxon-agent.yml', limit = 30 }) {
    checkRepo(repo);
    const data = await this.#get(`/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs`, { event: 'workflow_dispatch', per_page: limit });
    return (data.workflow_runs ?? []).map((r) => ({
      id: String(r.id),
      titulo: String(r.display_title ?? r.name ?? ''),
      estado: r.status, // queued | in_progress | completed
      resultado: r.conclusion ?? null, // success | failure | cancelled | ...
      url: r.html_url,
    }));
  }

  /** PR de una rama (el mas reciente), con lo necesario para decidir y para fusionar. */
  async findPull({ repo, branch }) {
    checkRepo(repo);
    const owner = repo.split('/')[0];
    const list = await this.#get(`/repos/${repo}/pulls`, { head: `${owner}:${branch}`, state: 'all', per_page: 1 });
    if (!list.length) return null;
    return this.getPull({ repo, number: list[0].number });
  }

  async getPull({ repo, number }) {
    checkRepo(repo);
    const p = await this.#get(`/repos/${repo}/pulls/${Number(number)}`);
    return {
      numero: p.number,
      url: p.html_url,
      titulo: String(p.title ?? '').slice(0, 200),
      estado: p.merged ? 'fusionado' : p.state === 'open' ? 'abierto' : 'cerrado',
      rama: p.head?.ref,
      base: p.base?.ref,
      sha: p.head?.sha,
      mergeable: p.mergeable ?? null,
      archivos: p.changed_files ?? 0,
      adiciones: p.additions ?? 0,
      borrados: p.deletions ?? 0,
    };
  }

  /**
   * Resumen de checks de un commit. Los tokens de grano fino no tienen el permiso "Checks", asi que se usan las
   * ejecuciones de Actions de ese commit (permiso Actions) y los estados clasicos (Commit statuses). Si el token si
   * puede leer check runs, se prefieren.
   */
  async checksFor({ repo, sha }) {
    checkRepo(repo);
    const [runs, st, actions] = await Promise.allSettled([
      this.#get(`/repos/${repo}/commits/${sha}/check-runs`, { per_page: 50 }),
      this.#get(`/repos/${repo}/commits/${sha}/status`),
      this.#get(`/repos/${repo}/actions/runs`, { head_sha: sha, per_page: 30 }),
    ]);
    if (runs.status === 'rejected' && st.status === 'rejected' && actions.status === 'rejected') throw actions.reason;
    const items = [];
    if (runs.status === 'fulfilled') {
      for (const c of runs.value.check_runs ?? []) items.push({ nombre: c.name, estado: c.status !== 'completed' ? 'pendiente' : ['success', 'neutral', 'skipped'].includes(c.conclusion) ? 'ok' : 'fallo' });
    } else if (actions.status === 'fulfilled') {
      for (const r of actions.value.workflow_runs ?? []) {
        items.push({ nombre: r.name, estado: r.status !== 'completed' ? 'pendiente' : ['success', 'neutral', 'skipped'].includes(r.conclusion) ? 'ok' : 'fallo' });
      }
    }
    if (st.status === 'fulfilled') {
      for (const c of st.value.statuses ?? []) items.push({ nombre: c.context, estado: c.state === 'success' ? 'ok' : c.state === 'pending' ? 'pendiente' : 'fallo' });
    }
    return {
      total: items.length,
      ok: items.filter((i) => i.estado === 'ok').length,
      fallando: items.filter((i) => i.estado === 'fallo').length,
      pendientes: items.filter((i) => i.estado === 'pendiente').length,
      items: items.slice(0, 20),
    };
  }

  /** Archivos cambiados con su parche, acotados para el movil. */
  async pullFiles({ repo, number, limit = 40, maxPatch = 6000 }) {
    checkRepo(repo);
    const data = await this.#get(`/repos/${repo}/pulls/${Number(number)}/files`, { per_page: limit });
    return data.slice(0, limit).map((f) => ({
      ruta: f.filename,
      estado: f.status,
      adiciones: f.additions,
      borrados: f.deletions,
      parche: f.patch ? String(f.patch).slice(0, maxPatch) : null,
      truncado: Boolean(f.patch && f.patch.length > maxPatch),
    }));
  }
}

/**
 * Repositorios en memoria para desarrollo y tests: `repos` = { 'owner/repo': { files: { 'ruta': 'texto' }, commits: [...], pulls: [...] } }.
 */
export class FakeGithubReader {
  calls = [];
  #repos;

  constructor(repos = {}) {
    this.#repos = repos;
  }

  #repo(repo) {
    checkRepo(repo);
    const r = this.#repos[repo];
    if (!r) throw new GithubReadError('No existe, o el token de lectura no tiene acceso a ese repositorio.');
    return r;
  }

  async searchCode({ repo, query, limit = 6 }) {
    this.calls.push(['searchCode', repo, query]);
    const files = this.#repo(repo).files ?? {};
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const found = Object.entries(files).filter(([ruta, t]) => words.every((w) => `${ruta}\n${t}`.toLowerCase().includes(w)));
    return {
      total: found.length,
      resultados: found.slice(0, limit).map(([ruta, t]) => ({ ruta, fragmentos: [t.split('\n').find((l) => words.some((w) => l.toLowerCase().includes(w)))?.slice(0, 300) ?? ''] })),
    };
  }

  async readPath({ repo, path = '' }) {
    this.calls.push(['readPath', repo, path]);
    const files = this.#repo(repo).files ?? {};
    const p = cleanPath(path);
    if (p in files) return { tipo: 'archivo', ruta: p, texto: files[p] };
    const prefix = p ? `${p}/` : '';
    const names = new Map();
    for (const f of Object.keys(files)) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const [head, ...tail] = rest.split('/');
      names.set(head, tail.length ? 'directorio' : 'archivo');
    }
    if (!names.size) throw new GithubReadError('No existe, o el token de lectura no tiene acceso a ese repositorio.');
    return { tipo: 'directorio', ruta: p, entradas: [...names].map(([nombre, tipo]) => ({ nombre, tipo })) };
  }

  async listCommits({ repo, limit = 10 }) {
    this.calls.push(['listCommits', repo]);
    return (this.#repo(repo).commits ?? []).slice(0, limit);
  }

  async listPulls({ repo, state = 'open', limit = 10 }) {
    this.calls.push(['listPulls', repo, state]);
    return (this.#repo(repo).pulls ?? []).filter((p) => state === 'all' || (state === 'open' ? ['abierto', 'borrador'].includes(p.estado) : !['abierto', 'borrador'].includes(p.estado))).slice(0, limit);
  }

  // Seguimiento de agentes: repos[repo] = { workflowRuns: [...], pullRequests: [{...getPull, files, checks}] }
  async listWorkflowRuns({ repo }) {
    this.calls.push(['listWorkflowRuns', repo]);
    return [...(this.#repo(repo).workflowRuns ?? [])];
  }

  async findPull({ repo, branch }) {
    this.calls.push(['findPull', repo, branch]);
    const p = (this.#repo(repo).pullRequests ?? []).find((x) => x.rama === branch);
    return p ? this.getPull({ repo, number: p.numero }) : null;
  }

  async getPull({ repo, number }) {
    this.calls.push(['getPull', repo, number]);
    const p = (this.#repo(repo).pullRequests ?? []).find((x) => x.numero === Number(number));
    if (!p) throw new GithubReadError('No existe, o el token de lectura no tiene acceso a ese repositorio.');
    const { files, checks, ...rest } = p;
    return { url: `https://github.com/${repo}/pull/${p.numero}`, base: 'main', mergeable: true, archivos: files?.length ?? 0, adiciones: 0, borrados: 0, ...rest };
  }

  async checksFor({ repo, sha }) {
    this.calls.push(['checksFor', repo, sha]);
    const p = (this.#repo(repo).pullRequests ?? []).find((x) => x.sha === sha);
    return p?.checks ?? { total: 0, ok: 0, fallando: 0, pendientes: 0, items: [] };
  }

  async pullFiles({ repo, number }) {
    this.calls.push(['pullFiles', repo, number]);
    return (this.#repo(repo).pullRequests ?? []).find((x) => x.numero === Number(number))?.files ?? [];
  }
}
