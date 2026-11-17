/**
 * subprocess.spawn bridge.
 *
 * BASH_ENV is process-global, so another plugin can overwrite it after this
 * plugin's apply(). The bridge wraps the host subprocess service and injects
 * the shim at spawn time, where the final environment is already known. It is
 * deliberately a transparent wrapper: every non-target spawn keeps its exact
 * arguments, and a failure in the bridge falls back to the original spec.
 */

import { withGuardEnv } from './bash-env.js';

/**
 * @typedef {object} SubprocessBridgeOptions
 * @property {string} shimPath
 * @property {string} runtime
 * @property {Record<string, string | undefined>} [baseEnv] inherited environment for spawns that omit env
 * @property {(message: string) => void} [warn]
 */

/**
 * Install the bridge through Cordis service injection. The plugin itself does
 * not declare a hard inject dependency, so an environment without the
 * subprocess service still gets the BASH_ENV-only behavior.
 *
 * @param {object} ctx Cordis context
 * @param {SubprocessBridgeOptions} options
 * @returns {boolean} true when an injection was registered
 */
export function installSubprocessBridge(ctx, options) {
	if (typeof ctx?.inject !== 'function') return false;
	const warn = (message) => {
		try {
			options.warn?.(message);
		} catch {
			// logging is best effort
		}
	};
	try {
		ctx.inject(['subprocess'], (scope) => {
			const candidate = typeof scope?.get === 'function' ? scope.get('subprocess') : undefined;
			const service = candidate ?? scope?.subprocess ?? (typeof scope?.spawn === 'function' ? scope : undefined);
			if (!service || typeof service.spawn !== 'function') return;
			if (service.__ps51GuardSubprocessBridged) return;
			if (!Object.isExtensible(service)) {
				warn('subprocess service is frozen; the BASH_ENV spawn injection is inactive');
				return;
			}
			const spawn = service.spawn;
			let active = true;
			const bridgedSpawn = function bridgedSpawn(spec, ...rest) {
				let next = spec;
				if (active) {
					try {
						next = withGuardEnv(spec, {
							shimPath: options.shimPath,
							runtime: options.runtime,
							ambientBashEnv: process.env.BASH_ENV,
							ambientPrevBashEnv: process.env.PS51_PREV_BASH_ENV,
							baseEnv: process.env,
							warn,
						});
					} catch (error) {
						warn('BASH_ENV spawn injection failed; using the original spec: ' + error.message);
						next = spec;
					}
				}
				return spawn.apply(this, [next, ...rest]);
			};
			try {
				service.spawn = bridgedSpawn;
			} catch (error) {
				warn('cannot replace subprocess.spawn; the BASH_ENV spawn injection is inactive: ' + error.message);
				return;
			}
			try {
				Object.defineProperty(service, '__ps51GuardSubprocessBridged', { value: true, configurable: true });
			} catch (error) {
				try {
					service.spawn = spawn;
				} catch {
					// already restored or not writable
				}
				warn('subprocess service cannot carry the bridge marker; the BASH_ENV spawn injection is inactive: ' + error.message);
				return;
			}
			const restore = () => {
				// Even when a later wrapper is on top, the old wrapper stays in the
				// chain; the active flag makes it transparent after disposal.
				active = false;
				try {
					if (service.spawn === bridgedSpawn) service.spawn = spawn;
					delete service.__ps51GuardSubprocessBridged;
				} catch (error) {
					warn('failed to restore subprocess.spawn: ' + error.message);
				}
			};
			try {
				if (typeof scope.effect === 'function') scope.effect(() => restore);
				else if (typeof scope.on === 'function') scope.on('dispose', restore);
				else {
					restore();
					warn('subprocess scope exposes no cleanup hook; the BASH_ENV spawn injection was rolled back');
				}
			} catch (error) {
				restore();
				warn('failed to register the subprocess bridge cleanup: ' + error.message);
			}
		});
		return true;
	} catch (error) {
		warn('subprocess bridge injection is unavailable: ' + error.message);
		return false;
	}
}
