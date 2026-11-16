/**
 * dsh-ps51-guard - scaffolding entry point.
 *
 * The plugin body is not implemented yet. This file only keeps the Cordis entry
 * contract (a named apply hook) so the repository manifest, bundle patch, CI
 * wiring and packaging checks can be exercised before M1. Behaviour, decisions
 * and acceptance criteria live in ROADMAP.md.
 */

/** Cordis plugin id; must stay identical to the package name. */
export const name = 'dsh-ps51-guard';

/**
 * Cordis apply hook. Intentionally a no-op until M1 lands the shim, lexer and
 * PowerShell 5.1 client.
 *
 * @param {unknown} ctx Cordis context provided by the host.
 * @returns {void}
 */
export function apply(ctx) {
  void ctx;
}
