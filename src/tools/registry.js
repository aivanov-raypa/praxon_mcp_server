import { z } from 'zod';

/**
 * Registro unico de herramientas. Es la unica puerta entre el modelo y los sistemas de RAYPA.
 *
 * Niveles de riesgo permitidos por voz:
 *   read  -> se ejecuta siempre.
 *   write -> modifica datos reales: exige summarize() y confirmacion explicita del usuario.
 *   local -> solo toca datos propios de Praxon (recordatorios, deshacer): se ejecuta sin confirmar y queda auditado.
 *         Nunca se ofrece a la revision automatica (solo ve herramientas read de MyRAYPA y GitHub).
 * Lo irreversible o critico (mergear, desplegar, borrar, produccion) NO se puede registrar:
 * solo se hace desde la mesa.
 */
export const RISKS = ['read', 'write', 'local'];

/** Crea una herramienta con el nombre prefijado por su conector: myraypa_listar_tickets. */
export function defineTool({ connector, name, ...rest }) {
  return { name: `${connector}_${name}`, connector, ...rest };
}

export class ToolRegistry {
  #tools = new Map();
  #control = null;

  /** Control de herramientas desactivadas (ver tools/control.js). */
  setControl(control) {
    this.#control = control;
    return this;
  }

  isDisabled(name) {
    return Boolean(this.#control?.isDisabled(name));
  }

  register(tool) {
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(tool.name ?? '')) throw new Error(`Nombre de herramienta no valido: ${tool.name}`);
    if (this.#tools.has(tool.name)) throw new Error(`Herramienta duplicada: ${tool.name}`);
    if (!RISKS.includes(tool.risk)) {
      throw new Error(`${tool.name}: riesgo "${tool.risk}" no permitido por voz (solo ${RISKS.join(' o ')}).`);
    }
    if (typeof tool.description !== 'string' || !tool.description) throw new Error(`${tool.name}: falta la descripcion`);
    if (!(tool.input instanceof z.ZodObject)) throw new Error(`${tool.name}: input debe ser un z.object`);
    if (typeof tool.execute !== 'function') throw new Error(`${tool.name}: falta execute`);
    if (tool.risk === 'write' && typeof tool.summarize !== 'function') {
      throw new Error(`${tool.name}: una herramienta de escritura necesita summarize() para la confirmacion`);
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  /** Registra todas las herramientas de un conector: { name, tools: [...] }. */
  registerConnector(connector) {
    for (const tool of connector.tools) this.register(tool);
    return this;
  }

  get(name) {
    return this.#tools.get(name);
  }

  list() {
    return [...this.#tools.values()];
  }

  /** Definiciones en el formato de herramientas de la API del modelo. `filter` limita cuales se ofrecen. */
  forModel(filter = () => true) {
    return this.list().filter((t) => !this.isDisabled(t.name)).filter(filter).map((t) => {
      const { $schema, ...input_schema } = z.toJSONSchema(t.input);
      return { name: t.name, description: t.description, input_schema };
    });
  }
}
