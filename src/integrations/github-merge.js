/**
 * Fusion de pull requests. Es la unica llamada de escritura sobre el codigo y usa un token PROPIO
 * (GITHUB_MERGE_TOKEN, grano fino: Pull requests y Contents en escritura), distinto del de lectura y del que lanza agentes.
 * La fusion va atada al SHA que el usuario ha visto: si la rama cambia despues, GitHub rechaza con 409.
 */
export class GithubMergeError extends Error {}

const REPO = /^[\w.-]+\/[\w.-]+$/;

export class HttpGithubMerger {
  #token;
  #fetch;
  #method;

  constructor({ token, method = 'squash', fetchImpl = fetch }) {
    this.#token = token;
    this.#method = method;
    this.#fetch = fetchImpl;
  }

  async #baseOf(repo, number) {
    let res;
    try {
      res = await this.#fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
        headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new GithubMergeError(`No he podido conectar con GitHub (${err.message}).`);
    }
    if (!res.ok) throw new GithubMergeError(`No he podido comprobar la rama destino (GitHub ha respondido ${res.status}). No se fusiona.`);
    const data = await res.json().catch(() => ({}));
    return data?.base?.ref ?? null;
  }

  async mergePull({ repo, number, sha, titulo, allowedBases }) {
    if (!REPO.test(repo ?? '') || !Number.isInteger(number) || !/^[0-9a-f]{40}$/.test(sha ?? '')) {
      throw new GithubMergeError('Datos de fusión no válidos.');
    }
    // Última barrera: la rama destino se vuelve a leer justo antes de fusionar (alguien pudo cambiarla tras la revisión).
    if (Array.isArray(allowedBases) && !allowedBases.includes('*')) {
      const base = await this.#baseOf(repo, number);
      if (!allowedBases.includes(base)) throw new GithubMergeError(baseNoPermitida(base, allowedBases));
    }
    let res;
    try {
      res = await this.#fetch(`https://api.github.com/repos/${repo}/pulls/${number}/merge`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha, merge_method: this.#method, commit_title: titulo ? String(titulo).slice(0, 200) : undefined }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new GithubMergeError(`No he podido conectar con GitHub (${err.message}).`);
    }
    if (res.status === 409) throw new GithubMergeError('La rama ha cambiado desde que la revisaste. Vuelve a revisar el diff.');
    if (res.status === 405) throw new GithubMergeError('GitHub no permite fusionar ahora (conflictos o reglas de la rama).');
    if (res.status === 401 || res.status === 403 || res.status === 404) throw new GithubMergeError('El token de fusión no es válido o no tiene permiso en este repositorio.');
    if (!res.ok) throw new GithubMergeError(`GitHub ha respondido ${res.status} al fusionar.`);
    const data = await res.json().catch(() => ({}));
    return { fusionado: data.merged !== false, sha: data.sha ?? null };
  }
}

export const baseNoPermitida = (base, permitidas) =>
  `El pull request apunta a «${base ?? 'desconocida'}» y Praxon solo fusiona en: ${permitidas.join(', ')}. Cámbialo a una de esas ramas o fusiónalo tú en GitHub.`;

export class FakeGithubMerger {
  merged = [];
  failNext = null;
  /** Rama destino "real" en el momento de fusionar (para probar la comprobación final). Null = no se comprueba. */
  base = null;

  async mergePull(args) {
    if (this.base !== null && Array.isArray(args.allowedBases) && !args.allowedBases.includes('*') && !args.allowedBases.includes(this.base)) {
      throw new GithubMergeError(baseNoPermitida(this.base, args.allowedBases));
    }
    if (this.failNext) {
      const m = this.failNext;
      this.failNext = null;
      throw new GithubMergeError(m);
    }
    this.merged.push(args);
    return { fusionado: true, sha: 'f'.repeat(40) };
  }
}
