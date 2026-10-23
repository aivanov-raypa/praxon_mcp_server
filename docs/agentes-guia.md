# Puesta en marcha de los agentes de desarrollo (runner de GitHub)

## 1. Workflow en el repositorio
Copia `docs/github/praxon-agent.yml` (en praxon_mcp_server) a `.github/workflows/praxon-agent.yml` de `raypa-it/raypa-platform` y súbelo a la rama principal (workflow_dispatch solo funciona si el archivo está en la rama por defecto).

## 2. Ajustes de la organización / repositorio
- Settings › Actions › General › Workflow permissions: **Read and write permissions**.
- Marca **Allow GitHub Actions to create and approve pull requests** (sin esto `gh pr create` falla).
- Repo › Settings › Secrets and variables › Actions › secreto **ANTHROPIC_API_KEY**: crea una clave dedicada en la consola de Anthropic con límite de gasto.
- Comprueba en Billing la cuota de minutos de Actions de repos privados del plan Free.
- Limitación conocida: los PR abiertos con el token del workflow no disparan otros workflows (CI). Si tienes CI, usa un PAT o GitHub App para abrir el PR.

## 3. Tokens de Praxon
- `GITHUB_TOKEN` (ya existe): Actions en escritura, para lanzar y cancelar el workflow.
- `GITHUB_READ_TOKEN`: añade a Contents/Pull requests/Metadata (lectura) los permisos **Actions: read**, **Checks: read** y **Commit statuses: read**.
- `GITHUB_MERGE_TOKEN` (nuevo, grano fino, solo el repo): **Pull requests: write** y **Contents: write**. Sin él se revisa el diff pero no se puede fusionar.

## 4. Variables del servidor Praxon
`GITHUB_MODE=http`, `GITHUB_TOKEN`, `GITHUB_READ_TOKEN`, `GITHUB_MERGE_TOKEN`. Opcionales: `AGENTS_WATCH_SECONDS` (60), `AGENTS_QUEUE_TIMEOUT_MINUTES` (10), `GITHUB_MERGE_METHOD` (squash).

## 5. Backend de MyRAYPA
Despliega el nuevo endpoint `GET /assistant/agent-runs/lista`. El proyecto debe tener autonomía `agentes` y repositorio.

## 6. Android
Se ha añadido la dependencia `androidx.biometric:biometric:1.1.0`: sincroniza Gradle y compila.

## 7. Prueba
1. Pide a Praxon "lanza un agente en el ticket N" (confirma).
2. En Actions aparece la ejecución "praxon ticket=… run=…". Al terminar se abre el PR `praxon/ticket-<id>-<run>`.
3. En la pantalla Agentes: Revisar diff → Aprobar y fusionar → teclear el número del PR → huella/PIN.

## Seguridad
El agente solo edita archivos; commit, push y PR los hace el workflow, que además descarta cualquier cambio en `.github/`. La fusión va atada al SHA revisado, exige checks en verde, queda auditada y no existe como herramienta del modelo (nunca por voz). Un ticket malicioso solo puede producir un PR que tú revisas.

## Si algo falla
- Agente "fallido: GitHub no ha iniciado el agente": falta el workflow en la rama por defecto o el token no tiene Actions write.
- "Necesita más información": el agente terminó sin PR; mira el log de la ejecución.
- Las expresiones de `claude-code-action@v1` (`prompt`, `claude_args`, `anthropic_api_key`) están escritas de memoria; compruébalas con la documentación actual de la acción.
